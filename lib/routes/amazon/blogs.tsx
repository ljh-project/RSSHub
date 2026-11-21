import type { Cheerio, CheerioAPI } from 'cheerio';
import { load } from 'cheerio';
import type { Element } from 'domhandler';
import type { Context } from 'hono';
import { renderToString } from 'hono/jsx/dom/server';
import pMap from 'p-map';
import type { Item as RssItem } from 'rss-parser';

import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Data, DataItem, Route } from '@/types';
import { ViewType } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { getRouteLimit } from '@/utils/route-limit';
import parser from '@/utils/rss-parser';
import { parseDate } from '@/utils/time';

const BLOG_BASE_URL = 'https://aws.amazon.com/blogs';
const DEFAULT_CATEGORY = 'aws';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DETAIL_CONCURRENCY = 5;
const CATEGORY_RE = /^[a-z0-9-]+$/;
const AUTHOR_HEADING_RE = /^about the authors?:?$/i;
const SAFE_HTTP_PROTOCOLS = new Set(['http:', 'https:']);

interface CleanedContent {
    description: string;
    bodyImage?: string;
    boxAuthors: string[];
}

interface ArticlePageMeta {
    image?: string;
    authors: string[];
}

interface ParsedFeedEntry {
    title: string;
    link: string;
    guid: string;
    pubDate?: Temporal.Instant;
    creator?: string;
    category?: string[];
    description: string;
    bodyImage?: string;
    boxAuthors: string[];
}

const resolveHttpUrl = (rawUrl: string | undefined, baseUrl: string): string | undefined => {
    const trimmed = rawUrl?.trim();
    if (!trimmed) {
        return undefined;
    }
    const parsed = URL.parse(trimmed, baseUrl);
    return parsed && SAFE_HTTP_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
};

const extractCategories = (rawCategories: string[] | undefined): string[] | undefined => {
    const unique = [...new Set((rawCategories ?? []).map((tag) => tag.trim()).filter(Boolean))];
    return unique.length > 0 ? unique : undefined;
};

const extractBoxAuthors = ($: CheerioAPI): string[] => {
    const authors: string[] = [];
    for (const el of $('.blog-author-box').toArray()) {
        const name = $(el).find('h2, h3, h4, h5').first().text().trim();
        if (name) {
            authors.push(name);
        }
    }
    return authors;
};

const removePrecedingAuthorChrome = ($footer: Cheerio<Element>): void => {
    let $prev = $footer.prev();
    while ($prev.length && ($prev.is('hr') || ($prev.is('h1, h2, h3, h4, h5, h6, p') && AUTHOR_HEADING_RE.test($prev.text().trim())))) {
        const $toRemove = $prev;
        $prev = $prev.prev();
        $toRemove.remove();
    }
};

const removeAuthorFooter = ($: CheerioAPI): void => {
    const authorFooters = $('footer')
        .filter((_, el) => $(el).find('.blog-author-box').length > 0)
        .toArray();
    for (const footer of authorFooters) {
        const $footer = $(footer);
        removePrecedingAuthorChrome($footer);
        $footer.remove();
    }
    $('.blog-author-box').remove();
};

const pickFirstImage = ($: CheerioAPI, baseUrl: string): string | undefined => {
    for (const el of $('img').toArray()) {
        const resolved = resolveHttpUrl($(el).attr('src'), baseUrl);
        if (resolved) {
            return resolved;
        }
    }
    return undefined;
};

const cleanRssContent = (rawItem: RssItem, link: string): CleanedContent => {
    const contentHtml = (rawItem['content:encoded'] ?? rawItem.content)?.trim();
    if (!contentHtml) {
        const summary = rawItem.contentSnippet?.trim() ?? '';
        return {
            description: summary ? renderToString(<p>{summary}</p>) : '',
            boxAuthors: [],
        };
    }

    const $ = load(contentHtml, null, false);
    const boxAuthors = extractBoxAuthors($);
    removeAuthorFooter($);
    $('div.wp-caption[style]').removeAttr('style');

    return {
        description: $.html().trim(),
        bodyImage: pickFirstImage($, link),
        boxAuthors,
    };
};

const mergeAuthors = (orderedCandidates: ReadonlyArray<string | undefined>): DataItem['author'] => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const candidate of orderedCandidates) {
        const name = candidate?.trim();
        if (!name) {
            continue;
        }
        const key = name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        names.push(name);
    }
    return names.length > 0 ? names.map((name) => ({ name })) : undefined;
};

const toParsedFeedEntry = (rawItem: RssItem, blogUrl: string): ParsedFeedEntry | undefined => {
    const link = resolveHttpUrl(rawItem.link, blogUrl);
    if (!link || !rawItem.title) {
        return undefined;
    }

    const cleaned = cleanRssContent(rawItem, link);
    const rawDate = rawItem.isoDate ?? rawItem.pubDate;

    return {
        title: rawItem.title,
        link,
        guid: rawItem.guid?.trim() || link,
        pubDate: rawDate ? parseDate(rawDate) : undefined,
        creator: rawItem.creator,
        category: extractCategories(rawItem.categories),
        description: cleaned.description,
        bodyImage: cleaned.bodyImage,
        boxAuthors: cleaned.boxAuthors,
    };
};

const parseFeedEntries = (rawItems: RssItem[], blogUrl: string, limit: number): ParsedFeedEntry[] => {
    const seenLinks = new Set<string>();
    const entries: ParsedFeedEntry[] = [];

    for (const rawItem of rawItems) {
        const entry = toParsedFeedEntry(rawItem, blogUrl);
        if (!entry || seenLinks.has(entry.link)) {
            continue;
        }
        seenLinks.add(entry.link);
        entries.push(entry);
        if (entries.length >= limit) {
            break;
        }
    }

    return entries;
};

const fetchArticlePageMeta = async (link: string): Promise<ArticlePageMeta> => {
    try {
        return await cache.tryGet<ArticlePageMeta>(`amazon:blogs:meta:${link}`, async () => {
            const html = await ofetch(link, { responseType: 'text' });
            const $ = load(html);
            const ogImage = $('meta[property="og:image"]').attr('content') ?? $('meta[name="twitter:image"]').attr('content');
            const authors = $('[property="author"] [property="name"]')
                .toArray()
                .map((el) => $(el).text().trim())
                .filter(Boolean);
            return {
                image: resolveHttpUrl(ogImage, link),
                authors: authors.length > 0 ? authors : extractBoxAuthors($),
            };
        });
    } catch {
        return { authors: [] };
    }
};

const enrichFeedEntry = async (entry: ParsedFeedEntry): Promise<DataItem> => {
    const pageMeta = entry.bodyImage ? undefined : await fetchArticlePageMeta(entry.link);
    const orderedAuthors = entry.boxAuthors.length > 0 ? [...entry.boxAuthors, entry.creator] : [...(pageMeta?.authors ?? []), entry.creator];

    return {
        title: entry.title,
        link: entry.link,
        description: entry.description,
        pubDate: entry.pubDate,
        author: mergeAuthors(orderedAuthors),
        category: entry.category,
        guid: entry.guid,
        image: entry.bodyImage ?? pageMeta?.image,
    };
};

async function handler(ctx: Context): Promise<Data> {
    const category = ctx.req.param('category') ?? DEFAULT_CATEGORY;
    if (!CATEGORY_RE.test(category)) {
        throw new InvalidParameterError('Invalid blog category');
    }

    const limit = Math.min(getRouteLimit(ctx, DEFAULT_LIMIT), MAX_LIMIT);
    const blogUrl = `${BLOG_BASE_URL}/${category}/`;
    const feedUrl = `${blogUrl}feed/`;
    const rssXml = await ofetch(feedUrl, { responseType: 'text' });
    const feed = await parser.parseString(rssXml);
    const entries = parseFeedEntries(feed.items, blogUrl, limit);
    const items = await pMap(entries, enrichFeedEntry, { concurrency: DETAIL_CONCURRENCY });

    return {
        title: feed.title || `AWS ${category} Blog`,
        description: feed.description || 'Official AWS Blog',
        link: blogUrl,
        language: feed.language || 'en-us',
        item: items,
    };
}

export const route: Route = {
    path: '/blogs/:category?',
    name: 'AWS Blog',
    url: 'aws.amazon.com/blogs',
    example: '/amazon/blogs/machine-learning',
    categories: ['blog'],
    view: ViewType.Articles,
    maintainers: ['ljh12138164'],
    parameters: {
        category: {
            description: 'Blog category slug from the URL path (e.g. `aws`, `machine-learning`, `compute`, `security`, `architecture`, `containers`, `devops`, `database`)',
            default: DEFAULT_CATEGORY,
        },
    },
    description:
        'Full-text articles from a specific AWS Blog category via `aws.amazon.com/blogs/<category>/feed/`, stripping the WordPress author bio footer, merging co-authors, and resolving article `og:image` covers when posts have no body images.',
    zh: {
        name: 'AWS 博客',
        parameters: {
            category: {
                description: 'AWS 博客分类路径标识（如 `aws`、`machine-learning`、`compute`、`security`、`architecture`、`containers`、`devops`、`database`）',
                default: DEFAULT_CATEGORY,
            },
        },
        description: '通过 `aws.amazon.com/blogs/<category>/feed/` 获取指定 AWS 博客分类全文，清理文末作者简介页脚、补全合著作者，并在正文无配图时抓取页面 `og:image` 作为封面，默认对应 `aws` 分类。',
    },
    radar: [
        {
            source: ['aws.amazon.com/blogs', 'aws.amazon.com/blogs/:category', 'aws.amazon.com/blogs/:category/feed', 'aws.amazon.com/blogs/:category/:slug'],
            target: '/blogs/:category?',
        },
    ],
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    handler,
};

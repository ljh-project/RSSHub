import { load } from 'cheerio';
import type { Context } from 'hono';
import type { Item as RssItem } from 'rss-parser';

import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Data, DataItem, Route } from '@/types';
import { ViewType } from '@/types';
import ofetch from '@/utils/ofetch';
import { getRouteLimit } from '@/utils/route-limit';
import parser from '@/utils/rss-parser';
import { parseDate } from '@/utils/time';

import { renderFallbackDescription } from './templates/description';

const BLOG_BASE_URL = 'https://aws.amazon.com/blogs';
const DEFAULT_CATEGORY = 'aws';
const DEFAULT_LIMIT = 20;
const CATEGORY_RE = /^[a-z0-9-]+$/;
const SAFE_HTTP_PROTOCOLS = new Set(['http:', 'https:']);

const resolveHttpUrl = (rawUrl: string | undefined, baseUrl: string): string | undefined => {
    const trimmed = rawUrl?.trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        const parsed = new URL(trimmed, baseUrl);
        return SAFE_HTTP_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
    } catch {
        return undefined;
    }
};

const extractFirstImageUrl = (html: string, baseUrl: string): string | undefined => {
    if (!html) {
        return undefined;
    }
    const $ = load(html, null, false);
    for (const el of $('img').toArray()) {
        const resolved = resolveHttpUrl($(el).attr('src'), baseUrl);
        if (resolved) {
            return resolved;
        }
    }
    return undefined;
};

const extractCategories = (rawCategories: string[] | undefined): string[] | undefined => {
    const unique = [...new Set((rawCategories ?? []).map((tag) => tag.trim()).filter(Boolean))];
    return unique.length > 0 ? unique : undefined;
};

const extractAuthor = (creator: string | undefined): string | undefined => creator?.trim() || undefined;

const extractItemDescription = (rawItem: RssItem): string => {
    const contentHtml = (rawItem['content:encoded'] ?? rawItem.content)?.trim();
    if (contentHtml) {
        return contentHtml;
    }
    const summary = rawItem.contentSnippet?.trim() ?? '';
    return renderFallbackDescription(summary);
};

const toDataItem = (rawItem: RssItem, blogUrl: string): DataItem | undefined => {
    const link = resolveHttpUrl(rawItem.link, blogUrl);
    if (!link || !rawItem.title) {
        return undefined;
    }
    const description = extractItemDescription(rawItem);
    const rawDate = rawItem.isoDate ?? rawItem.pubDate;

    return {
        title: rawItem.title,
        link,
        description,
        pubDate: rawDate ? parseDate(rawDate) : undefined,
        author: extractAuthor(rawItem.creator),
        category: extractCategories(rawItem.categories),
        guid: rawItem.guid?.trim() || link,
        image: extractFirstImageUrl(description, link),
    };
};

const mapDataItems = (rawItems: RssItem[], blogUrl: string, limit: number): DataItem[] => {
    const seenLinks = new Set<string>();
    const items: DataItem[] = [];

    for (const rawItem of rawItems) {
        const item = toDataItem(rawItem, blogUrl);
        if (!item?.link || seenLinks.has(item.link)) {
            continue;
        }
        seenLinks.add(item.link);
        items.push(item);
        if (items.length >= limit) {
            break;
        }
    }

    return items;
};

async function handler(ctx: Context): Promise<Data> {
    const category = ctx.req.param('category') ?? DEFAULT_CATEGORY;
    if (!CATEGORY_RE.test(category)) {
        throw new InvalidParameterError('Invalid blog category');
    }

    const limit = getRouteLimit(ctx, DEFAULT_LIMIT);
    const blogUrl = `${BLOG_BASE_URL}/${category}/`;
    const feedUrl = `${blogUrl}feed/`;
    const rssXml = await ofetch(feedUrl, { responseType: 'text' });
    const feed = await parser.parseString(rssXml);

    return {
        title: feed.title || `AWS ${category} Blog`,
        description: feed.description || 'Official AWS Blog',
        link: blogUrl,
        language: feed.language || 'en-us',
        item: mapDataItems(feed.items, blogUrl, limit),
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
            description: 'Blog category slug from the URL path (e.g. `aws`, `machine-learning`, `compute`, `security`)',
            default: DEFAULT_CATEGORY,
        },
    },
    description: 'Full-text articles from a specific AWS Blog category via its official category RSS feed (`aws.amazon.com/blogs/<category>/feed/`). Defaults to `aws`; supports the common `limit` parameter.',
    zh: {
        name: 'AWS 博客',
        parameters: {
            category: {
                description: 'AWS 博客分类路径标识（如 `aws`、`machine-learning`、`compute`、`security`）',
                default: DEFAULT_CATEGORY,
            },
        },
        description: '通过官方分类 RSS（`aws.amazon.com/blogs/<category>/feed/`）获取指定 AWS 博客分类全文，默认对应 `aws` 分类，支持通用 `limit` 参数。',
    },
    radar: [
        {
            source: ['aws.amazon.com/blogs/:category', 'aws.amazon.com/blogs/:category/feed', 'aws.amazon.com/blogs/:category/:slug'],
            target: '/blogs/:category',
        },
    ],
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
        supportRadar: true,
    },
    handler,
};

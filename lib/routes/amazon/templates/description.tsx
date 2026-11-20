import { renderToString } from 'hono/jsx/dom/server';

export const renderFallbackDescription = (summary: string) => (summary ? renderToString(<p>{summary}</p>) : '');

/**
 * sitemap.mjs — Dynamically generates /sitemap.xml on every request.
 *
 * Renewonomics is mostly login-gated (see robots.txt), so the sitemap is
 * deliberately short: the two genuinely public static pages, plus one entry
 * per published Impact post at /impact/<slug> — the one content type built
 * for public/crawler access (see impact-post.mjs, which serves real
 * per-post Open Graph tags to bots at that same URL).
 *
 * Draft posts (published: false) are excluded automatically since
 * getImpactPosts(true) already filters them out — same call the public
 * /api/impact/posts endpoint uses, so this always matches what's live.
 */

import { getImpactPosts } from './lib/store.mjs';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** yyyy-mm-dd, which is what <lastmod> expects — full timestamps are valid
 *  per the sitemap spec too, but the date-only form is the common convention
 *  and avoids implying a precision (time-of-day) that isn't meaningful here. */
function isoDateOnly(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function buildSitemap(posts, origin) {
  const staticUrls = [
    { loc: `${origin}/products.html`, changefreq: 'weekly',  priority: '0.8' },
    { loc: `${origin}/privacy.html`,  changefreq: 'monthly', priority: '0.3' },
  ];

  // loc is built RAW here — escaping happens exactly once, at final render
  // below. Escaping twice would double-encode (e.g. "&" -> "&amp;amp;").
  const postUrls = (posts || [])
    .filter(p => p.published !== false && p.slug)
    .map(p => ({
      loc: `${origin}/impact/${p.slug}`,
      lastmod: isoDateOnly(p.updatedAt || p.pubDate),
      changefreq: 'monthly',
      priority: '0.6',
    }));

  const all = [...staticUrls, ...postUrls];
  const body = all.map(u => `  <url>
    <loc>${esc(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export default async (request) => {
  const origin = new URL(request.url).origin;

  let posts = [];
  try {
    posts = await getImpactPosts(true); // publicOnly — drafts excluded
  } catch {
    // Store hiccup — fall back to just the two static URLs rather than
    // failing the whole sitemap (and therefore the whole crawl signal).
    posts = [];
  }

  const xml = buildSitemap(posts, origin);

  return new Response(xml, {
    status: 200,
    headers: {
      'content-type':  'application/xml; charset=utf-8',
      // Sitemaps don't need to be as fresh as social-share previews — most
      // crawlers re-fetch on their own schedule (often daily), so an hour
      // of caching cuts function invocations without meaningfully delaying
      // discovery of a newly published post.
      'cache-control': 'public, max-age=3600, s-maxage=3600',
    },
  });
};

/**
 * impact-post.mjs — Server-side rendered share previews for Impact blog posts.
 *
 * Routing:
 *   /impact/<slug>  →  this function
 *
 * Behaviour:
 *   • If the requester is a known crawler (LinkedIn, Facebook, Twitter, Slack,
 *     Discord, WhatsApp, etc.), we return a minimal HTML document with the
 *     post-specific Open Graph and Twitter Card meta tags. Crawlers don't
 *     execute JS, so this is the only way to give them a custom preview per
 *     post. The HTML body is intentionally small — they never render it.
 *
 *   • Real human visitors get a 302 redirect to /impact.html?post=<slug>,
 *     where the existing JS-driven detail page renders normally. This avoids
 *     paying a function invocation on every page view.
 *
 * Why split bots and humans?
 *   The canonical alternative is to send everyone through the function and
 *   serve the same SSR'd HTML. That works but adds a few hundred ms of
 *   cold-start latency to every visit and uses Netlify function invocations
 *   for traffic that doesn't need them. Bot-splitting keeps human UX fast
 *   while still solving the LinkedIn/Facebook preview problem.
 *
 * If a slug is unknown or the post is unpublished, we still return a graceful
 *  fallback page with default Renewonomics branding rather than a 404 — that
 *  way a stale shared link doesn't show "Page not found" in someone's feed.
 */

import { getImpactPostBySlug } from './lib/store.mjs';

// User-agent substrings for bots that fetch URLs to generate previews.
// Lowercased, matched as substring. Order doesn't matter; we OR-match.
const CRAWLER_PATTERNS = [
  // Big four
  'linkedinbot',         // LinkedIn
  'facebookexternalhit', // Facebook (also used by Instagram, WhatsApp)
  'facebookcatalog',     // Facebook commerce (rare but real)
  'twitterbot',          // X/Twitter
  // Chat / messaging previewers
  'slackbot',            // Slack
  'discordbot',          // Discord
  'whatsapp',            // WhatsApp
  'telegrambot',         // Telegram
  'skypeuripreview',     // Skype
  // Search/aggregator bots that benefit from rich tags
  'embedly',
  'pinterest',
  'redditbot',
  'tumblr',
  'bingpreview',
  'googlebot',
  'applebot',
  // Generic preview-fetching libs
  'preview',
  'metadata',
];

/** Transform an image URL for social sharing.
 *  LinkedIn, Facebook require at least ~1200×630px. For Cloudinary URLs we
 *  can request an exact 1200×630 padded version on the fly; the pad colour
 *  matches the Renewonomics dark background so logo images look intentional
 *  rather than floating on white. Non-Cloudinary URLs are returned unchanged.
 */
function socialImage(img, origin) {
  if (!img) return `${origin}/og-image.png`;
  if (img.includes('res.cloudinary.com/') && img.includes('/image/upload/')) {
    // Prepend transforms — Cloudinary applies them left-to-right so these run
    // before any existing transforms already in the URL. c_pad crops nothing;
    // b_rgb sets the padding colour; w_1200,h_630 is the minimum social size.
    return img.replace(
      '/image/upload/',
      '/image/upload/f_auto,q_auto,w_1200,h_630,c_pad,b_rgb:111a14/'
    );
  }
  return img;
}

function isCrawler(userAgent = '') {
  const ua = userAgent.toLowerCase();
  return CRAWLER_PATTERNS.some(p => ua.includes(p));
}

/** HTML-escape attribute or text content. Keep this conservative — it's the
 *  only escaping between the post data and the rendered <meta> tags. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Trim a long string to N chars, ending on a word boundary, with ellipsis. */
function snip(s, max) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
}

/** Build the SSR HTML doc returned to crawlers. Body content is minimal —
 *  crawlers don't render the body, just parse <head>.
 *
 *  Two different URLs are involved, and conflating them was the actual bug
 *  behind a real incident (2026-07-27): Facebook's crawler follows
 *  <meta http-equiv="refresh"> tags as if they were a real redirect, then
 *  reads og:url from wherever THAT lands. If og:url/canonical here point at
 *  humanUrl (/impact.html?post=<slug> — a client-JS-rendered page with only
 *  generic static <head> tags, since crawlers never execute the JS that
 *  fills in the real per-post tags there), a crawler that follows the
 *  refresh ends up reading the WRONG, generic tags and discards everything
 *  correct that was already served on this response.
 *
 *  Fix: og:url/canonical here always point at canonicalUrl — the stable
 *  /impact/<slug> URL that this very function serves correctly on every
 *  fetch — so even a crawler that re-normalizes around "canonical" lands
 *  back on a URL guaranteed to return correct data. The meta-refresh tag
 *  is removed entirely (that was the mechanism being followed off this
 *  page); a plain JS redirect + noscript link still send a stray real
 *  human on to the rich page (humanUrl), since crawlers never execute
 *  <script> or click links when scraping for a preview card. */
function renderCrawlerHtml({ title, description, canonicalUrl, humanUrl, image, publishedAt, author, category }) {
  const safeTitle = esc(title);
  const safeDesc  = esc(description);
  const safeCanon = esc(canonicalUrl);
  const safeImg   = esc(image);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>${safeTitle}</title>
<meta name="description" content="${safeDesc}">

<!-- Open Graph (LinkedIn, Facebook, WhatsApp, etc.) -->
<meta property="og:type"        content="article">
<meta property="og:site_name"   content="Renewonomics">
<meta property="og:title"       content="${safeTitle}">
<meta property="og:description" content="${safeDesc}">
<meta property="og:url"         content="${safeCanon}">
<meta property="og:image"        content="${safeImg}">
<meta property="og:image:alt"   content="${safeTitle}">
<meta property="og:image:width"  content="1200">
<meta property="og:image:height" content="630">
${publishedAt ? `<meta property="article:published_time" content="${esc(publishedAt)}">` : ''}
${author      ? `<meta property="article:author"           content="${esc(author)}">`      : ''}
${category    ? `<meta property="article:section"          content="${esc(category)}">`    : ''}

<!-- Twitter Card -->
<meta name="twitter:card"        content="summary_large_image">
<meta name="twitter:site"        content="@renewonomics">
<meta name="twitter:title"       content="${safeTitle}">
<meta name="twitter:description" content="${safeDesc}">
<meta name="twitter:image"       content="${safeImg}">

<!-- Canonical points at THIS url (not the human page) — see function
     comment above for why that matters. -->
<link rel="canonical" href="${safeCanon}">
</head>
<body>
<!-- For a stray real human landing here directly: send them to the rich
     page. Crawlers scraping for a preview card never execute <script> or
     follow links, so this is invisible to them — unlike the meta-refresh
     tag that used to be here, which crawlers DO follow. -->
<noscript><p>Read this article at <a href="${esc(humanUrl)}">${esc(humanUrl)}</a>.</p></noscript>
<script>window.location.replace(${JSON.stringify(humanUrl)});</script>
</body>
</html>`;
}

export default async (request) => {
  const url      = new URL(request.url);
  const ua       = request.headers.get('user-agent') || '';
  const path     = url.pathname || '';
  const origin   = url.origin;

  // Extract slug from /impact/<slug> OR /.netlify/functions/impact-post/<slug>.
  // The function may receive either shape depending on whether the request
  // arrives via the netlify.toml redirect rule (which prepends the function
  // path) or as a direct invocation. Tolerate both, plus a trailing slash.
  const m = path.match(/^\/(?:impact|\.netlify\/functions\/impact-post)\/([^/?#]+)/i);
  const slug = m ? decodeURIComponent(m[1]).toLowerCase() : '';

  // Friendly fallback URL (where humans should land regardless of slug).
  const friendlyUrl = slug
    ? `${origin}/impact.html?post=${encodeURIComponent(slug)}`
    : `${origin}/impact.html`;

  // The stable URL this very function serves correctly on every fetch —
  // used for og:url/canonical so a crawler that re-normalizes around
  // "canonical" always lands back on correct data. See the long comment on
  // renderCrawlerHtml for why this must NOT be friendlyUrl.
  const canonicalUrl = slug ? `${origin}/impact/${encodeURIComponent(slug)}` : friendlyUrl;

  // ── PATH 1: Real human → just redirect to the rich page ──
  if (!isCrawler(ua)) {
    return new Response(null, {
      status: 302,
      headers: { 'location': friendlyUrl, 'cache-control': 'no-cache' },
    });
  }

  // ── PATH 2: Crawler → fetch post, render OG-only HTML ──
  let post = null;
  if (slug) {
    try { post = await getImpactPostBySlug(slug, false); } catch { post = null; }
  }

  // Default values if post not found / no slug — still produce a valid card
  const fallbackImage = `${origin}/logo-icon-1024.png`;
  const html = renderCrawlerHtml({
    title:        post?.title       || 'Renewonomics — Clean energy news, real impact',
    description:  snip(post?.summary || 'Curated coverage of solar, wind, hydrogen, nuclear, recycling and the global clean energy transition.', 280),
    canonicalUrl,
    humanUrl:     friendlyUrl,
    image:        socialImage(post?.img, origin) || `${origin}/og-image.png`,
    publishedAt:  post?.pubDate     || '',
    author:       post?.author      || '',
    category:     post?.category    || '',
  });

  return new Response(html, {
    status: 200,
    headers: {
      'content-type':  'text/html; charset=utf-8',
      // Cache crawler responses briefly. Most major crawlers refetch on share,
      // so a 5-min cache catches re-share bursts without leaving stale cards
      // up for long after a post is edited.
      'cache-control': 'public, max-age=300, s-maxage=300',
      // Tell intermediaries the response varies by user-agent (bot vs human)
      'vary':          'user-agent',
    },
  });
};

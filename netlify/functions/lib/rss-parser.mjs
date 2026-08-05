// ─────────────────────────────────────────────────────────────────────────────
// rss-parser.mjs — shared RSS/Atom feed parser (no dependencies)
// Used by both fetch-feeds.mjs (scheduled) and api.mjs (on-demand)
// ─────────────────────────────────────────────────────────────────────────────

/** Map title+summary text to one of the site's categories.
 *  Order matters: more specific patterns are checked first so that an article
 *  about "biogas from landfill waste" is tagged as 'bio' (not 'waste'), and
 *  "EU plastic recycling mandate" is 'recycling' (not 'waste'). */
export function detectCategory(text) {
  const t = (text || '').toLowerCase();

  // Specific tech/sector hits first
  if (/solar|photovoltaic|pv panel|sun power|rooftop solar|solar farm/.test(t))             return 'solar';
  if (/wind turbine|offshore wind|onshore wind|wind farm|wind power/.test(t))               return 'wind';
  if (/electric vehicle|\bev\b|\bevs\b|battery|charging|bev|phev|tesla|solid.state/.test(t)) return 'ev';
  if (/hydrogen|green h2|\bh₂\b|electrolyser|electrolyzer|fuel cell|hydrogen economy/.test(t)) return 'hydrogen';

  // Nuclear — checked early so SMR / reactor news lands here, not in storage
  if (/nuclear|\bsmr\b|small modular reactor|fission|fusion|reactor|atomic energy|uranium|thorium/.test(t)) return 'nuclear';

  // Storage — battery is also EV-adjacent so check after EV; pure storage mentions land here
  if (/grid storage|energy storage|battery storage|utility[- ]scale battery|pumped hydro|flow battery/.test(t)) return 'storage';

  // Bio (biofuels / bioenergy) — checked before waste so "biogas from landfill" → bio
  if (/biofuel|bioethanol|ethanol|biodiesel|saf|sustainable aviation fuel|bio[- ]?cng|biogas|bagasse|cellulosic/.test(t)) return 'bio';

  // Recycling — checked before waste so "plastic recycling" → recycling, not waste
  if (/recycle|recycling|e-waste|plastic recycling|circular economy|reusable/.test(t))     return 'recycling';

  // Waste (general municipal solid waste, landfill management, waste-to-energy)
  if (/landfill|municipal solid waste|\bmsw\b|waste[- ]to[- ]energy|waste management|garbage|trash/.test(t)) return 'waste';

  // Agri (regenerative agriculture, plant-based food, sustainable food systems)
  if (/regenerative agriculture|plant[- ]based|vertical farming|precision agriculture|cover crop|soil carbon|agritech|sustainable food|alternative protein|lab[- ]grown meat/.test(t)) return 'agri';

  // Water (treatment, desalination, conservation tech)
  if (/desalination|water treatment|wastewater|water tech|water utility|water scarcity|aquifer|water reuse/.test(t)) return 'water';

  // Ocean — checked after water so "wastewater" → water; ocean is more about marine renewable energy
  if (/tidal|wave energy|marine energy|offshore (?!wind)|deep[- ]sea/.test(t))               return 'ocean';

  // Environment — broad ecology / conservation / climate (but NOT renewables-specific
  // — those would have hit one of the more specific buckets above)
  if (/biodiversity|conservation|deforestation|reforestation|wildlife|ecosystem|pollution|air quality|emissions(?! trading)|carbon footprint|climate change|global warming|greenhouse gas|methane|protected area|species/.test(t)) return 'environment';

  // Policy — broad fallback for regulatory news
  if (/policy|legislation|regulation|subsidy|\bg20\b|cop\d|tax credit|mandate|directive|emissions trading/.test(t)) return 'policy';

  return 'all';
}

import { createHash } from 'crypto';

/** Stable ID for an article based on its URL.
 *  Uses SHA-256 truncated to 16 base64 chars (~96 bits) — collision probability
 *  is negligible for any realistic number of articles. */
export function articleId(link) {
  const src = link || Math.random().toString();
  return createHash('sha256').update(src).digest('base64').slice(0, 16).replace(/[+/=]/g, '_');
}

/**
 * Fetch and parse a single RSS/Atom feed URL.
 * Returns an array of article objects.
 *
 * @param {string} feedUrl   - The RSS/Atom URL to fetch
 * @param {string} feedName  - Display name (stored on each article)
 * @param {string} feedCat   - Default category override from admin config
 * @param {number} maxItems  - Max articles to return (default 20)
 */
export async function parseFeed(feedUrl, feedName, feedCat, maxItems = 20) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 12000);

  let text;
  try {
    const res = await fetch(feedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Renewonomics/1.0 (RSS aggregator; +https://renewonomics.org)',
        'Accept':     'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${feedUrl}`);
    text = await res.text();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }

  // ── Detect non-XML responses (bot challenges, login walls, HTML pages) ────
  const trimmed = text.trimStart();
  const isHTML  = trimmed.startsWith('<!') || trimmed.startsWith('<html') ||
                  trimmed.toLowerCase().includes('<html');
  if (isHTML) {
    // Check for common bot-challenge signals
    const lower = text.toLowerCase();
    if (lower.includes('cloudflare') || lower.includes('cf-ray') || lower.includes('challenge')) {
      throw new Error(`Blocked by Cloudflare bot protection — try a different feed URL`);
    }
    if (lower.includes('login') || lower.includes('sign in') || lower.includes('subscribe')) {
      throw new Error(`Feed URL returns a login/paywall page — feed requires authentication`);
    }
    throw new Error(`Feed URL returned an HTML page instead of XML — check the URL is a valid RSS/Atom feed`);
  }

  // ── Detect empty or malformed XML ────────────────────────────────────────
  if (text.length < 50) {
    throw new Error(`Feed response too short (${text.length} bytes) — may be empty or redirected`);
  }

  // ── XML parsing (no DOM available in Netlify Functions) ───────────────────
  // We use regex-based extraction — fast, dependency-free, handles RSS 2.0 + Atom
  const articles = [];

  // Normalise namespace prefixes so we can parse media:thumbnail, dc:date etc.
  const xml = text
    .replace(/media:/g,   'media_')
    .replace(/dc:/g,      'dc_')
    .replace(/content:/g, 'content_')
    .replace(/atom:/g,    'atom_')
    .replace(/itunes:/g,  'itunes_');

  // Match <item> (RSS) or <entry> (Atom) blocks
  const itemRE = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  // First pass: extract what we can from the RSS XML itself
  const itemsNeedingImageFetch = [];

  while ((match = itemRE.exec(xml)) !== null && articles.length < maxItems) {
    const block = match[1];

    const title   = extractTag(block, 'title');
    const link    = extractLink(block);
    const summary = extractSummary(block);
    const pubDate = extractDate(block);
    const img     = extractImage(block);

    if (!title || !link) continue;

    const id  = articleId(link);
    const cat = detectCategory(title + ' ' + summary) ;
    // If admin configured a specific category for this feed, use it (unless auto-detect gives something more specific)
    const finalCat = (feedCat && feedCat !== 'All' && feedCat !== 'all')
      ? feedCat.toLowerCase()
      : cat;

    const article = {
      id,
      title:     htmlDecode(title).trim(),
      link:      link.trim(),
      summary:   htmlDecode(summary).replace(/\s+/g, ' ').trim().slice(0, 300),
      pubDate:   pubDate || new Date().toISOString(),
      img:       img || '',
      category:  finalCat,
      source:    feedName,
      fetchedAt: new Date().toISOString(),
    };

    articles.push(article);

    // If we didn't find an image in the RSS, queue this article for OG image lookup
    if (!article.img) {
      itemsNeedingImageFetch.push(article);
    }
  }

  // Second pass: for articles missing an image, try to fetch the article page
  // and extract its Open Graph image (the same tag Facebook/Twitter use for previews).
  // We do this in parallel with a concurrency cap and a short timeout per request
  // so the overall fetch time stays reasonable even on slow feeds.
  if (itemsNeedingImageFetch.length > 0) {
    await fetchOgImagesInParallel(itemsNeedingImageFetch, 4);
  }

  // ── Warn if XML parsed but no items found ────────────────────────────────
  if (articles.length === 0) {
    const hasItemTags   = /<item[\s>]/i.test(xml);
    const hasEntryTags  = /<entry[\s>]/i.test(xml);
    if (!hasItemTags && !hasEntryTags) {
      throw new Error(`No <item> or <entry> elements found — not a valid RSS/Atom feed`);
    }
    // Items/entries exist but all were skipped (missing title or link)
    console.warn(`[rss-parser] "${feedName}": XML has items but all were missing title or link`);
  }

  return articles;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function extractTag(block, tag) {
  // Handles <tag>text</tag>, <tag attr="x">text</tag>, and <tag><![CDATA[text]]></tag>
  // For Atom <title type="xhtml"><div>...</div></title>, strip the wrapper div
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 'si');
  const m  = block.match(re);
  if (!m) return '';
  let text = m[1].trim();
  // If content is wrapped in a single top-level XHTML element (Atom type="xhtml"),
  // unwrap it so we get the inner text rather than "<div>Title</div>"
  const wrapMatch = text.match(/^<(?:div|p|span)\b[^>]*>([\s\S]*)<\/(?:div|p|span)>$/i);
  if (wrapMatch) text = wrapMatch[1].trim();
  return text;
}

function extractLink(block) {
  // Try 1: Atom-style with href attribute — accepts <link href>, <atom:link href>, <atom_link href>
  // Prefer rel="alternate" or no rel attribute (the canonical article URL)
  const atomLinks = [...block.matchAll(/<(?:atom[_:])?link\b([^>]*?)href=["']([^"']+)["']([^>]*)\/?>/gi)];
  if (atomLinks.length) {
    // Prefer rel="alternate" or no rel at all over rel="self", rel="enclosure", etc.
    const preferred = atomLinks.find(m => {
      const attrs = (m[1] || '') + (m[3] || '');
      return !/rel\s*=\s*["'](?!alternate)[^"']+["']/i.test(attrs);
    });
    return (preferred || atomLinks[0])[2];
  }

  // Try 2: RSS-style <link>URL</link> with optional whitespace and CDATA
  const textMatch = block.match(/<link[^>]*>\s*(?:<!\[CDATA\[\s*)?(https?:\/\/[^\s<\]]+)/i);
  if (textMatch) return textMatch[1];

  // Try 3: Fallback to <guid isPermaLink="true">URL</guid> (some old RSS feeds)
  const guidMatch = block.match(/<guid[^>]*isPermaLink\s*=\s*["']true["'][^>]*>\s*(https?:\/\/[^\s<]+)/i);
  if (guidMatch) return guidMatch[1];

  // Try 4: Last-ditch fallback — any <guid> that contains a URL
  const guidUrlMatch = block.match(/<guid[^>]*>\s*(https?:\/\/[^\s<]+)/i);
  if (guidUrlMatch) return guidUrlMatch[1];

  return '';
}

function extractSummary(block) {
  // Try description, then summary, then content_encoded, then content
  for (const tag of ['description', 'summary', 'content_encoded', 'content']) {
    const val = extractTag(block, tag);
    if (val) {
      // Strip HTML tags for plain text
      return val.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
    }
  }
  return '';
}

function extractDate(block) {
  for (const tag of ['pubDate', 'published', 'updated', 'dc_date', 'date']) {
    const val = extractTag(block, tag);
    if (val) {
      try { return new Date(val).toISOString(); } catch { /* skip */ }
    }
  }
  return '';
}

function extractImage(block) {
  // Try the most reliable sources first, in priority order.
  // After namespace normalisation (media: → media_), the tags we expect are:
  //   <media_content   url="..." medium="image" width="1200"/>  (often full-size hero)
  //   <media_thumbnail url="..."/>  (often smaller 150x150)
  //   <itunes_image    href="..."/>
  //   <enclosure url="..." type="image/jpeg"/>
  //   ...and finally <img src="..."> inside description/content:encoded CDATA

  // 1. media_content — preferred because it's usually the full-size article image.
  //    If multiple exist, pick the widest one.
  const mediaContents = [...block.matchAll(/<media_content\b([^>]+)\/?>/gi)];
  let bestMediaContent = null;
  let bestWidth = 0;
  for (const mc of mediaContents) {
    const attrs   = mc[1];
    const urlM    = attrs.match(/url=["']([^"']+)["']/i);
    const mediumM = attrs.match(/medium=["']([^"']+)["']/i);
    const typeM   = attrs.match(/type=["']([^"']+)["']/i);
    const widthM  = attrs.match(/width=["']?(\d+)/i);
    if (!urlM) continue;
    const isImage = (mediumM && /image/i.test(mediumM[1])) ||
                    (typeM   && /image/i.test(typeM[1])) ||
                    /\.(jpe?g|png|webp|gif)(\?|$)/i.test(urlM[1]);
    if (!isImage || !isLikelyRealImage(urlM[1])) continue;
    const w = widthM ? parseInt(widthM[1], 10) : 0;
    if (w >= bestWidth) {
      bestWidth = w;
      bestMediaContent = urlM[1];
    }
  }
  if (bestMediaContent) return normalizeImageUrl(bestMediaContent);

  // 2. media_thumbnail — standard RSS thumbnail tag
  let m = block.match(/<media_thumbnail[^>]+url=["']([^"']+)["']/i);
  if (m && isLikelyRealImage(m[1])) return normalizeImageUrl(m[1]);

  // 3. itunes_image (some podcasts and news feeds)
  m = block.match(/<itunes_image[^>]+href=["']([^"']+)["']/i);
  if (m && isLikelyRealImage(m[1])) return normalizeImageUrl(m[1]);

  // 4. enclosure url="..." type="image/..."  (Electrek, reNEWS, many WP sites)
  //    url and type can appear in any attribute order
  const enclosure = block.match(/<enclosure\b([^>]+)\/?>/i);
  if (enclosure) {
    const attrs  = enclosure[1];
    const typeM  = attrs.match(/type=["']([^"']+)["']/i);
    const urlM   = attrs.match(/url=["']([^"']+)["']/i);
    if (urlM) {
      const isImg = (typeM && /image/i.test(typeM[1])) ||
                    /\.(jpe?g|png|webp|gif)(\?|$)/i.test(urlM[1]);
      if (isImg && isLikelyRealImage(urlM[1])) return normalizeImageUrl(urlM[1]);
    }
  }

  // 5. Last resort — walk <img> tags inside CDATA and extract the best URL.
  //    Modern WordPress lazy-loads images, putting a placeholder in `src` and the
  //    real URL in `data-lazy-src`, `data-src`, or `data-orig-file`. We check those first.
  const imgTags = [...block.matchAll(/<img\b([^>]*?)\/?>/gi)];
  for (const imgTag of imgTags) {
    const attrs = imgTag[1];
    // Priority order: real image URL is usually in these lazy-load attributes
    const candidates = [
      attrs.match(/data-orig-file=["']([^"']+)["']/i),   // Jetpack original
      attrs.match(/data-lazy-src=["']([^"']+)["']/i),    // a3-lazy-load plugin
      attrs.match(/data-src=["']([^"']+)["']/i),         // generic lazy
      attrs.match(/data-full-src=["']([^"']+)["']/i),    // another WP variant
      attrs.match(/\bsrc=["']([^"']+)["']/i),            // normal src (may be placeholder)
    ];
    for (const c of candidates) {
      if (c && isLikelyRealImage(c[1])) return normalizeImageUrl(c[1]);
    }
    // Fallback: largest image from srcset (responsive images with no usable src)
    const srcsetM = attrs.match(/\bsrcset=["']([^"']+)["']/i);
    if (srcsetM) {
      // Parse srcset: "url1 300w, url2 1200w" — pick the widest
      const entries = srcsetM[1].split(',').map(s => s.trim()).map(s => {
        const parts = s.split(/\s+/);
        return { url: parts[0], w: parseInt(parts[1]) || 0 };
      }).filter(e => e.url && isLikelyRealImage(e.url));
      if (entries.length) {
        entries.sort((a, b) => b.w - a.w);
        return normalizeImageUrl(entries[0].url);
      }
    }
  }

  return '';
}

// Normalise third-party image CDN URLs to reduce hotlink issues.
// Jetpack's i0/i1/i2.wp.com can intermittently 403 external referrers.
// We unwrap them when possible so the browser fetches from the origin domain instead.
function normalizeImageUrl(url) {
  if (!url) return url;
  // Decode HTML entities like &#038; → & in case they leaked through
  const decoded = url.replace(/&#038;/g, '&').replace(/&amp;/g, '&');
  // Jetpack Photon URLs look like: https://i0.wp.com/example.com/path/image.jpg?fit=...&ssl=1
  // The origin domain is baked into the path after i0.wp.com/
  const jetpack = decoded.match(/^https?:\/\/i[0-2]\.wp\.com\/(.+?)(\?.*)?$/i);
  if (jetpack) {
    // Return the origin URL (drop Photon's query params since origin won't understand them)
    return 'https://' + jetpack[1];
  }
  return decoded;
}

// Filter out tracking pixels, social icons, avatars, and data: URIs.
// Real article images are hosted images over 100px typically.
function isLikelyRealImage(url) {
  if (!url) return false;
  // Reject data URIs (inline SVG placeholders, base64 pixels)
  if (url.startsWith('data:')) return false;
  // Reject very obvious tracking pixels / social buttons
  const u = url.toLowerCase();
  if (/feeds?\.feedburner\.com.*\.gif/.test(u)) return false; // FeedBurner pixel
  if (/feeds?\.wordpress\.com.*stats/.test(u)) return false;  // WP.com stats pixel
  if (/\/(pixel|spacer|blank|1x1|transparent)\.(gif|png)/.test(u)) return false;
  if (/gravatar\.com\/avatar/.test(u)) return false;          // author avatar
  if (/wp-content\/plugins/.test(u)) return false;            // plugin icons
  if (/\/emoji\//.test(u)) return false;                       // WordPress emoji images
  if (/\/icon[-_]?\d*\.(png|svg)/.test(u)) return false;      // small icons
  // Reject tiny dimensions embedded in URL (common on tracking pixels)
  if (/[?&](w|width)=(\d+)/.test(u)) {
    const w = parseInt(RegExp.$2, 10);
    if (w > 0 && w < 80) return false;
  }
  return true;
}

function htmlDecode(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// ─────────────────────────────────────────────────────────────────────────────
// OG image fallback — fetch the article page and look for <meta property="og:image">
// This is the same tag social platforms (Facebook, Twitter, Slack) use to generate
// link previews, so nearly every news/blog article has one even when the RSS doesn't.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For a batch of articles, fetch each article's page and try to find an og:image.
 * Mutates articles in place — sets article.img when a suitable image is found.
 * Runs with a concurrency cap and a short per-request timeout so slow sites
 * can't drag the whole feed-fetch down.
 */
async function fetchOgImagesInParallel(articles, concurrency = 4) {
  for (let i = 0; i < articles.length; i += concurrency) {
    const batch = articles.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(async article => {
      try {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) article.img = ogImage;
      } catch {
        // swallow — missing image is acceptable, we have a fallback icon
      }
    }));
  }
}

/**
 * Fetch an article page and extract its og:image (or twitter:image) meta tag.
 * Returns an absolute image URL or empty string.
 */
async function fetchOgImage(pageUrl) {
  const meta = await fetchPageMetadata(pageUrl);
  return meta.image || '';
}

/**
 * Fetch a page and extract Open Graph / Twitter Card metadata.
 * Returns { title, description, image, siteName, canonical } — all strings, empty when missing.
 * Used by:
 *   1. The RSS parser's og:image fallback (for feeds that don't include images)
 *   2. The admin "Add Article" preview endpoint (for manual URL curation)
 *
 * Times out at 6 seconds and reads only the first 80KB (metadata is always in <head>).
 */
export async function fetchPageMetadata(pageUrl) {
  const empty = { title: '', description: '', image: '', siteName: '', canonical: '' };
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(pageUrl, {
      signal:   controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Renewonomics/1.0; +https://renewonomics.org)',
        'Accept':     'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) return empty;

    // Read only the first ~80KB — OG tags are always in <head>, no need for the full page
    const reader = res.body?.getReader();
    let text;
    if (!reader) {
      text = await res.text();
    } else {
      let received = 0;
      const chunks = [];
      const MAX_BYTES = 80000;
      while (received < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
      }
      try { reader.cancel(); } catch {}
      text = Buffer.concat(chunks).toString('utf-8');
    }

    return extractMetadataFromHtml(text, res.url || pageUrl);
  } catch {
    clearTimeout(timeout);
    return empty;
  }
}

/** Extract all OG + Twitter Card metadata from an HTML string. */
function extractMetadataFromHtml(html, pageUrl) {
  if (!html) return { title: '', description: '', image: '', siteName: '', canonical: '' };

  const getMeta = (prop, attrName = 'property') => {
    const patterns = [
      new RegExp(`<meta[^>]+${attrName}=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attrName}=["']${prop}["']`, 'i'),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) return htmlDecode(m[1].trim());
    }
    return '';
  };

  const imageRaw =
    getMeta('og:image:secure_url') ||
    getMeta('og:image') ||
    getMeta('twitter:image', 'name') ||
    getMeta('twitter:image:src', 'name') ||
    '';
  const imageAbs = imageRaw ? absolutize(imageRaw, pageUrl) : '';
  const image    = (imageAbs && isLikelyRealImage(imageAbs)) ? normalizeImageUrl(imageAbs) : '';

  const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title =
    getMeta('og:title') ||
    getMeta('twitter:title', 'name') ||
    (titleTagMatch ? htmlDecode(titleTagMatch[1].trim()) : '');

  const description =
    getMeta('og:description') ||
    getMeta('twitter:description', 'name') ||
    getMeta('description', 'name') ||
    '';

  const siteName = getMeta('og:site_name');

  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
                      || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const canonical = canonicalMatch ? absolutize(canonicalMatch[1].trim(), pageUrl) : '';

  return { title, description, image, siteName, canonical };
}

/** Turn a possibly-relative URL into an absolute one using the page URL as base. */
function absolutize(url, baseUrl) {
  if (!url) return '';
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) {
    const proto = baseUrl.startsWith('https') ? 'https:' : 'http:';
    return proto + trimmed;
  }
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

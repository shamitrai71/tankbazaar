// ─────────────────────────────────────────────────────────────────────────────
// api.mjs — Netlify Function: REST API
//
// All routes are handled by this single function at /.netlify/functions/api
// The frontend calls these endpoints instead of reading/writing localStorage.
//
// PUBLIC routes (no auth — anyone can read):
//   GET  /api/articles          → all articles (newest first)
//   GET  /api/articles?cat=solar → filtered by category
//   GET  /api/feeds             → feed list (names + status, no internal IDs)
//   GET  /api/meta              → last fetch timestamp + article count
//
// ADMIN routes (require x-rw-admin-key header):
//   GET    /api/admin/feeds       → full feed config including URLs
//   POST   /api/admin/feeds       → add a new feed
//   DELETE /api/admin/feeds/:id   → remove a feed
//   PATCH  /api/admin/feeds/:id   → toggle active / update freq
//   POST   /api/admin/feeds/fetch → trigger an immediate fetch of all feeds
//   POST   /api/admin/feeds/test  → test a single feed URL, return preview articles
//   POST   /api/admin/articles/preview → fetch a URL and return OG metadata (for manual curation)
//   POST   /api/admin/articles/add     → save a manually-curated article
//   GET    /api/admin/rules       → get auto-publish rules
//   POST   /api/admin/rules       → save auto-publish rules
//   DELETE /api/admin/articles    → clear all articles
//   DELETE /api/admin/articles/:id → remove one article
//
// Admin key is set as a Netlify environment variable: RW_ADMIN_KEY
// Set it in: Netlify dashboard → Site → Environment variables → RW_ADMIN_KEY
// The frontend reads it from a meta tag injected by the admin page.
// ─────────────────────────────────────────────────────────────────────────────

import { parseFeed, fetchPageMetadata, articleId, detectCategory } from './lib/rss-parser.mjs';
import { getArticles, setArticles, getArticlesByCategory,
         getFeeds, setFeeds, getAutoRules, setAutoRules,
         getLastFetch, setLastFetch, getStats,
         getAllCategories, getCustomCategories, setCustomCategories, isBuiltInCategorySlug,
         getChampions, setChampions, mergeChampionDefaults,
         reorderChampions, setChampionOfYear, setFocusChampion,
         getImpactPosts, getImpactPostBySlug, setImpactPosts,
         getProducts, setProducts, incrementProductClick,
         getJobs, setJobs, incrementJobClick,
         getUser, upsertUser, createSession, getSession, deleteSession, userIdFromGoogleSub,
         getUserStats, trackUserStat, syncUserStats,
         addToWaitlist, isOnWaitlist, listWaitlist, removeFromWaitlist,
         addNewsletterSubscriber, confirmNewsletterSubscriber, unsubscribeNewsletter,
         listNewsletterSubscribers, listConfirmedSubscribers, getNewsletterSubscriber,
         recordNewsletterIssue, listNewsletterIssues,
         listAllUsers, setUserRole, deleteUser }                from './lib/store.mjs';
import { sendEmail, getRecentSends }                            from './lib/email.mjs';
import { verifyGoogleIdToken }                                  from './lib/google-verify.mjs';

// ── HELPERS ───────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-store',
    },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function isAdmin(request) {
  const key = request.headers.get('x-rw-admin-key') || '';
  return key === (process.env.RW_ADMIN_KEY || '');
}

function requireAdmin(request) {
  if (!isAdmin(request)) return err('Unauthorized', 401);
  return null;
}

/** Pull a Bearer token out of the Authorization header, or '' if not present. */
function bearerTokenFrom(request) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : '';
}

/** Resolve the bearer token to a userId, or null if no valid session. */
async function currentUserId(request) {
  const token = bearerTokenFrom(request);
  if (!token) return null;
  const session = await getSession(token);
  return session?.userId || null;
}

/** Normalise a URL so trivial variations don't cause false-new or false-dupe results.
 *  - lowercase the hostname
 *  - drop common tracking params (utm_*, fbclid, gclid)
 *  - drop trailing slash
 *  - strip fragment (#section)
 *  - treat http/https as equivalent
 */
function normalizeUrlForDedupe(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    u.protocol = 'https:';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    // Strip common tracking params
    const drop = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','mc_cid','mc_eid','ref','ref_src'];
    for (const p of drop) u.searchParams.delete(p);
    let out = u.toString();
    // Strip trailing slash (but keep root "/")
    if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
    return out;
  } catch {
    return url.trim().toLowerCase();
  }
}

// Parse route from URL
// Handles both /.netlify/functions/api/articles and /api/articles
function getRoute(url) {
  const u    = new URL(url);
  let path   = u.pathname;
  // Strip both possible prefixes
  path = path.replace(/^\/\.netlify\/functions\/api/, '');
  path = path.replace(/^\/api/, '');
  path = path || '/';
  return { path, searchParams: u.searchParams };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

export default async function handler(request) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-rw-admin-key, Authorization',
      },
    });
  }

  const { path, searchParams } = getRoute(request.url);
  const method = request.method.toUpperCase();

  // ── PUBLIC: GET /api/articles ─────────────────────────────────────────────
  if (method === 'GET' && path === '/articles') {
    const cat = searchParams.get('cat');
    try {
      const articles = cat && cat !== 'all'
        ? await getArticlesByCategory(cat)
        : await getArticles();
      // Don't expose internal fields like fetchedAt to the public feed
      const safe = articles
        .filter(a => !a.queued) // hide queued articles from public
        .map(({ id, title, link, summary, pubDate, img, category, source }) =>
          ({ id, title, link, summary, pubDate, img, category, source })
        );
      return json(safe);
    } catch (e) {
      return err('Failed to load articles: ' + e.message, 500);
    }
  }

  // ── PUBLIC: GET /api/feeds (names + status only, no URLs) ────────────────
  if (method === 'GET' && path === '/feeds') {
    try {
      const feeds = await getFeeds();
      const safe  = feeds.map(({ id, name, category, active, lastFetch, lastCount }) =>
        ({ id, name, category, active, lastFetch, lastCount })
      );
      return json(safe);
    } catch (e) {
      return err('Failed to load feeds', 500);
    }
  }

  // ── PUBLIC: GET /api/meta ─────────────────────────────────────────────────
  if (method === 'GET' && path === '/meta') {
    try {
      const [lastFetch, articles] = await Promise.all([getLastFetch(), getArticles()]);
      return json({ lastFetch, articleCount: articles.filter(a => !a.queued).length });
    } catch (e) {
      return err('Failed to load meta', 500);
    }
  }

  // ── PUBLIC: GET /api/categories ──────────────────────────────────────────
  // Returns the full list of categories (built-in + custom) so the feed page
  // and admin form can render them dynamically.
  if (method === 'GET' && path === '/categories') {
    try {
      const cats = await getAllCategories();
      return json(cats);
    } catch (e) {
      return err('Failed to load categories', 500);
    }
  }

  // ── PUBLIC: GET /api/geo ────────────────────────────────────────────────
  // Returns the visitor's detected country code from Netlify's edge geo data.
  // Netlify injects an `x-nf-geo` header (base64 JSON) on every request. We
  // decode it and return a 2-letter ISO country code the products page uses
  // to pick a default market. The user can always override this client-side.
  if (method === 'GET' && path === '/geo') {
    let country = '';
    try {
      const geoHeader = request.headers.get('x-nf-geo');
      if (geoHeader) {
        const decoded = JSON.parse(Buffer.from(geoHeader, 'base64').toString('utf-8'));
        country = (decoded?.country?.code || '').toUpperCase();
      }
    } catch { /* header absent or malformed — return empty, client falls back */ }
    return json({ country });
  }

  // ── PUBLIC: GET /api/champions ──────────────────────────────────────────
  // Returns the full list of green champions for the /champions page.
  if (method === 'GET' && path === '/champions') {
    try {
      return json(await getChampions());
    } catch (e) {
      return err('Failed to load champions', 500);
    }
  }

  // ── PUBLIC: GET /api/products ───────────────────────────────────────────
  // Published affiliate products for the /products page (drafts excluded).
  if (method === 'GET' && path === '/products') {
    try {
      return json(await getProducts(true));
    } catch (e) {
      return err('Failed to load products', 500);
    }
  }

  // ── PUBLIC: GET /api/products/go?id=<id> ────────────────────────────────
  // Outbound affiliate redirect with click tracking. We record the click
  // (best-effort) then 302 to the product's affiliate URL. Using a redirect
  // rather than linking directly lets us (a) count clicks and (b) keep the
  // tracking param logic server-side so it's not exposed in page source.
  if (method === 'GET' && path === '/products/go') {
    const id = searchParams.get('id') || '';
    if (!id) return err('Missing product id', 400);
    try {
      const products = await getProducts(true);
      const product  = products.find(p => p.id === id);
      if (!product || !product.affiliateUrl) {
        // Fall back to the products page rather than erroring out
        return new Response(null, { status: 302, headers: { location: '/products.html' } });
      }
      // Fire-and-forget click increment; don't await failure
      incrementProductClick(id).catch(() => {});
      return new Response(null, {
        status: 302,
        headers: { location: product.affiliateUrl, 'cache-control': 'no-cache' },
      });
    } catch {
      return new Response(null, { status: 302, headers: { location: '/products.html' } });
    }
  }

  // ── PUBLIC: GET /api/jobs ───────────────────────────────────────────────
  // Published, unexpired job listings for the feed (drafts + expired excluded).
  if (method === 'GET' && path === '/jobs') {
    try {
      return json(await getJobs(true));
    } catch (e) {
      return err('Failed to load jobs', 500);
    }
  }

  // ── PUBLIC: GET /api/jobs/go?id=<id> ────────────────────────────────────
  // Click-tracked outbound redirect to a job's apply URL. Same pattern as
  // /products/go — record the click (best-effort) then 302 to the employer's
  // application page. The click count is what employers are billed on later.
  if (method === 'GET' && path === '/jobs/go') {
    const id = searchParams.get('id') || '';
    if (!id) return err('Missing job id', 400);
    try {
      const jobs = await getJobs(true);
      const job  = jobs.find(j => j.id === id);
      if (!job || !job.applyUrl) {
        return new Response(null, { status: 302, headers: { location: '/feed.html' } });
      }
      incrementJobClick(id).catch(() => {});
      return new Response(null, {
        status: 302,
        headers: { location: job.applyUrl, 'cache-control': 'no-cache' },
      });
    } catch {
      return new Response(null, { status: 302, headers: { location: '/feed.html' } });
    }
  }

  // ── PUBLIC: GET /api/impact/posts ───────────────────────────────────────
  // Returns published impact posts (drafts excluded). Sorted featured-first then by date.
  if (method === 'GET' && path === '/impact/posts') {
    try {
      const posts = await getImpactPosts(true);
      return json(posts);
    } catch (e) {
      return err('Failed to load impact posts', 500);
    }
  }

  // ── PUBLIC: GET /api/impact/posts/:slug ─────────────────────────────────
  // Returns a single post by slug (published only).
  if (method === 'GET' && path.startsWith('/impact/posts/')) {
    const slug = decodeURIComponent(path.split('/').pop() || '');
    try {
      const post = await getImpactPostBySlug(slug, false);
      if (!post) return err('Post not found', 404);
      return json(post);
    } catch (e) {
      return err('Failed to load post', 500);
    }
  }

  // ── PUBLIC: POST /api/market/waitlist ───────────────────────────────────
  // Adds an email to the Market waitlist. Sends a confirmation email if the
  // signup is new (idempotent — re-submitting the same address is a no-op,
  // not an error). Designed to be called from the Market page form.
  if (method === 'POST' && path === '/market/waitlist') {
    const body  = await request.json().catch(() => ({}));
    const email = (body.email || '').toString().trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return err('A valid email address is required');
    }
    try {
      const meta = {
        source:    (body.source || 'market').toString().slice(0, 40),
        userAgent: (request.headers.get('user-agent') || '').slice(0, 200),
        referrer:  (request.headers.get('referer')    || '').slice(0, 300),
      };
      const result = await addToWaitlist(email, meta);
      // Fire confirmation email only if this is a NEW signup. Fire-and-forget
      // so the response is fast even if email delivery is slow.
      if (result.added) {
        sendEmail({
          to:      email,
          subject: 'You\'re on the Renewonomics waitlist 🌿',
          tag:     'waitlist-confirm',
          html:    waitlistConfirmHtml(),
        }).catch(() => { /* logged inside sendEmail; never block the response */ });
      }
      return json({
        ok:       true,
        added:    result.added,
        message:  result.added
                    ? 'Welcome aboard — check your inbox for confirmation.'
                    : 'You\'re already on the waitlist. We\'ll be in touch soon.',
      });
    } catch (e) {
      return err('Failed to join waitlist: ' + e.message, 500);
    }
  }

  // ── PUBLIC: POST /api/newsletter/subscribe ──────────────────────────────
  // Add an email as a 'pending' subscriber and send a confirmation email
  // (double opt-in). The confirmation link calls /api/newsletter/confirm.
  if (method === 'POST' && path === '/newsletter/subscribe') {
    const body  = await request.json().catch(() => ({}));
    const email = (body.email || '').toString().trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return err('A valid email address is required');
    }
    try {
      const meta = {
        source:    (body.source || 'website').toString().slice(0, 40),
        userAgent: (request.headers.get('user-agent') || '').slice(0, 200),
        referrer:  (request.headers.get('referer')    || '').slice(0, 300),
      };
      const result = await addNewsletterSubscriber(email, meta);

      // Already confirmed → friendly idempotent response, no email
      if (result.status === 'already-confirmed') {
        return json({
          ok: true,
          status: 'already-confirmed',
          message: 'You\'re already subscribed. Check your inbox for our next issue.',
        });
      }

      // Pending or reconfirm-needed → send confirmation email with token
      const origin = new URL(request.url).origin;
      const confirmUrl = `${origin}/.netlify/functions/api/newsletter/confirm?email=${encodeURIComponent(email)}&t=${result.entry.confirmToken}`;
      sendEmail({
        to:      email,
        subject: 'Confirm your Renewonomics newsletter subscription',
        tag:     'newsletter-confirm',
        html:    newsletterConfirmHtml(confirmUrl),
      }).catch(() => { /* logged inside sendEmail */ });

      return json({
        ok: true,
        status: 'pending',
        message: 'Almost there — check your inbox to confirm your subscription.',
      });
    } catch (e) {
      return err('Failed to subscribe: ' + e.message, 500);
    }
  }

  // ── PUBLIC: GET /api/newsletter/confirm?email=...&t=... ─────────────────
  // Confirms a subscription. Returns an HTML page so the link can be clicked
  // directly from email — no separate confirmation page required.
  if (method === 'GET' && path === '/newsletter/confirm') {
    const email = (searchParams.get('email') || '').trim().toLowerCase();
    const token = searchParams.get('t') || '';
    const result = await confirmNewsletterSubscriber(email, token);

    const origin = new URL(request.url).origin;
    const heading = result.ok
      ? (result.alreadyConfirmed ? 'Already confirmed ✓' : 'You\'re subscribed 🌿')
      : 'Couldn\'t confirm';
    const body = result.ok
      ? 'You\'ll receive our weekly digest of the most important clean energy stories.'
      : (result.reason === 'bad-token'
          ? 'This confirmation link is invalid or has already been used. Try subscribing again.'
          : 'We couldn\'t find that subscription. Try subscribing again.');

    return new Response(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${heading}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0d1612;color:#f5f0e8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.box{max-width:440px;background:#16201a;border:1px solid rgba(181,232,83,0.2);border-radius:14px;padding:36px 28px;text-align:center}
h1{margin:0 0 12px;font-size:24px;color:#b5e853}p{color:#a0a89a;line-height:1.5;margin:0 0 22px}
a.btn{display:inline-block;background:#b5e853;color:#0d1612;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:999px;font-size:14px}</style>
</head><body><div class="box">
<h1>${heading}</h1><p>${body}</p>
<a class="btn" href="${origin}/">${result.ok ? 'Continue to Renewonomics →' : 'Try again →'}</a>
</div></body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // ── PUBLIC: GET /api/newsletter/unsubscribe?email=...&t=... ─────────────
  // One-click unsubscribe from email footer. Always returns success-looking
  // page even if not found, to avoid leaking which emails are subscribed.
  if (method === 'GET' && path === '/newsletter/unsubscribe') {
    const email = (searchParams.get('email') || '').trim().toLowerCase();
    const token = searchParams.get('t') || '';
    await unsubscribeNewsletter(email, token);
    const origin = new URL(request.url).origin;
    return new Response(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Unsubscribed</title>
<style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0d1612;color:#f5f0e8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.box{max-width:440px;background:#16201a;border:1px solid rgba(245,197,66,0.2);border-radius:14px;padding:36px 28px;text-align:center}
h1{margin:0 0 12px;font-size:24px;color:#f5c542}p{color:#a0a89a;line-height:1.5;margin:0 0 22px}
a.btn{display:inline-block;background:transparent;color:#b5e853;text-decoration:none;font-weight:600;padding:11px 22px;border:1px solid rgba(181,232,83,0.4);border-radius:999px;font-size:14px}</style>
</head><body><div class="box">
<h1>You've been unsubscribed</h1>
<p>You won't receive any more digest emails from us. We're sorry to see you go — if this was a mistake, you can always subscribe again from the homepage.</p>
<a class="btn" href="${origin}/">Back to Renewonomics →</a>
</div></body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // AUTH (Google Sign-In)
  //
  // Login flow:
  //   1. Browser receives an `id_token` JWT from Google's GIS button click
  //   2. Browser POSTs that token to /api/auth/google
  //   3. Server verifies the JWT (signature + claims) against Google's public keys
  //   4. Server upserts a user record and creates a 30-day session
  //   5. Server returns a session token; browser stores it (localStorage)
  //   6. Browser sends the session token as `Authorization: Bearer <token>` on
  //      subsequent calls; server validates it via /api/auth/me
  // ────────────────────────────────────────────────────────────────────────

  // POST /api/auth/google — exchange a Google id_token for a Renewonomics session
  if (method === 'POST' && path === '/auth/google') {
    const body    = await request.json().catch(() => ({}));
    const idToken = body.credential || body.id_token || body.idToken;
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    if (!clientId) return err('Server not configured: GOOGLE_CLIENT_ID env var missing', 500);
    if (!idToken)  return err('Missing credential (Google id_token)');
    try {
      const claims = await verifyGoogleIdToken(idToken, clientId);
      const userId = userIdFromGoogleSub(claims.sub);

      // Detect first-time signup BEFORE the upsert. We use this signal to fire
      // the welcome email exactly once. As an extra belt-and-braces guard,
      // we also set `welcomeSentAt` on the user record after a successful send.
      const existingUser = await getUser(userId);
      const isNewSignup  = !existingUser;

      const user = await upsertUser({
        id:       userId,
        email:    claims.email,
        name:     claims.name || claims.given_name || claims.email.split('@')[0],
        picture:  claims.picture || '',
        provider: 'google',
        // role is preserved from existing record (admin assignment isn't done here)
      });

      // Welcome email — fire-and-forget so the user gets logged in immediately
      // even if email delivery is slow. Idempotent: checks both the
      // isNewSignup boolean AND the persisted welcomeSentAt flag.
      if (isNewSignup && !user.welcomeSentAt) {
        sendWelcomeEmail(user).catch(() => { /* logged inside; never block login */ });
      }

      const session = await createSession(userId);
      return json({
        token:     session.token,
        expiresAt: session.expiresAt,
        user: {
          id: user.id, email: user.email, name: user.name, picture: user.picture,
          role: user.role || 'user',
        },
      });
    } catch (e) {
      return err('Google sign-in failed: ' + e.message, 401);
    }
  }

  // GET /api/auth/me — validate the bearer token, return the user
  if (method === 'GET' && path === '/auth/me') {
    const token = bearerTokenFrom(request);
    if (!token) return err('No session', 401);
    const session = await getSession(token);
    if (!session) return err('Session expired or invalid', 401);
    const user = await getUser(session.userId);
    if (!user) return err('User not found', 401);
    return json({
      user: {
        id: user.id, email: user.email, name: user.name, picture: user.picture,
        role: user.role || 'user',
      },
      expiresAt: session.expiresAt,
    });
  }

  // POST /api/auth/logout — invalidate the bearer token
  if (method === 'POST' && path === '/auth/logout') {
    const token = bearerTokenFrom(request);
    await deleteSession(token);
    return json({ ok: true });
  }

  // ────────────────────────────────────────────────────────────────────────
  // USER STATS — server-side counters for the Profile page
  //
  // Everything here is scoped to the authenticated user. The session token
  // travels in `Authorization: Bearer <token>`. Anonymous users keep using
  // localStorage as a fallback in the frontend.
  // ────────────────────────────────────────────────────────────────────────

  // GET /api/me/stats — return counts for the logged-in user (small payload)
  if (method === 'GET' && path === '/me/stats') {
    const userId = await currentUserId(request);
    if (!userId) return err('No session', 401);
    try {
      const stats = await getUserStats(userId);
      return json({
        read:  stats.read.length,
        liked: stats.liked.length,
        // Saved is intentionally NOT mirrored here — it stays client-side per the design call.
        updatedAt: stats.updatedAt,
      });
    } catch (e) {
      return err('Failed to load stats: ' + e.message, 500);
    }
  }

  // POST /api/me/stats/track — record one user action: { action: 'read'|'liked', id: '...' }
  if (method === 'POST' && path === '/me/stats/track') {
    const userId = await currentUserId(request);
    if (!userId) return err('No session', 401);
    const body   = await request.json().catch(() => ({}));
    const action = (body.action || '').toString();
    const id     = (body.id || '').toString().slice(0, 256); // hard cap on ID length
    if (!id)                              return err('id is required');
    if (action !== 'read' && action !== 'liked') return err('action must be "read" or "liked"');
    try {
      const updated = await trackUserStat(userId, action, id);
      return json({
        ok:    true,
        read:  updated.read.length,
        liked: updated.liked.length,
      });
    } catch (e) {
      return err('Failed to track: ' + e.message, 500);
    }
  }

  // POST /api/me/stats/sync — bulk-merge localStorage stats into the user's account
  // Body: { read: [...ids], liked: [...ids] }. Used once after first login.
  if (method === 'POST' && path === '/me/stats/sync') {
    const userId = await currentUserId(request);
    if (!userId) return err('No session', 401);
    const body = await request.json().catch(() => ({}));
    // Defensive caps so a malicious client can't blow up the blob
    const read  = Array.isArray(body.read)  ? body.read.slice(0,  5000).map(String) : [];
    const liked = Array.isArray(body.liked) ? body.liked.slice(0, 5000).map(String) : [];
    try {
      const merged = await syncUserStats(userId, { read, liked });
      return json({
        ok:    true,
        read:  merged.read.length,
        liked: merged.liked.length,
      });
    } catch (e) {
      return err('Failed to sync: ' + e.message, 500);
    }
  }

  // ── ME: NEWSLETTER STATUS / SUBSCRIBE / UNSUBSCRIBE ─────────────────────
  // Profile-page convenience endpoints. The user's email is taken from the
  // session, so we never have to ask them to retype it. Returns a structured
  // status the profile widget renders into one of four states:
  //   "none"          → user has never signed up
  //   "pending"       → waiting on confirmation email click (double opt-in)
  //   "confirmed"     → subscribed
  //   "unsubscribed"  → previously subscribed, opted out

  if (method === 'GET' && path === '/me/newsletter') {
    const userId = await currentUserId(request);
    if (!userId) return err('No session', 401);
    try {
      const user = await getUser(userId);
      const email = user?.email || '';
      if (!email) return json({ status: 'none', email: '' });
      const sub = await getNewsletterSubscriber(email);
      return json({
        status: sub?.status || 'none',
        email,
        confirmedAt:    sub?.confirmedAt    || null,
        unsubscribedAt: sub?.unsubscribedAt || null,
        signedUpAt:     sub?.signedUpAt     || null,
      });
    } catch (e) {
      return err('Failed to load status: ' + e.message, 500);
    }
  }

  // POST /api/me/newsletter/subscribe — uses session email, sends confirm mail
  if (method === 'POST' && path === '/me/newsletter/subscribe') {
    const userId = await currentUserId(request);
    if (!userId) return err('No session', 401);
    try {
      const user  = await getUser(userId);
      const email = (user?.email || '').toLowerCase().trim();
      if (!email) return err('No email on this account', 400);

      const result = await addNewsletterSubscriber(email, {
        source:    'profile',
        userAgent: (request.headers.get('user-agent') || '').slice(0, 200),
      });

      if (result.status === 'already-confirmed') {
        return json({ ok: true, status: 'confirmed', message: 'You\'re already subscribed.' });
      }

      const origin = new URL(request.url).origin;
      const confirmUrl = `${origin}/.netlify/functions/api/newsletter/confirm?email=${encodeURIComponent(email)}&t=${result.entry.confirmToken}`;
      sendEmail({
        to:      email,
        subject: 'Confirm your Renewonomics newsletter subscription',
        tag:     'newsletter-confirm',
        html:    newsletterConfirmHtml(confirmUrl),
      }).catch(() => { /* logged inside sendEmail */ });

      return json({
        ok: true,
        status: 'pending',
        message: 'Check your inbox to confirm — the link expires when you next subscribe.',
      });
    } catch (e) {
      return err('Failed to subscribe: ' + e.message, 500);
    }
  }

  // POST /api/me/newsletter/unsubscribe — admin-style unsub for the session user
  if (method === 'POST' && path === '/me/newsletter/unsubscribe') {
    const userId = await currentUserId(request);
    if (!userId) return err('No session', 401);
    try {
      const user  = await getUser(userId);
      const email = (user?.email || '').toLowerCase().trim();
      if (!email) return err('No email on this account', 400);
      // Pass null token — server-side admin/owner unsub doesn't need the
      // emailed token (which is meant for one-click email-footer flows).
      const result = await unsubscribeNewsletter(email, null);
      return json({ ok: !!result.ok, status: 'unsubscribed' });
    } catch (e) {
      return err('Failed to unsubscribe: ' + e.message, 500);
    }
  }

  // ── PREFERRED CATEGORIES ────────────────────────────────────────────────
  // Stored directly on the user record (small array, no need for a separate
  // table). This is what makes category selections survive logging out and
  // back in, and follow the user across devices — the Profile page's
  // "My Interests" panel and the multi-select pills on Feed/Champions/Market
  // all read and write this same value, so changing it on any one of those
  // pages updates it everywhere else too.

  // GET /api/me/preferences — { preferredCategories: [...] }, [] if never set.
  if (method === 'GET' && path === '/me/preferences') {
    const userId = await currentUserId(request);
    if (!userId) return err('No session', 401);
    try {
      const user = await getUser(userId);
      return json({ preferredCategories: Array.isArray(user?.preferredCategories) ? user.preferredCategories : [] });
    } catch (e) {
      return err('Failed to load preferences: ' + e.message, 500);
    }
  }

  // PATCH /api/me/preferences — { preferredCategories: ['solar','wind',...] }
  if (method === 'PATCH' && path === '/me/preferences') {
    const userId = await currentUserId(request);
    if (!userId) return err('No session', 401);
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.preferredCategories)) return err('preferredCategories must be an array', 400);
    // Sanitise: strings only, lowercase, deduped, capped so a client bug
    // can't ever grow the user record unboundedly.
    const cleaned = [...new Set(
      body.preferredCategories
        .filter(c => typeof c === 'string')
        .map(c => c.trim().toLowerCase())
        .filter(Boolean)
    )].slice(0, 30);
    try {
      const updated = await upsertUser({ id: userId, preferredCategories: cleaned });
      return json({ preferredCategories: updated.preferredCategories });
    } catch (e) {
      return err('Failed to save preferences: ' + e.message, 500);
    }
  }

  // ── PUBLIC: GET /api/stats ────────────────────────────────────────────────
  // Returns live renewable energy stats (fetched daily by fetch-stats.mjs).
  // Falls back to static 2024 values if the scheduled function hasn't run yet.
  if (method === 'GET' && path === '/stats') {
    try {
      const stats = await getStats();
      if (stats) return json(stats);
      // First-deploy fallback — sensible 2024 public data values
      return json({
        updatedAt: null,
        co2:       { avoidedToday: 4200000 },
        solar:     { gw: 1419, year: 2023, live: false },
        wind:      { gw: 1017, year: 2023, live: false },
        renewables:{ pct: 29.4, year: 2021, live: false },
        wind_pct:  { pct: 7.8,  year: 2021, live: false },
        hydro:     { pct: 15.2, live: false },
        fossil:    { pct: 60.8, year: 2021, live: false },
        ev:        { millions: 45, marketShare: 22, year: 2024, live: false },
        ocean:     { kTonnes: 82, year: 2024, live: false },
      });
    } catch (e) {
      return err('Failed to load stats', 500);
    }
  }

  // ── BOOTSTRAP: unauthenticated key delivery (MUST be before the admin block) ──
  // Called by admin.html on load with { email } in the body.
  // Returns RW_ADMIN_KEY only if the email matches SUPER_ADMIN_EMAIL or ADMIN_EMAILS.
  // Path is /bootstrap (not /admin/bootstrap) so it is NOT caught by the admin
  // auth guard below, which would 401 every call before the key is ever issued.
  if (method === 'POST' && path === '/bootstrap') {
    const body  = await request.json().catch(() => ({}));
    const email = (body.email || '').toLowerCase().trim();
    const SUPER = process.env.SUPER_ADMIN_EMAIL || 'esraigroup@gmail.com';
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const allowed = email === SUPER || adminEmails.includes(email);
    if (!allowed) return err('Not authorized', 403);
    const key = process.env.RW_ADMIN_KEY || '';
    if (!key) return err('RW_ADMIN_KEY not configured on server', 500);
    return json({ adminKey: key });
  }

  // ── ADMIN: ALL /api/admin/* routes need auth ──────────────────────────────
  if (path.startsWith('/admin')) {
    const authErr = requireAdmin(request);
    if (authErr) return authErr;

    // GET /api/admin/feeds — full feed config
    if (method === 'GET' && path === '/admin/feeds') {
      return json(await getFeeds());
    }

    // POST /api/admin/feeds — add new feed
    if (method === 'POST' && path === '/admin/feeds') {
      const body  = await request.json().catch(() => ({}));
      const { name, url, category, freq, max } = body;
      if (!name || !url) return err('name and url are required');
      const feeds = await getFeeds();
      const newFeed = {
        id:        'feed_' + Date.now(),
        name:      name.trim(),
        url:       url.trim(),
        category:  category || 'All',
        freq:      freq      || 'Every 1 hour',
        max:       max       || 20,
        active:    true,
        lastFetch: null,
        lastCount: 0,
        lastError: null,
      };
      feeds.push(newFeed);
      await setFeeds(feeds);
      return json(newFeed, 201);
    }

    // DELETE /api/admin/feeds/:id — remove feed
    if (method === 'DELETE' && path.startsWith('/admin/feeds/')) {
      const id    = path.split('/').pop();
      const feeds = await getFeeds();
      const next  = feeds.filter(f => f.id !== id);
      if (next.length === feeds.length) return err('Feed not found', 404);
      await setFeeds(next);
      return json({ deleted: id });
    }

    // PATCH /api/admin/feeds/:id — toggle active / update freq
    if (method === 'PATCH' && path.startsWith('/admin/feeds/')) {
      const id    = path.split('/').pop();
      const body  = await request.json().catch(() => ({}));
      const feeds = await getFeeds();
      const idx   = feeds.findIndex(f => f.id === id);
      if (idx === -1) return err('Feed not found', 404);
      feeds[idx]  = { ...feeds[idx], ...body };
      await setFeeds(feeds);
      return json(feeds[idx]);
    }

    // POST /api/admin/feeds/fetch — trigger immediate fetch of all active feeds
    if (method === 'POST' && path === '/admin/feeds/fetch') {
      // Import and run the same logic as the scheduled function
      const { default: scheduledFetch } = await import('./fetch-feeds.mjs');
      try {
        // force=true bypasses the per-feed "due yet?" check so manual button always fetches everything
        const feedResults = await scheduledFetch({ force: true });
        const [articles, lastFetch] = await Promise.all([getArticles(), getLastFetch()]);
        return json({
          triggered:    true,
          articleCount: articles.length,
          lastFetch,
          feedResults:  feedResults || [],
        });
      } catch (e) {
        return err('Fetch failed: ' + e.message, 500);
      }
    }

    // POST /api/admin/stats/refresh — manually trigger the daily stats fetch.
    // Mirrors the scheduled fetch-stats run; returns a result summary incl.
    // which sources succeeded/failed so the admin can diagnose stale data.
    if (method === 'POST' && path === '/admin/stats/refresh') {
      const { default: statsFetch } = await import('./fetch-stats.mjs');
      try {
        const result = await statsFetch();
        return json({ triggered: true, ...result });
      } catch (e) {
        return err('Stats fetch failed: ' + e.message, 500);
      }
    }

    // GET /api/admin/diagnostics — system freshness snapshot for the admin
    // panel: when feeds + stats last ran, per-feed health, stats source health.
    if (method === 'GET' && path === '/admin/diagnostics') {
      try {
        const [feeds, lastFetch, stats, articles] = await Promise.all([
          getFeeds(), getLastFetch(), getStats(), getArticles(),
        ]);
        const now = Date.now();
        const ageStr = (iso) => {
          if (!iso) return 'never';
          const ms = now - new Date(iso).getTime();
          const mins = Math.floor(ms / 60000);
          if (mins < 1) return 'just now';
          if (mins < 60) return mins + 'm ago';
          const hrs = Math.floor(mins / 60);
          if (hrs < 24) return hrs + 'h ago';
          return Math.floor(hrs / 24) + 'd ago';
        };
        const feedHealth = (feeds || []).map(f => ({
          name:      f.name,
          active:    f.active !== false,
          lastFetch: f.lastFetch || null,
          lastFetchAge: ageStr(f.lastFetch),
          lastCount: f.lastCount || 0,
          lastError: f.lastError || null,
        }));
        const distinctSources = new Set(
          (articles || []).map(a => (a.source || '').trim().toLowerCase()).filter(Boolean)
        ).size;
        return json({
          feeds: {
            total:        feedHealth.length,
            active:       feedHealth.filter(f => f.active).length,
            withErrors:   feedHealth.filter(f => f.lastError).length,
            lastFetch:    lastFetch,
            lastFetchAge: ageStr(lastFetch),
            detail:       feedHealth,
          },
          articles: {
            total:           (articles || []).filter(a => !a.queued).length,
            distinctSources: distinctSources,
          },
          stats: {
            updatedAt:    stats?.updatedAt || null,
            updatedAge:   ageStr(stats?.updatedAt),
            diagnostics:  stats?.diagnostics || null,
            solarLive:    stats?.solar?.live || false,
            windLive:     stats?.wind?.live || false,
            renewablesLive: stats?.renewables?.live || false,
          },
        });
      } catch (e) {
        return err('Diagnostics failed: ' + e.message, 500);
      }
    }

    // POST /api/admin/feeds/test — test a single feed URL
    if (method === 'POST' && path === '/admin/feeds/test') {
      const body = await request.json().catch(() => ({}));
      if (!body.url) return err('url is required');
      try {
        const articles = await parseFeed(body.url, 'Test', body.category, 6);
        return json({ ok: true, count: articles.length, articles });
      } catch (e) {
        return json({ ok: false, error: e.message });
      }
    }

    // GET /api/admin/rules
    if (method === 'GET' && path === '/admin/rules') {
      return json(await getAutoRules());
    }

    // POST /api/admin/rules
    if (method === 'POST' && path === '/admin/rules') {
      const body = await request.json().catch(() => ({}));
      const saved = await setAutoRules(body);
      return json(saved || body);
    }

    // ─────────────────────────────────────────────────────────────────────
    // CUSTOM CATEGORY MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────

    // POST /api/admin/categories — add a new category
    if (method === 'POST' && path === '/admin/categories') {
      const body  = await request.json().catch(() => ({}));
      const label = (body.label || '').trim();
      if (!label) return err('label is required');
      if (label.length > 24) return err('label must be 24 characters or fewer');

      // Derive a URL-safe slug from the label (e.g. "Green Hydrogen" → "green-hydrogen")
      const slug = label.toLowerCase().trim()
                     .replace(/[^a-z0-9]+/g, '-')
                     .replace(/^-+|-+$/g, '')
                     .slice(0, 30);
      if (!slug) return err('label must contain letters or numbers');
      if (isBuiltInCategorySlug(slug)) {
        return err(`"${label}" matches a built-in category — built-in categories already exist`, 409);
      }

      const existing = await getCustomCategories();
      if (existing.some(c => c.slug === slug)) {
        return err(`Category "${label}" already exists`, 409);
      }

      const emoji = (body.emoji || '🏷️').trim().slice(0, 8);
      const color = /^#[0-9a-f]{3,6}$/i.test(body.color) ? body.color : '#4fd1c5'; // default teal
      const newCat = { slug, label, emoji, color, builtIn: false };

      await setCustomCategories([...existing, newCat]);
      return json(newCat, 201);
    }

    // DELETE /api/admin/categories/:slug — remove a custom category
    if (method === 'DELETE' && path.startsWith('/admin/categories/')) {
      const slug = decodeURIComponent(path.split('/').pop() || '').toLowerCase();
      if (isBuiltInCategorySlug(slug)) {
        return err('Built-in categories cannot be deleted', 400);
      }
      const existing = await getCustomCategories();
      const next     = existing.filter(c => c.slug !== slug);
      if (next.length === existing.length) {
        return err(`Category "${slug}" not found`, 404);
      }
      await setCustomCategories(next);
      return json({ deleted: slug });
    }

    // ─────────────────────────────────────────────────────────────────────
    // CHAMPIONS (Green Champions CRUD)
    // ─────────────────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/admin/champions') {
      return json(await getChampions());
    }

    // POST /api/admin/champions/merge-defaults — adds any seed champions
    // missing from the store. Doesn't overwrite existing edits. Idempotent.
    if (method === 'POST' && path === '/admin/champions/merge-defaults') {
      try {
        const result = await mergeChampionDefaults();
        return json({ ok: true, ...result });
      } catch (e) {
        return err('Merge failed: ' + e.message, 500);
      }
    }

    if (method === 'POST' && path === '/admin/champions') {
      // Replace the whole list (used for bulk reordering); or append one champion.
      const body = await request.json().catch(() => ({}));
      if (Array.isArray(body)) {
        const saved = await setChampions(body);
        return json(saved);
      }
      // Append single champion
      const existing = await getChampions();
      const id = (body.id || slugify(body.name || '')).toLowerCase();
      if (!id) return err('name or id is required');
      if (existing.some(c => c.id === id)) return err('A champion with this id already exists', 409);
      const newCh = normalizeChampion({ ...body, id });
      const next  = [...existing, newCh].sort((a,b) => (a.rank||999) - (b.rank||999));
      await setChampions(next);
      return json(newCh, 201);
    }

    // POST /api/admin/champions/:id/reorder — { rank } — move a champion to a
    // new position among ranks 2..N. Whoever's there shifts to make room.
    // Checked before the generic PATCH handler below since both paths start
    // with /admin/champions/:id.
    {
      const m = path.match(/^\/admin\/champions\/([^/]+)\/reorder$/);
      if (method === 'PATCH' && m) {
        const id   = decodeURIComponent(m[1]);
        const body = await request.json().catch(() => ({}));
        const rank = parseInt(body.rank, 10);
        if (!Number.isFinite(rank)) return err('rank must be a number', 400);
        try {
          const existing = await getChampions();
          const reordered = reorderChampions(existing, id, rank);
          await setChampions(reordered);
          return json({ ok: true, list: reordered });
        } catch (e) {
          return err(e.message, 400);
        }
      }
    }

    // POST /api/admin/champions/:id/champion-of-year — promote to rank 1.
    {
      const m = path.match(/^\/admin\/champions\/([^/]+)\/champion-of-year$/);
      if (method === 'POST' && m) {
        const id = decodeURIComponent(m[1]);
        try {
          const existing = await getChampions();
          const reordered = setChampionOfYear(existing, id);
          await setChampions(reordered);
          return json({ ok: true, list: reordered });
        } catch (e) {
          return err(e.message, 400);
        }
      }
    }

    // POST /api/admin/champions/:id/focus — { focus: true|false } — set or
    // clear this champion as the Focus Champion for its sector. Setting one
    // automatically clears any other focus champion in the same category.
    {
      const m = path.match(/^\/admin\/champions\/([^/]+)\/focus$/);
      if (method === 'POST' && m) {
        const id    = decodeURIComponent(m[1]);
        const body  = await request.json().catch(() => ({}));
        const focus = body.focus !== false; // default true unless explicitly false
        try {
          const existing = await getChampions();
          const updated  = setFocusChampion(existing, id, focus);
          await setChampions(updated);
          return json({ ok: true, list: updated });
        } catch (e) {
          return err(e.message, 400);
        }
      }
    }

    if (method === 'PATCH' && path.startsWith('/admin/champions/')) {
      const id       = decodeURIComponent(path.split('/').pop() || '');
      const body     = await request.json().catch(() => ({}));
      const existing = await getChampions();
      const idx      = existing.findIndex(c => c.id === id);
      if (idx === -1) return err('Champion not found', 404);
      const merged   = normalizeChampion({ ...existing[idx], ...body, id });
      existing[idx]  = merged;
      existing.sort((a,b) => (a.rank||999) - (b.rank||999));
      await setChampions(existing);
      return json(merged);
    }

    if (method === 'DELETE' && path.startsWith('/admin/champions/')) {
      const id       = decodeURIComponent(path.split('/').pop() || '');
      const existing = await getChampions();
      const next     = existing.filter(c => c.id !== id);
      if (next.length === existing.length) return err('Champion not found', 404);
      await setChampions(next);
      return json({ deleted: id });
    }

    // ─────────────────────────────────────────────────────────────────────
    // PRODUCTS (affiliate directory CRUD)
    //
    // GET    /api/admin/products            → full list incl. drafts
    // POST   /api/admin/products            → append one, or replace whole array
    // PATCH  /api/admin/products/:id        → update one
    // DELETE /api/admin/products/:id        → remove one
    // ─────────────────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/admin/products') {
      return json(await getProducts(false)); // include drafts for admin
    }

    if (method === 'POST' && path === '/admin/products') {
      const body = await request.json().catch(() => ({}));
      // Bulk replace (used for reordering) when an array is posted
      if (Array.isArray(body)) {
        const saved = await setProducts(body);
        return json(saved);
      }
      // Append single product
      const existing = await getProducts(false);
      const id = (body.id || slugify(body.name || '')).toLowerCase();
      if (!id) return err('name or id is required');
      if (existing.some(p => p.id === id)) return err('A product with this id already exists', 409);
      const now = new Date().toISOString();
      const newProduct = normalizeProduct({ ...body, id, addedAt: now, updatedAt: now });
      await setProducts([newProduct, ...existing]);
      return json(newProduct, 201);
    }

    if (method === 'PATCH' && path.startsWith('/admin/products/')) {
      const id       = decodeURIComponent(path.split('/').pop() || '');
      const body     = await request.json().catch(() => ({}));
      const existing = await getProducts(false);
      const idx      = existing.findIndex(p => p.id === id);
      if (idx === -1) return err('Product not found', 404);
      const merged   = normalizeProduct({
        ...existing[idx], ...body, id,
        addedAt:   existing[idx].addedAt,
        updatedAt: new Date().toISOString(),
      });
      existing[idx]  = merged;
      await setProducts(existing);
      return json(merged);
    }

    if (method === 'DELETE' && path.startsWith('/admin/products/')) {
      const id       = decodeURIComponent(path.split('/').pop() || '');
      const existing = await getProducts(false);
      const next     = existing.filter(p => p.id !== id);
      if (next.length === existing.length) return err('Product not found', 404);
      await setProducts(next);
      return json({ deleted: id });
    }

    // ─────────────────────────────────────────────────────────────────────
    // JOBS (curated listings CRUD)
    // GET    /api/admin/jobs      → full list incl. drafts + expired
    // POST   /api/admin/jobs      → create (or bulk-replace when array posted)
    // PATCH  /api/admin/jobs/:id  → update one
    // DELETE /api/admin/jobs/:id  → remove one
    // ─────────────────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/admin/jobs') {
      return json(await getJobs(false)); // include drafts + expired for admin
    }

    if (method === 'POST' && path === '/admin/jobs') {
      const body = await request.json().catch(() => ({}));
      if (Array.isArray(body)) {
        const saved = await setJobs(body);
        return json(saved);
      }
      const existing = await getJobs(false);
      const baseId = body.id || slugify(`${body.title || ''}-${body.company || ''}`);
      const id = (baseId || '').toLowerCase();
      if (!id) return err('title or id is required');
      if (existing.some(j => j.id === id)) return err('A job with this id already exists', 409);
      const now = new Date().toISOString();
      const newJob = normalizeJob({ ...body, id, postedAt: now, updatedAt: now });
      await setJobs([newJob, ...existing]);
      return json(newJob, 201);
    }

    if (method === 'PATCH' && path.startsWith('/admin/jobs/')) {
      const id       = decodeURIComponent(path.split('/').pop() || '');
      const body     = await request.json().catch(() => ({}));
      const existing = await getJobs(false);
      const idx      = existing.findIndex(j => j.id === id);
      if (idx === -1) return err('Job not found', 404);
      const merged   = normalizeJob({
        ...existing[idx], ...body, id,
        // Normal edits preserve the original post date; an explicit postedAt in
        // the body (sent only by "Repost") is allowed through to resurface the job.
        postedAt:  body.postedAt || existing[idx].postedAt,
        clicks:    existing[idx].clicks || 0,
        updatedAt: new Date().toISOString(),
      });
      existing[idx]  = merged;
      await setJobs(existing);
      return json(merged);
    }

    if (method === 'DELETE' && path.startsWith('/admin/jobs/')) {
      const id       = decodeURIComponent(path.split('/').pop() || '');
      const existing = await getJobs(false);
      const next     = existing.filter(j => j.id !== id);
      if (next.length === existing.length) return err('Job not found', 404);
      await setJobs(next);
      return json({ deleted: id });
    }

    // ─────────────────────────────────────────────────────────────────────
    // IMPACT POSTS (blog CRUD)
    // ─────────────────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/admin/impact/posts') {
      return json(await getImpactPosts(false)); // include drafts for admin
    }
    if (method === 'POST' && path === '/admin/impact/posts') {
      const body = await request.json().catch(() => ({}));
      const title = (body.title || '').trim();
      if (!title) return err('title is required');
      const existing = await getImpactPosts(false);
      let slug = (body.slug || slugify(title)).toLowerCase();
      // Ensure slug uniqueness
      if (existing.some(p => p.slug === slug)) {
        let n = 2;
        while (existing.some(p => p.slug === `${slug}-${n}`)) n++;
        slug = `${slug}-${n}`;
      }
      const newPost = normalizeImpactPost({ ...body, slug, title });
      await setImpactPosts([newPost, ...existing]);
      return json(newPost, 201);
    }

    if (method === 'PATCH' && path.startsWith('/admin/impact/posts/')) {
      const slug     = decodeURIComponent(path.split('/').pop() || '').toLowerCase();
      const body     = await request.json().catch(() => ({}));
      const existing = await getImpactPosts(false);
      const idx      = existing.findIndex(p => p.slug === slug);
      if (idx === -1) return err('Post not found', 404);
      const merged   = normalizeImpactPost({ ...existing[idx], ...body, slug: existing[idx].slug });
      existing[idx]  = merged;
      await setImpactPosts(existing);
      return json(merged);
    }

    if (method === 'DELETE' && path.startsWith('/admin/impact/posts/')) {
      const slug     = decodeURIComponent(path.split('/').pop() || '').toLowerCase();
      const existing = await getImpactPosts(false);
      const next     = existing.filter(p => p.slug !== slug);
      if (next.length === existing.length) return err('Post not found', 404);
      await setImpactPosts(next);
      return json({ deleted: slug });
    }

    // ─────────────────────────────────────────────────────────────────────
    // ADMIN USER MANAGEMENT
    //
    // GET    /api/admin/users                  → all users with stats (newest first)
    // PATCH  /api/admin/users/:userId/role     → body: { role: 'admin' | 'user' }
    // DELETE /api/admin/users/:userId          → delete user record + stats
    // POST   /api/admin/email/broadcast        → send a broadcast to a recipient filter
    // GET    /api/admin/email/log              → recent sends (success/fail) for audit
    // ─────────────────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/admin/users') {
      const users = await listAllUsers();
      return json({ count: users.length, users });
    }

    if (method === 'PATCH' && path.match(/^\/admin\/users\/[^/]+\/role$/)) {
      const userId = decodeURIComponent(path.split('/')[3] || '');
      const body   = await request.json().catch(() => ({}));
      const role   = (body.role || '').toString();
      // Self-demotion guard: don't let an admin remove their own admin role —
      // would lock the system out if they're the only admin.
      const callerId = await currentUserId(request);
      if (callerId === userId && role !== 'admin') {
        return err('You cannot remove your own admin role. Have another admin do it.', 400);
      }
      try {
        const updated = await setUserRole(userId, role);
        return json({ ok: true, user: { id: updated.id, role: updated.role } });
      } catch (e) {
        return err(e.message, 400);
      }
    }

    if (method === 'DELETE' && path.startsWith('/admin/users/')) {
      const userId = decodeURIComponent(path.split('/').pop() || '');
      // Self-delete guard
      const callerId = await currentUserId(request);
      if (callerId === userId) {
        return err('You cannot delete your own account from the admin panel.', 400);
      }
      await deleteUser(userId);
      return json({ deleted: userId });
    }

    // POST /api/admin/email/broadcast — send a campaign to a filtered recipient set
    if (method === 'POST' && path === '/admin/email/broadcast') {
      const body       = await request.json().catch(() => ({}));
      const subject    = (body.subject  || '').trim();
      const htmlBody   = (body.html     || '').trim();
      const filter     = (body.filter   || 'all').toString();
      const tag        = 'broadcast-' + Date.now().toString(36);
      const dryRun     = body.dryRun === true;

      if (!subject)  return err('Subject is required');
      if (!htmlBody) return err('Body (html) is required');

      // Build recipient list based on the filter
      let recipients = [];
      try {
        if (filter === 'all_users' || filter === 'admins' || filter === 'users_only') {
          const users = await listAllUsers();
          if      (filter === 'admins')     recipients = users.filter(u => u.role === 'admin');
          else if (filter === 'users_only') recipients = users.filter(u => u.role !== 'admin');
          else                              recipients = users; // all
          recipients = recipients.map(u => u.email).filter(Boolean);
        } else if (filter === 'waitlist') {
          const list = await listWaitlist();
          recipients = list.map(e => e.email).filter(Boolean);
        } else if (filter === 'all') {
          // Union of users + waitlist (deduplicated)
          const [users, list] = await Promise.all([listAllUsers(), listWaitlist()]);
          const set = new Set();
          users.forEach(u => u.email && set.add(u.email.toLowerCase()));
          list.forEach(e => e.email  && set.add(e.email.toLowerCase()));
          recipients = [...set];
        } else {
          return err(`Unknown filter "${filter}". Allowed: all, all_users, admins, users_only, waitlist`);
        }
      } catch (e) {
        return err('Failed to build recipient list: ' + e.message, 500);
      }

      // De-dupe + cap at a safety limit (we don't want a typo to send 50,000 emails)
      const uniqueRecipients = [...new Set(recipients.map(r => r.toLowerCase().trim()).filter(Boolean))];
      const SAFETY_CAP = 5000;
      if (uniqueRecipients.length > SAFETY_CAP) {
        return err(`Recipient list (${uniqueRecipients.length}) exceeds safety cap (${SAFETY_CAP}). Contact support to lift this.`, 400);
      }

      // Dry run: return what WOULD be sent without actually sending
      if (dryRun) {
        return json({
          dryRun:        true,
          recipientCount: uniqueRecipients.length,
          sample:        uniqueRecipients.slice(0, 5),
          tag,
        });
      }

      // Send. Sequentially with a small delay would be nicer (avoids burst rate
      // limits), but Resend handles batching internally. We fire all in
      // parallel with Promise.allSettled and report success/fail counts.
      const results = await Promise.allSettled(uniqueRecipients.map(to =>
        sendEmail({ to, subject, html: htmlBody, tag })
      ));
      let sent = 0, failed = 0;
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value?.ok) sent++;
        else failed++;
      }
      return json({
        ok:       failed === 0,
        attempted: uniqueRecipients.length,
        sent,
        failed,
        tag,
      });
    }

    // GET /api/admin/email/log — recent send records (for audit / debugging)
    if (method === 'GET' && path === '/admin/email/log') {
      const url   = new URL(request.url);
      const limit = Math.min(200, Math.max(10, parseInt(url.searchParams.get('limit') || '50', 10)));
      const records = await getRecentSends(limit);
      return json({ count: records.length, records });
    }

    // ─────────────────────────────────────────────────────────────────────
    // ADMIN WAITLIST
    //
    // GET    /api/admin/waitlist                   → list all signups (newest first)
    // DELETE /api/admin/waitlist/:emailB64         → remove a signup (unsubscribe)
    //
    // The DELETE path uses base64-encoded email because email addresses contain
    // characters that don't play well in URL paths. Frontend admin will encode.
    // ─────────────────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/admin/waitlist') {
      const list = await listWaitlist();
      return json({ count: list.length, entries: list });
    }

    if (method === 'DELETE' && path.startsWith('/admin/waitlist/')) {
      const enc = path.split('/').pop() || '';
      let email = '';
      try { email = Buffer.from(enc, 'base64').toString('utf-8'); } catch {}
      if (!email) return err('Invalid email encoding', 400);
      await removeFromWaitlist(email);
      return json({ removed: true, email });
    }

    // ─────────────────────────────────────────────────────────────────────
    // NEWSLETTER (admin)
    //
    // GET    /api/admin/newsletter/subscribers             → list all (any status)
    // GET    /api/admin/newsletter/subscribers?status=confirmed → filter by status
    // DELETE /api/admin/newsletter/subscribers/:emailB64   → admin-side unsubscribe
    // POST   /api/admin/newsletter/send                    → send a digest issue now
    //                                                        body: { subject, html, dryRun?, includeNotes? }
    // GET    /api/admin/newsletter/issues                  → past sent issues (newest first)
    // ─────────────────────────────────────────────────────────────────────

    if (method === 'GET' && path === '/admin/newsletter/subscribers') {
      const status = searchParams.get('status') || null;
      const list = await listNewsletterSubscribers(status);
      // Also include some quick counts so the admin UI doesn't have to compute them
      const all = status ? await listNewsletterSubscribers() : list;
      const counts = {
        total:        all.length,
        confirmed:    all.filter(s => s.status === 'confirmed').length,
        pending:      all.filter(s => s.status === 'pending').length,
        unsubscribed: all.filter(s => s.status === 'unsubscribed').length,
      };
      return json({ counts, entries: list });
    }

    if (method === 'DELETE' && path.startsWith('/admin/newsletter/subscribers/')) {
      const enc = path.split('/').pop() || '';
      let email = '';
      try { email = Buffer.from(enc, 'base64').toString('utf-8'); } catch {}
      if (!email) return err('Invalid email encoding', 400);
      await unsubscribeNewsletter(email, null);  // admin-side, no token check
      return json({ unsubscribed: true, email });
    }

    if (method === 'GET' && path === '/admin/newsletter/issues') {
      const list = await listNewsletterIssues(50);
      return json({ count: list.length, entries: list });
    }

    if (method === 'POST' && path === '/admin/newsletter/send') {
      const body = await request.json().catch(() => ({}));
      const subject = (body.subject || '').toString().trim();
      const htmlIn  = (body.html    || '').toString();
      const dryRun  = !!body.dryRun;
      if (!subject || !htmlIn) return err('subject and html are required', 400);

      const subscribers = await listConfirmedSubscribers();
      const recipients  = subscribers.map(s => ({ email: s.email, unsubToken: s.unsubToken }));

      if (dryRun) {
        return json({
          ok: true,
          dryRun: true,
          recipientCount: recipients.length,
          previewHtml: wrapNewsletterShell(htmlIn, recipients[0] || { email: 'preview@example.com', unsubToken: 'PREVIEW' }, request),
        });
      }

      // Send to each subscriber. Wrap with unsubscribe footer per-recipient
      // so each email has the correct unsub token. Sequential allSettled to
      // tolerate per-recipient failures without aborting the whole batch.
      const origin = new URL(request.url).origin;
      const results = await Promise.allSettled(recipients.map(r => {
        const html = wrapNewsletterShell(htmlIn, r, request);
        return sendEmail({
          to: r.email, subject, html, tag: 'newsletter-digest',
        });
      }));
      const successCount = results.filter(r => r.status === 'fulfilled' && r.value && r.value.ok !== false).length;
      const failureCount = results.length - successCount;

      const issue = await recordNewsletterIssue({
        subject,
        html: htmlIn,
        recipientCount: recipients.length,
        successCount,
        failureCount,
        sentBy: actor?.email || 'admin',
      });

      return json({ ok: true, issue, successCount, failureCount, recipientCount: recipients.length });
    }

    // ─────────────────────────────────────────────────────────────────────
    // MANUAL ARTICLE CURATION
    //
    // Two-step flow for adding an article from any URL:
    //   1) POST /api/admin/articles/preview → fetches the page and returns OG metadata
    //      so the admin can review/edit the title/summary/image before publishing
    //   2) POST /api/admin/articles/add → accepts the final article object and stores it
    //
    // Articles added this way live alongside RSS-fetched ones (same dedupe, same feed).
    // Each manually-added article is tagged with source: 'Manual' by default (overridable).
    // ─────────────────────────────────────────────────────────────────────

    // POST /api/admin/articles/preview — fetch URL and return OG metadata
    if (method === 'POST' && path === '/admin/articles/preview') {
      const body = await request.json().catch(() => ({}));
      const url  = (body.url || '').trim();
      if (!url) return err('url is required');
      if (!/^https?:\/\//i.test(url)) return err('url must start with http:// or https://');
      try {
        const meta = await fetchPageMetadata(url);
        if (!meta.title && !meta.image && !meta.description) {
          return err('Could not extract any metadata from that URL — site may block bots or return no OG tags', 422);
        }
        return json({
          ok:          true,
          url,
          title:       meta.title,
          description: meta.description,
          image:       meta.image,
          siteName:    meta.siteName,
          canonical:   meta.canonical,
        });
      } catch (e) {
        return err('Preview failed: ' + e.message, 500);
      }
    }

    // POST /api/admin/articles/add — save a manually-curated article
    if (method === 'POST' && path === '/admin/articles/add') {
      const body = await request.json().catch(() => ({}));
      const { url, title, summary, image, category, source } = body;
      if (!url || !title) return err('url and title are required');

      const link      = (body.canonical || url).trim();
      const id        = articleId(link);
      const catGuess  = category && category !== 'all'
                          ? category.toLowerCase()
                          : detectCategory(`${title} ${summary || ''}`);
      const now       = new Date().toISOString();

      const newArticle = {
        id,
        title:       title.trim().slice(0, 300),
        link,
        summary:     (summary || '').trim().slice(0, 500),
        pubDate:     body.pubDate || now,
        img:         image || '',
        category:    catGuess,
        source:      (source || 'Manual').trim().slice(0, 60),
        fetchedAt:   now,
        curatedManually: true,
      };

      const existing = await getArticles();
      // Dedupe on BOTH id (hash) and canonical URL, and normalise URLs for the check.
      // This catches articles stored under old broken hash IDs, and also URL variants
      // like trailing slashes, tracking params, and http vs https.
      const normLink = normalizeUrlForDedupe(link);
      const isDup = existing.some(a =>
        a.id === id || normalizeUrlForDedupe(a.link || '') === normLink
      );
      if (isDup) {
        return err('Article with this URL is already in the feed', 409);
      }

      // Enforce the per-day cap so manual adds respect the admin's auto-publish rules
      const rules     = await getAutoRules();
      const dayStart  = new Date(); dayStart.setHours(0, 0, 0, 0);
      const todayCount = existing.filter(a => new Date(a.fetchedAt || a.pubDate || 0) >= dayStart).length;
      if (rules.maxPerDay && todayCount >= rules.maxPerDay) {
        return err(`Daily limit reached (${rules.maxPerDay}) — raise "Max per day" in auto-publish rules to add more`, 429);
      }

      const merged = [newArticle, ...existing];
      const saved  = await setArticles(merged);
      // Manually added articles are real content updates, so refresh the
      // global lastFetch timestamp. Otherwise the feed's "updated Nd ago"
      // reflects only the last *scheduled* fetch and looks stale even though
      // the admin just added fresh articles.
      try { await setLastFetch(now); } catch {}
      return json({ added: newArticle, total: saved.length }, 201);
    }

    // DELETE /api/admin/articles — clear all
    if (method === 'DELETE' && path === '/admin/articles') {
      await setArticles([]);
      return json({ deleted: 'all' });
    }

    // DELETE /api/admin/articles/:id — remove one
    if (method === 'DELETE' && path.startsWith('/admin/articles/')) {
      const id       = path.split('/').pop();
      const articles = await getArticles();
      const next     = articles.filter(a => a.id !== id);
      await setArticles(next);
      return json({ deleted: id });
    }

    return err('Unknown admin route', 404);
  }

  return err('Not found', 404);
}

// No config export — function is served at the default /.netlify/functions/api path

// ─── Helpers for Champions + Impact Posts ────────────────────────────────────

function slugify(s) {
  return (s || '').toString().toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function toStringArr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return String(v).split(/\n+/).map(x => x.trim()).filter(Boolean);
}

/** Validate and shape an incoming champion object into a canonical form. */
function normalizeChampion(c) {
  return {
    id:         (c.id || slugify(c.name || '')).toLowerCase(),
    name:       (c.name || '').trim().slice(0, 80),
    sector:     (c.sector || '').trim().slice(0, 40),
    cat:        (c.cat || 'all').toLowerCase().slice(0, 30),
    emoji:      (c.emoji || '🏢').trim().slice(0, 8),
    featured:   c.featured === true,
    rank:       Number.isFinite(+c.rank) ? +c.rank : 999,
    stripeGrad: c.stripeGrad || 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline:    (c.tagline || '').trim().slice(0, 280),
    stats:      Array.isArray(c.stats)
                  ? c.stats.slice(0, 3).map(s => ({
                      val: (s.val || s.value || '').toString().trim().slice(0, 16),
                      lbl: (s.lbl || s.label || '').toString().trim().slice(0, 40),
                    }))
                  : [],
    shortDesc:  (c.shortDesc || '').trim().slice(0, 600),
    body:       toStringArr(c.body).slice(0, 10).map(p => p.slice(0, 2000)),
    tags:       toStringArr(c.tags).slice(0, 8).map(t => t.slice(0, 40)),
  };
}

/** Validate and shape an incoming product object into canonical form.
 *  Note: we deliberately store a priceBand ("$"/"$$"/"$$$") rather than an
 *  exact price, because affiliate product prices change constantly and a
 *  stale hardcoded price is both misleading and a compliance risk. */
function normalizeProduct(p) {
  const VALID_BANDS = ['$', '$$', '$$$', '$$$$'];
  const band = VALID_BANDS.includes(p.priceBand) ? p.priceBand : '$$';
  // countries: array of ISO-2 codes the product ships to, or ['GLOBAL'] for
  // worldwide. Used by the products page to filter by visitor market. We
  // uppercase + dedupe and default to GLOBAL so a product is never hidden
  // from everyone by accident.
  const VALID_MARKETS = ['IN', 'US', 'GB', 'EU', 'AU', 'CA', 'GLOBAL'];
  let countries = Array.isArray(p.countries)
    ? [...new Set(p.countries.map(c => String(c).toUpperCase().trim()))]
        .filter(c => VALID_MARKETS.includes(c))
    : [];
  if (!countries.length) countries = ['GLOBAL'];
  return {
    id:           (p.id || slugify(p.name || '')).toLowerCase(),
    slug:         (p.slug || slugify(p.name || '')).toLowerCase(),
    name:         (p.name || '').trim().slice(0, 120),
    brand:        (p.brand || '').trim().slice(0, 60),
    category:     (p.category || 'all').toLowerCase().slice(0, 30),
    countries,
    summary:      (p.summary || '').trim().slice(0, 400),
    image:        (p.image || '').trim().slice(0, 600),
    priceBand:    band,
    co2Note:      (p.co2Note || '').trim().slice(0, 120),
    affiliateUrl: (p.affiliateUrl || '').trim().slice(0, 1000),
    network:      (p.network || 'Direct').trim().slice(0, 40),
    ctaLabel:     (p.ctaLabel || 'View product').trim().slice(0, 40),
    featured:     p.featured === true,
    published:    p.published !== false,   // default published unless explicitly false
    clicks:       Number.isFinite(+p.clicks) ? +p.clicks : 0,
    addedAt:      p.addedAt   || new Date().toISOString(),
    updatedAt:    p.updatedAt || new Date().toISOString(),
  };
}

/** Validate and shape an incoming job listing. Unknown enum values fall back to
 *  sensible defaults so a malformed admin submission never corrupts the feed.
 *  expiresAt defaults to postedAt + 30 days when not supplied. */
function normalizeJob(j) {
  const REMOTE = ['onsite', 'hybrid', 'remote'];
  const TYPES  = ['full-time', 'contract', 'internship'];
  const EXP    = ['0-2', '2-5', '5-10', '10+'];

  const postedAt = j.postedAt || new Date().toISOString();
  let expiresAt = (j.expiresAt || '').trim();
  if (!expiresAt) {
    const d = new Date(postedAt);
    d.setDate(d.getDate() + 30);
    expiresAt = d.toISOString();
  }

  return {
    id:          (j.id || slugify(`${j.title || ''}-${j.company || ''}`)).toLowerCase(),
    title:       (j.title       || '').trim().slice(0, 140),
    company:     (j.company     || '').trim().slice(0, 80),
    companyLogo: (j.companyLogo || '').trim().slice(0, 600),
    location:    (j.location    || '').trim().slice(0, 80),
    remote:      REMOTE.includes(j.remote) ? j.remote : 'onsite',
    type:        TYPES.includes(j.type)    ? j.type   : 'full-time',
    experience:  EXP.includes(j.experience) ? j.experience : '2-5',
    salary:      (j.salary      || '').trim().slice(0, 60),
    category:    (j.category    || 'all').toLowerCase().slice(0, 30),
    summary:     (j.summary     || '').trim().slice(0, 400),
    applyUrl:    (j.applyUrl    || '').trim().slice(0, 1000),
    postedAt,
    expiresAt,
    featured:    j.featured === true,
    published:   j.published !== false,
    sponsor:     j.sponsor === 'paid' ? 'paid' : null,
    clicks:      Number.isFinite(+j.clicks) ? +j.clicks : 0,
    updatedAt:   j.updatedAt || new Date().toISOString(),
  };
}

/** Validate and shape an incoming impact-post object. */
function normalizeImpactPost(p) {
  const now = new Date().toISOString();
  return {
    slug:      (p.slug || slugify(p.title || '')).toLowerCase(),
    title:     (p.title || '').trim().slice(0, 200),
    summary:   (p.summary || '').trim().slice(0, 400),
    body:      (p.body || '').toString().slice(0, 20000), // markdown source
    img:       (p.img || '').trim(),
    category:  (p.category || 'all').toLowerCase().slice(0, 30),
    author:    (p.author || '').trim().slice(0, 80),
    featured:  p.featured === true,
    published: p.published !== false, // default: published=true
    pubDate:   p.pubDate || now,
    updatedAt: now,
  };
}

// ─── Email templates ─────────────────────────────────────────────────────────
// Inline templates for now. When the admin email-template editor lands (Phase 5)
// these become the seed defaults that admins can override via the admin panel.

function waitlistConfirmHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>You're on the waitlist</title>
</head>
<body style="margin:0;padding:0;background:#0a0e0c;font-family:'Helvetica Neue',Arial,sans-serif;color:#f5f0e8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0e0c;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#131c16;border:1px solid rgba(181,232,83,0.15);border-radius:14px;overflow:hidden;">
      <!-- Header -->
      <tr><td style="padding:32px 32px 8px;">
        <div style="font-family:'Georgia',serif;font-size:22px;font-weight:700;color:#f5f0e8;">
          🌿 renew<span style="color:#b5e853;">onomics</span>
        </div>
      </td></tr>
      <!-- Hero -->
      <tr><td style="padding:24px 32px;">
        <div style="display:inline-block;background:rgba(181,232,83,0.12);border:1px solid rgba(181,232,83,0.25);color:#b5e853;padding:6px 14px;border-radius:30px;font-family:'Courier New',monospace;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:18px;">⏳ Coming soon</div>
        <h1 style="margin:0 0 14px;font-family:'Georgia',serif;font-size:30px;line-height:1.15;font-weight:700;color:#f5f0e8;">
          You're on the list 🎉
        </h1>
        <p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:rgba(245,240,232,0.8);">
          Thanks for joining the Renewonomics Market waitlist. You'll be among the first to hear when we launch — with curated deals on energy-saving products that actually deliver on their efficiency claims.
        </p>
      </td></tr>
      <!-- What's coming -->
      <tr><td style="padding:0 32px 24px;">
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(181,232,83,0.1);border-radius:12px;padding:20px;">
          <div style="font-family:'Courier New',monospace;font-size:10px;color:#b5e853;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px;">What we're cooking up</div>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td style="padding:6px 0;color:rgba(245,240,232,0.85);font-size:14px;">⚡ Daily flash deals on solar, EV gear, heat pumps, induction cookers</td></tr>
            <tr><td style="padding:6px 0;color:rgba(245,240,232,0.85);font-size:14px;">🔍 Vetted by experts — no greenwashing, only real efficiency</td></tr>
            <tr><td style="padding:6px 0;color:rgba(245,240,232,0.85);font-size:14px;">💰 Smart price tracking so you know if it's actually a deal</td></tr>
            <tr><td style="padding:6px 0;color:rgba(245,240,232,0.85);font-size:14px;">🌱 Carbon savings calculator on every product</td></tr>
          </table>
        </div>
      </td></tr>
      <!-- CTA -->
      <tr><td style="padding:8px 32px 32px;">
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:rgba(245,240,232,0.65);">
          In the meantime, browse our renewable energy news, learn about the <strong style="color:#b5e853;">Green Champions</strong> leading the transition, and track the global energy shift in real time on our Impact dashboard.
        </p>
        <a href="https://renewonomics.org" style="display:inline-block;background:#b5e853;color:#0a0e0c;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">Visit Renewonomics →</a>
      </td></tr>
      <!-- Founder's note -->
      <tr><td style="padding:0 32px 28px;">
        <p style="margin:0;font-size:13px;line-height:1.6;color:rgba(245,240,232,0.55);font-style:italic;">
          P.S. Waitlist members get a one-time founder's discount on their first order. Stay tuned.
        </p>
      </td></tr>
      <!-- Footer -->
      <tr><td style="padding:20px 32px;background:rgba(0,0,0,0.25);border-top:1px solid rgba(181,232,83,0.08);">
        <p style="margin:0;font-size:11px;line-height:1.6;color:rgba(245,240,232,0.4);text-align:center;">
          You're getting this because you signed up at renewonomics.org/market. We won't spam you — only product launches and very occasional updates.<br>
          © Renewonomics 2026 · <a href="https://renewonomics.org" style="color:rgba(181,232,83,0.6);text-decoration:none;">renewonomics.org</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Send the welcome email to a brand-new user, then mark their record so we
 * don't send it again. Designed to be called fire-and-forget — failures get
 * logged inside sendEmail() and we just don't set the flag, allowing a future
 * run to retry (which is fine because the upsertUser path is idempotent).
 */
async function sendWelcomeEmail(user) {
  const result = await sendEmail({
    to:      user.email,
    subject: `Welcome to Renewonomics, ${firstNameOf(user.name)} 🌿`,
    tag:     'welcome',
    userId:  user.id,
    html:    welcomeEmailHtml(user),
  });
  // If the send succeeded, persist the flag so we never send again — even if
  // someone deletes their session and signs in again.
  if (result.ok) {
    try {
      await upsertUser({ id: user.id, welcomeSentAt: new Date().toISOString() });
    } catch { /* non-fatal */ }
  }
  return result;
}

function firstNameOf(fullName) {
  return (fullName || '').trim().split(/\s+/)[0] || 'friend';
}

function welcomeEmailHtml(user) {
  const name = firstNameOf(user.name);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Welcome to Renewonomics</title>
</head>
<body style="margin:0;padding:0;background:#0a0e0c;font-family:'Helvetica Neue',Arial,sans-serif;color:#f5f0e8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0e0c;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#131c16;border:1px solid rgba(181,232,83,0.15);border-radius:14px;overflow:hidden;">
      <!-- Header -->
      <tr><td style="padding:32px 32px 8px;">
        <div style="font-family:'Georgia',serif;font-size:22px;font-weight:700;color:#f5f0e8;">
          🌿 renew<span style="color:#b5e853;">onomics</span>
        </div>
      </td></tr>
      <!-- Hero -->
      <tr><td style="padding:24px 32px 8px;">
        <h1 style="margin:0 0 14px;font-family:'Georgia',serif;font-size:30px;line-height:1.2;font-weight:700;color:#f5f0e8;">
          Welcome aboard, ${escAttr(name)} 🌿
        </h1>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:rgba(245,240,232,0.8);">
          You've just joined a community that takes the energy transition seriously — without the doom-and-gloom or the empty cheerleading. Just real news, real data, and real companies actually shipping the future.
        </p>
      </td></tr>
      <!-- What's inside -->
      <tr><td style="padding:8px 32px 16px;">
        <div style="font-family:'Courier New',monospace;font-size:10px;color:#b5e853;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">What's inside</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="padding:14px 0;border-bottom:1px solid rgba(181,232,83,0.08);">
            <div style="font-size:15px;font-weight:600;color:#f5f0e8;margin-bottom:4px;">📰 The Feed</div>
            <div style="font-size:13px;line-height:1.5;color:rgba(245,240,232,0.65);">
              Hand-picked renewable energy news from the world's best sources, refreshed every 30 minutes. Filter by Solar, Wind, EV, Recycling, Ocean, or Policy.
            </div>
          </td></tr>
          <tr><td style="padding:14px 0;border-bottom:1px solid rgba(181,232,83,0.08);">
            <div style="font-size:15px;font-weight:600;color:#f5f0e8;margin-bottom:4px;">🏆 Green Champions</div>
            <div style="font-size:13px;line-height:1.5;color:rgba(245,240,232,0.65);">
              Profiles of the companies actually leading the energy transition. From First Solar to Ørsted to BYD — who they are, what they're doing, and why it matters.
            </div>
          </td></tr>
          <tr><td style="padding:14px 0;border-bottom:1px solid rgba(181,232,83,0.08);">
            <div style="font-size:15px;font-weight:600;color:#f5f0e8;margin-bottom:4px;">📊 Global Impact</div>
            <div style="font-size:13px;line-height:1.5;color:rgba(245,240,232,0.65);">
              Live statistics on renewable energy generation, CO₂ avoided, and the speed of the global shift. Data, not vibes.
            </div>
          </td></tr>
          <tr><td style="padding:14px 0;">
            <div style="font-size:15px;font-weight:600;color:#f5f0e8;margin-bottom:4px;">🛒 Market <span style="font-family:'Courier New',monospace;font-size:9px;color:#b5e853;background:rgba(181,232,83,0.12);padding:2px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:1px;">soon</span></div>
            <div style="font-size:13px;line-height:1.5;color:rgba(245,240,232,0.65);">
              Curated deals on energy-saving products, launching early 2026. Visit /market to join the early-access waitlist for a founder's discount.
            </div>
          </td></tr>
        </table>
      </td></tr>
      <!-- CTA -->
      <tr><td style="padding:8px 32px 32px;">
        <a href="https://renewonomics.org/feed.html" style="display:inline-block;background:#b5e853;color:#0a0e0c;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">Open the Feed →</a>
      </td></tr>
      <!-- P.S. -->
      <tr><td style="padding:0 32px 28px;">
        <p style="margin:0;font-size:13px;line-height:1.6;color:rgba(245,240,232,0.55);font-style:italic;">
          P.S. We send maybe one email a month — major launches and the occasional standout story. No marketing spam, no newsletter fatigue.
        </p>
      </td></tr>
      <!-- Footer -->
      <tr><td style="padding:20px 32px;background:rgba(0,0,0,0.25);border-top:1px solid rgba(181,232,83,0.08);">
        <p style="margin:0;font-size:11px;line-height:1.6;color:rgba(245,240,232,0.4);text-align:center;">
          You're getting this because you signed up at renewonomics.org with your Google account.<br>
          © Renewonomics 2026 · <a href="https://renewonomics.org" style="color:rgba(181,232,83,0.6);text-decoration:none;">renewonomics.org</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Email sent to confirm a newsletter signup (double opt-in). The link
 *  contains the email + a one-time confirm token. */
function newsletterConfirmHtml(confirmUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm subscription</title></head>
<body style="margin:0;padding:0;background:#0d1612;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1612;padding:40px 20px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#16201a;border-radius:14px;border:1px solid rgba(181,232,83,0.15);">
      <tr><td style="padding:36px 32px 8px;">
        <div style="font-family:'Playfair Display',Georgia,serif;font-size:26px;font-weight:700;color:#f5f0e8;letter-spacing:-0.3px;">
          renew<span style="color:#b5e853;font-style:italic;">onomics</span>
        </div>
        <div style="font-family:'Space Mono',Menlo,monospace;font-size:11px;color:#7a8378;letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;">Clean Energy · Cleaner Planet</div>
      </td></tr>
      <tr><td style="padding:14px 32px 28px;">
        <h1 style="margin:0 0 16px;color:#f5f0e8;font-size:22px;line-height:1.3;">Confirm your subscription 🌿</h1>
        <p style="margin:0 0 16px;color:#a0a89a;line-height:1.6;font-size:15px;">
          Thanks for signing up for the Renewonomics newsletter. To start receiving our weekly digest of the most important clean energy stories, please confirm your email address.
        </p>
        <p style="margin:24px 0;text-align:center;">
          <a href="${escAttr(confirmUrl)}" style="display:inline-block;background:#b5e853;color:#0d1612;text-decoration:none;font-weight:600;padding:13px 28px;border-radius:999px;font-size:14px;">Confirm subscription →</a>
        </p>
        <p style="margin:16px 0 0;color:#7a8378;line-height:1.6;font-size:12px;">
          If you didn't sign up for this, you can safely ignore this email — we won't send anything else without confirmation.
        </p>
      </td></tr>
      <tr><td style="padding:18px 32px 28px;border-top:1px solid rgba(181,232,83,0.08);">
        <div style="color:#5d6760;font-size:11px;line-height:1.5;">
          Renewonomics · Clean energy news, weekly.<br>
          <a href="https://renewonomics.org" style="color:#7a8378;text-decoration:none;">renewonomics.org</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** Wraps the admin's composed newsletter HTML with a branded shell, header,
 *  and a per-recipient unsubscribe footer. The `recipient` arg has email and
 *  unsubToken; the `request` arg is used to derive the origin for links. */
function wrapNewsletterShell(innerHtml, recipient, request) {
  const origin = new URL(request.url).origin;
  const unsubUrl = `${origin}/.netlify/functions/api/newsletter/unsubscribe?email=${encodeURIComponent(recipient.email)}&t=${encodeURIComponent(recipient.unsubToken || '')}`;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Renewonomics Digest</title></head>
<body style="margin:0;padding:0;background:#0d1612;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1612;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#16201a;border-radius:14px;border:1px solid rgba(181,232,83,0.15);overflow:hidden;">
      <tr><td style="padding:30px 28px 10px;">
        <div style="font-family:'Playfair Display',Georgia,serif;font-size:26px;font-weight:700;color:#f5f0e8;letter-spacing:-0.3px;">
          renew<span style="color:#b5e853;font-style:italic;">onomics</span>
        </div>
        <div style="font-family:'Space Mono',Menlo,monospace;font-size:11px;color:#7a8378;letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;">Weekly Digest</div>
      </td></tr>
      <tr><td style="padding:8px 28px 30px;color:#d8d8d0;font-size:15px;line-height:1.6;">
        ${innerHtml}
      </td></tr>
      <tr><td style="padding:20px 28px 26px;border-top:1px solid rgba(181,232,83,0.08);text-align:center;">
        <div style="color:#5d6760;font-size:11px;line-height:1.6;">
          You're receiving this because you subscribed at
          <a href="${escAttr(origin)}" style="color:#7a8378;text-decoration:none;">renewonomics.org</a>.<br>
          <a href="${escAttr(unsubUrl)}" style="color:#7a8378;text-decoration:underline;">Unsubscribe</a> · One-click, no questions asked.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

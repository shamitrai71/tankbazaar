// ─────────────────────────────────────────────────────────────────────────────
// fetch-feeds.mjs — Netlify Scheduled Function
//
// Runs automatically every 30 minutes via cron (configured in netlify.toml).
// No browser needs to be open. Runs on Netlify's infrastructure 24/7.
//
// What it does:
//   1. Reads feed config from Netlify Blobs
//   2. Checks which feeds are due (based on their configured frequency)
//   3. Fetches each due feed in parallel (with a concurrency cap)
//   4. Deduplicates against existing articles
//   5. Applies auto-publish rules (minWords, maxPerDay, queue mode)
//   6. Writes the merged article list back to Netlify Blobs
//   7. Updates lastFetch timestamp per feed
//
// Invocations: 48 per day × 30 days = 1,440/month (well within free 125k limit)
// ─────────────────────────────────────────────────────────────────────────────

import { parseFeed }                                    from './lib/rss-parser.mjs';
import { getFeeds, setFeeds, getArticles, setArticles,
         getAutoRules, setLastFetch }                   from './lib/store.mjs';

// ── FREQUENCY → MILLISECONDS ──────────────────────────────────────────────────
function freqToMs(freqStr) {
  const s = (freqStr || '').toLowerCase();
  if (s.includes('15 min')) return 15 * 60 * 1000;
  if (s.includes('30 min')) return 30 * 60 * 1000;
  if (s.includes('2 hour')) return  2 * 60 * 60 * 1000;
  if (s.includes('6 hour')) return  6 * 60 * 60 * 1000;
  if (s.includes('daily'))  return 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000; // default 1 hour
}

// ── PARALLEL FETCH WITH CONCURRENCY CAP ───────────────────────────────────────
async function fetchWithConcurrency(feeds, concurrency = 3) {
  const results = [];
  for (let i = 0; i < feeds.length; i += concurrency) {
    const batch = feeds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async feed => {
        const maxItems = parseInt(feed.max) || 20;
        const articles = await parseFeed(feed.url, feed.name, feed.category, maxItems);
        return { feed, articles, error: null };
      })
    );
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        // result.value.feed is unavailable on rejection — retrieve via index
        const feedIndex = results.length % batch.length;
        // Use the reason's feed reference stored in the closure via the mapped index
        // settled index mirrors batch index, so derive it directly
        const settledIndex = settled.indexOf(result);
        const originalFeed = batch[settledIndex];
        results.push({ feed: originalFeed, articles: [], error: result.reason?.message || 'Unknown error' });
      }
    }
  }
  return results;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
// `force` skips the "is this feed due yet?" check — used by the admin "Fetch All Now" button.
// The scheduled cron calls this without `force`, so it still respects each feed's frequency setting.
export default async function handler(opts = {}) {
  const force = opts && opts.force === true;
  const now = Date.now();
  console.log(`[fetch-feeds] Starting ${force ? 'forced (manual)' : 'scheduled'} run at ${new Date(now).toISOString()}`);

  // Run the actual fetch logic and capture results, but only return the array
  // when called manually via the API (force=true). The scheduled invocation must
  // return undefined or a Response, otherwise Netlify throws "unsupported value".
  const results = await runFetch(force, now);
  return force ? results : undefined;
}

// ── INNER LOGIC ──────────────────────────────────────────────────────────────
async function runFetch(force, now) {
  // 1. Load config
  const [allFeeds, existing, rules] = await Promise.all([
    getFeeds(),
    getArticles(),
    getAutoRules(),
  ]);

  const activeFeeds = allFeeds.filter(f => f.active);
  if (!activeFeeds.length) {
    console.log('[fetch-feeds] No active feeds configured. Exiting.');
    return [];
  }

  // 2. Determine which feeds are due (skipped when force=true)
  const dueFeeds = force
    ? activeFeeds
    : activeFeeds.filter(feed => {
        const last     = feed.lastFetch ? new Date(feed.lastFetch).getTime() : 0;
        const interval = freqToMs(feed.freq);
        return (now - last) >= interval;
      });

  if (!dueFeeds.length) {
    console.log('[fetch-feeds] No feeds due yet. Exiting.');
    return [];
  }

  console.log(`[fetch-feeds] ${dueFeeds.length} feed(s) ${force ? 'forced' : 'due'}: ${dueFeeds.map(f => f.name).join(', ')}`);

  // 3. Fetch all due feeds (max 3 in parallel)
  const fetchResults = await fetchWithConcurrency(dueFeeds, 3);

  // 4. Merge new articles with existing, deduplicate
  const existingIds  = new Set(existing.map(a => a.id));
  const newArticles  = [];
  const updatedFeeds = [...allFeeds]; // we'll update lastFetch on due feeds

  for (const { feed, articles, error } of fetchResults) {
    // Find and update the feed in our config array
    const feedIdx = updatedFeeds.findIndex(f => f.id === feed.id);

    if (error) {
      console.error(`[fetch-feeds] Failed to fetch "${feed.name}": ${error}`);
      if (feedIdx !== -1) {
        updatedFeeds[feedIdx] = { ...updatedFeeds[feedIdx], lastError: error, lastFetch: new Date().toISOString() };
      }
      continue;
    }

    // Apply minWords filter
    const filtered = rules.minWords > 0
      ? articles.filter(a => (a.summary || '').split(/\s+/).length >= rules.minWords)
      : articles;

    // Deduplicate
    const fresh = filtered.filter(a => !existingIds.has(a.id));
    fresh.forEach(a => existingIds.add(a.id));

    // Queue mode: mark articles for admin review instead of publishing live
    if (rules.mode === 'queue') {
      fresh.forEach(a => { a.queued = true; });
    }

    newArticles.push(...fresh);

    if (feedIdx !== -1) {
      updatedFeeds[feedIdx] = {
        ...updatedFeeds[feedIdx],
        lastFetch: new Date().toISOString(),
        lastCount: articles.length,
        lastError: null,
      };
    }

    console.log(`[fetch-feeds] "${feed.name}": ${articles.length} fetched, ${fresh.length} new`);
  }

  if (!newArticles.length) {
    console.log('[fetch-feeds] No new articles found across all feeds.');
    // Still save updated lastFetch timestamps on feeds
    await setFeeds(updatedFeeds);
    await setLastFetch(new Date().toISOString());
    // Return per-feed summary so admin sees which feeds returned what
    return fetchResults.map(({ feed, articles, error }) => ({
      id:    feed.id,
      name:  feed.name,
      count: articles.length,
      error: error || null,
    }));
  }

  // 5. Enforce maxPerDay cap
  const dayStart   = new Date(); dayStart.setHours(0, 0, 0, 0);
  const todayCount = existing.filter(a => new Date(a.fetchedAt || a.pubDate || 0) >= dayStart).length;
  const allowedNew = Math.max(0, rules.maxPerDay - todayCount);
  const cappedNew  = newArticles.slice(0, allowedNew);

  if (cappedNew.length < newArticles.length) {
    console.log(`[fetch-feeds] maxPerDay cap: keeping ${cappedNew.length} of ${newArticles.length} new articles`);
  }

  // 6. Write merged list back to store
  const merged   = [...cappedNew, ...existing];
  const final    = await setArticles(merged); // setArticles sorts + caps at 500
  const fetchTs  = new Date().toISOString();

  await Promise.all([
    setFeeds(updatedFeeds),
    setLastFetch(fetchTs),
  ]);

  console.log(`[fetch-feeds] Done. ${cappedNew.length} new articles added. Total: ${final.length}. Timestamp: ${fetchTs}`);

  // Return per-feed summary so the API can relay it to the admin panel
  return fetchResults.map(({ feed, articles, error }) => ({
    id:    feed.id,
    name:  feed.name,
    count: articles.length,
    error: error || null,
  }));
}

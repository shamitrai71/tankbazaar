// TANK BAZAAR — Commodity price proxy (OilPriceAPI.com)
//
// WHY THIS DESIGN: OilPriceAPI's free tier allows only 200 requests/month and
// its free "latest" endpoint returns CURRENT prices only (no history). So:
//   1. All 4 commodities are fetched in ONE request (comma-separated codes),
//      so each refresh costs just 1 call.
//   2. A shared Firestore cache serves every visitor for free between refreshes.
//   3. We refresh at most once every REFRESH_INTERVAL_HOURS and hard-cap at
//      MONTHLY_BUDGET, so we never exceed the free tier.
//   4. Because the free tier has no history endpoint, we BUILD our own trend
//      history: each daily refresh appends that day's price to a stored series
//      in Firestore. Charts therefore grow organically from real collected data
//      rather than showing fabricated history. Until enough days accumulate,
//      the UI honestly shows a short/forming trend.
//
// SETUP REQUIRED:
//   1. Free account at https://www.oilpriceapi.com (no card) → copy API token.
//   2. Netlify → Site configuration → Environment variables → add
//      OILPRICEAPI_KEY = <your token>, then redeploy.
//   3. Firestore rules already allow read/write on liveDataCache (reused).
//
// Codes (verified): WTI_USD, BRENT_CRUDE_USD, NATURAL_GAS_USD, GASOLINE_RBOB_USD
// Auth header is "Token <key>" (NOT "Bearer").

const SERIES = {
  wti:      { code: 'WTI_USD',           label: 'WTI Crude',            unit: 'USD/bbl' },
  brent:    { code: 'BRENT_CRUDE_USD',   label: 'Brent Crude',          unit: 'USD/bbl' },
  natgas:   { code: 'NATURAL_GAS_USD',   label: 'Henry Hub Nat Gas',    unit: 'USD/MMBtu' },
  gasoline: { code: 'GASOLINE_RBOB_USD', label: 'Gasoline (RBOB)',      unit: 'USD/gal' },
};
const CODE_TO_KEY = Object.fromEntries(Object.entries(SERIES).map(([k, v]) => [v.code, k]));

const REFRESH_INTERVAL_HOURS = 12;   // twice/day max → ~60 calls/month, well under 200
const MONTHLY_BUDGET = 180;          // hard ceiling under the 200 free-tier cap
const MAX_HISTORY_POINTS = 420;      // ~14 months of daily points, plenty for a 1Y chart

const FIREBASE_PROJECT_ID = 'tankbazaar';
const FIRESTORE_DB_ID = 'tankbazaar';
const CACHE_COLLECTION = 'liveDataCache';
const CACHE_DOC = 'commodities';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/${FIRESTORE_DB_ID}/documents`;

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}
function toFields(obj) { const f = {}; for (const [k, val] of Object.entries(obj)) f[k] = toValue(val); return f; }
function fromValue(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields);
  return null;
}
function fromFields(fields) { const o = {}; if (!fields) return o; for (const [k, v] of Object.entries(fields)) o[k] = fromValue(v); return o; }

async function readCache() {
  try {
    const res = await fetch(`${FS_BASE}/${CACHE_COLLECTION}/${CACHE_DOC}`);
    if (!res.ok) return null;
    const doc = await res.json();
    return fromFields(doc.fields);
  } catch (e) { return null; }
}
async function writeCache(data) {
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  try {
    await fetch(`${FS_BASE}/${CACHE_COLLECTION}/${CACHE_DOC}?${mask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toFields(data) }),
    });
  } catch (e) { /* best-effort */ }
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (event.httpMethod === 'GET' && event.queryStringParameters && event.queryStringParameters.diagnose) {
    const apiKey = process.env.OILPRICEAPI_KEY;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        status: 'Function is deployed and reachable ✓',
        provider: 'OilPriceAPI.com',
        keyConfigured: !!apiKey,
        keyPreview: apiKey ? (apiKey.slice(0, 4) + '…' + apiKey.slice(-4)) : null,
      }),
    };
  }

  try {
    const apiKey = process.env.OILPRICEAPI_KEY;
    if (!apiKey) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'OILPRICEAPI_KEY is not set.', series: {} }) };
    }

    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const todayKey = now.toISOString().slice(0, 10);
    const forceRefresh = event.queryStringParameters && event.queryStringParameters.force === '1';

    let cache = await readCache();
    if (!cache) cache = { history: {}, latest: {}, fetchedAt: null, callsThisMonth: 0, monthKey };
    if (!cache.history) cache.history = {};
    if (!cache.latest) cache.latest = {};
    if (cache.monthKey !== monthKey) { cache.callsThisMonth = 0; cache.monthKey = monthKey; }

    const ageHours = cache.fetchedAt ? (now - new Date(cache.fetchedAt)) / 3600000 : Infinity;
    const due = ageHours >= REFRESH_INTERVAL_HOURS || forceRefresh;
    const underBudget = (cache.callsThisMonth + 1) <= MONTHLY_BUDGET;

    let didRefresh = false;
    if (due && underBudget) {
      const codes = Object.values(SERIES).map(s => s.code).join(',');
      const url = `https://api.oilpriceapi.com/v1/prices/latest?by_code=${encodeURIComponent(codes)}`;
      try {
        const res = await fetch(url, { headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' } });
        if (res.ok) {
          const data = await res.json();
          // Response may be a single {data:{...}} or {data:{prices:[...]}} depending
          // on how many codes matched — handle both shapes.
          let rows = [];
          if (data && data.data) {
            if (Array.isArray(data.data.prices)) rows = data.data.prices;
            else if (data.data.code) rows = [data.data];
          }
          rows.forEach(r => {
            const key = CODE_TO_KEY[r.code];
            if (!key || typeof r.price !== 'number') return;
            cache.latest[key] = { price: r.price, at: r.created_at || r.timestamp || now.toISOString() };
            // Append/replace today's point in this series' history.
            if (!cache.history[key]) cache.history[key] = [];
            const hist = cache.history[key];
            const last = hist[hist.length - 1];
            if (last && last.date === todayKey) last.value = r.price;   // update today
            else hist.push({ date: todayKey, value: r.price });          // new day
            if (hist.length > MAX_HISTORY_POINTS) cache.history[key] = hist.slice(-MAX_HISTORY_POINTS);
          });
          cache.callsThisMonth += 1;
          cache.fetchedAt = now.toISOString();
          didRefresh = true;
          await writeCache(cache);
        }
      } catch (e) { /* keep serving cached data */ }
    }

    // Build the response: latest + change + our accumulated history per series.
    const summary = {};
    Object.entries(SERIES).forEach(([key, def]) => {
      const hist = cache.history[key] || [];
      const latest = hist[hist.length - 1];
      const prev = hist[hist.length - 2];
      summary[key] = {
        label: def.label, unit: def.unit,
        latest: latest ? latest.value : (cache.latest[key] ? cache.latest[key].price : null),
        latestDate: latest ? latest.date : null,
        changeAbs: (latest && prev) ? +(latest.value - prev.value).toFixed(4) : null,
        changePct: (latest && prev && prev.value) ? +((latest.value - prev.value) / prev.value * 100).toFixed(2) : null,
        observations: hist,          // [{date, value}, ...] accumulated over time
      };
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        series: summary,
        meta: {
          provider: 'OilPriceAPI.com',
          didRefresh,
          fetchedAt: cache.fetchedAt,
          cacheAgeHours: cache.fetchedAt ? Math.round((now - new Date(cache.fetchedAt)) / 3600000 * 10) / 10 : null,
          callsThisMonth: cache.callsThisMonth,
          monthlyBudget: MONTHLY_BUDGET,
          historyDays: Math.max(...Object.values(cache.history).map(h => h.length), 0),
        },
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message, series: {} }) };
  }
};

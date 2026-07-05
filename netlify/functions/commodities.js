// TANK BAZAAR — Commodity price proxy (FRED — Federal Reserve Bank of St. Louis)
//
// WHY THIS EXISTS: FRED requires a free API key. Keeping it server-side (a
// Netlify env var) means it never appears in browser page source, matching
// the same pattern used for vessels.js. FRED's free-tier limits are generous
// for this use (no VesselAPI-style rotation needed), but we still cache in
// Firestore for a few hours so a page full of visitors doesn't each trigger
// a fresh upstream fetch.
//
// SETUP REQUIRED:
// 1. Register free (no card) at https://fred.stlouisfed.org/docs/api/api_key.html
// 2. Netlify → Site configuration → Environment variables → add
//    FRED_API_KEY = <your key>, then redeploy.
// 3. Firestore rules must allow read/write on `liveDataCache` (already added
//    for the vessels feature — this reuses the same collection, new doc).
//
// Series used (verified stable FRED IDs):
//   WTI Crude (Cushing, OK):      DCOILWTICO
//   Brent Crude (Europe):         DCOILBRENTEU
//   Gasoline (NY Harbor):         DGASNYH
//   Henry Hub Natural Gas:        DHHNGSP
// These are daily REFERENCE prices (published next business day), not live
// tick data — labeled honestly as such in the UI.

const SERIES = {
  wti:      { id: 'DCOILWTICO',   label: 'WTI Crude',        unit: 'USD/bbl' },
  brent:    { id: 'DCOILBRENTEU', label: 'Brent Crude',      unit: 'USD/bbl' },
  gasoline: { id: 'DGASNYH',      label: 'Gasoline (NY Harbor)', unit: 'USD/gal' },
  natgas:   { id: 'DHHNGSP',      label: 'Henry Hub Nat Gas', unit: 'USD/MMBtu' },
};

const CACHE_TTL_HOURS = 6;   // FRED series update at most once/day; a few hours is plenty fresh
const HISTORY_DAYS = 400;    // enough trading days to cover a 1-year trendline

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
    const apiKey = process.env.FRED_API_KEY;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        status: 'Function is deployed and reachable ✓',
        keyConfigured: !!apiKey,
        keyPreview: apiKey ? (apiKey.slice(0, 4) + '…' + apiKey.slice(-4)) : null,
      }),
    };
  }

  try {
    const apiKey = process.env.FRED_API_KEY;
    if (!apiKey) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'FRED_API_KEY is not set.', series: {} }) };
    }

    const now = new Date();
    let cache = await readCache();
    const ageHours = cache && cache.fetchedAt ? (now - new Date(cache.fetchedAt)) / 3600000 : Infinity;
    const forceRefresh = event.queryStringParameters && event.queryStringParameters.force === '1';

    if (!cache || ageHours >= CACHE_TTL_HOURS || forceRefresh) {
      const series = {};
      await Promise.all(Object.entries(SERIES).map(async ([key, def]) => {
        try {
          const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${def.id}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${HISTORY_DAYS}`;
          const res = await fetch(url);
          if (!res.ok) return;
          const data = await res.json();
          const obs = (data.observations || [])
            .filter(o => o.value !== '.')  // FRED uses "." for missing observations
            .map(o => ({ date: o.date, value: parseFloat(o.value) }))
            .reverse(); // oldest first, easier for charting
          series[key] = { label: def.label, unit: def.unit, observations: obs };
        } catch (e) { /* skip this series; keep whatever we had cached */ }
      }));
      cache = { series, fetchedAt: now.toISOString() };
      await writeCache(cache);
    }

    // Build a compact "latest + change" summary per series alongside the full history.
    const summary = {};
    Object.entries(cache.series || {}).forEach(([key, s]) => {
      const obs = s.observations || [];
      const latest = obs[obs.length - 1];
      const prev = obs[obs.length - 2];
      summary[key] = {
        label: s.label, unit: s.unit,
        latest: latest ? latest.value : null,
        latestDate: latest ? latest.date : null,
        changeAbs: (latest && prev) ? +(latest.value - prev.value).toFixed(4) : null,
        changePct: (latest && prev && prev.value) ? +((latest.value - prev.value) / prev.value * 100).toFixed(2) : null,
        observations: obs,
      };
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        series: summary,
        meta: { fetchedAt: cache.fetchedAt, cacheAgeHours: Math.round(ageHours < Infinity ? ageHours * 10 : 0) / 10 },
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message, series: {} }) };
  }
};

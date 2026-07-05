// TANK BAZAAR — Live vessel proxy (VesselAPI.com) with quota-safe caching.
//
// WHY THIS DESIGN: the free VesselAPI tier allows only ~150 calls/month.
// If every visitor triggered a fresh API call, that budget would be gone in
// hours. Instead, this function keeps a SHARED cache in Firestore
// (liveDataCache/vessels). Every request first reads that cache — a free
// Firestore read — and only actually calls VesselAPI if the cache is stale
// AND the daily/monthly budget allows it. Terminals are refreshed in small
// rotating batches so coverage broadens over days rather than being spent
// all at once on a handful of ports.
//
// Budget math: BATCH_SIZE terminals x 1 refresh/day x 30 days must stay
// under the monthly cap. With BATCH_SIZE=4 and REFRESH_INTERVAL_HOURS=24:
// 4 x 30 = 120 calls/month, leaving a ~30-call buffer under a 150 cap.
//
// SETUP REQUIRED:
// 1. Netlify → Site configuration → Environment variables → add
//    VESSELAPI_KEY = <your VesselAPI.com key> (free, no card, vesselapi.com).
// 2. Firestore rules must allow read/write on `liveDataCache` (see
//    firestore.rules — this is a public, non-sensitive cache of AIS
//    positions, written only by this function).
//
// The client POSTs { terminals: [{id, lat, lng, cap}, ...] } — a broader
// rotation POOL (e.g. top 20 terminals) — and gets back { ships, meta }.

const NAV_STATUS = {
  0: 'Under way using engine', 1: 'At anchor', 2: 'Not under command',
  3: 'Restricted manoeuvrability', 4: 'Constrained by draught', 5: 'Moored',
  6: 'Aground', 7: 'Engaged in fishing', 8: 'Under way sailing',
  9: 'Reserved (HSC)', 10: 'Reserved (WIG)', 14: 'AIS-SART active', 15: 'Undefined',
};

const HALF_SPAN = 0.9;                 // degrees; |dLat|+|dLon| stays under VesselAPI's 4° cap
const BATCH_SIZE = 4;                  // terminals refreshed per actual API cycle
const REFRESH_INTERVAL_HOURS = 24;     // minimum time between real API-call cycles
const MONTHLY_BUDGET = 120;            // hard stop well under the 150 free-tier cap

const FIREBASE_PROJECT_ID = 'tankbazaar';
const FIRESTORE_DB_ID = 'tankbazaar';
const CACHE_COLLECTION = 'liveDataCache';
const CACHE_DOC = 'vessels';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/${FIRESTORE_DB_ID}/documents`;

// ---- Minimal Firestore REST helpers (no auth needed; the cache doc has a
// public read/write rule since it holds no sensitive data — see firestore.rules) ----
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
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const doc = await res.json();
    return fromFields(doc.fields);
  } catch (e) { return null; }
}
async function writeCache(data) {
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url = `${FS_BASE}/${CACHE_COLLECTION}/${CACHE_DOC}?${mask}`;
  try {
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toFields(data) }),
    });
  } catch (e) { /* best-effort; a failed cache write just means next call re-fetches */ }
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  // Self-service diagnostic (plain GET, no body) — confirms deployment + key,
  // never exposes the full key value.
  if (event.httpMethod === 'GET') {
    const apiKey = process.env.VESSELAPI_KEY;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        status: 'Function is deployed and reachable ✓',
        keyConfigured: !!apiKey,
        keyPreview: apiKey ? (apiKey.slice(0, 4) + '…' + apiKey.slice(-4)) : null,
        note: apiKey
          ? 'VESSELAPI_KEY is set. POST { terminals: [...] } to get live vessel data.'
          : 'VESSELAPI_KEY is NOT set. Add it in Netlify → Site configuration → Environment variables, then redeploy.',
      }),
    };
  }

  try {
    const apiKey = process.env.VESSELAPI_KEY;
    if (!apiKey) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'VESSELAPI_KEY is not set.', ships: [] }) };
    }

    let terminals = [];
    try {
      const parsed = event.body ? JSON.parse(event.body) : {};
      terminals = Array.isArray(parsed.terminals) ? parsed.terminals : [];
    } catch (e) { /* fall through empty */ }
    terminals = terminals.filter(t => typeof t.lat === 'number' && typeof t.lng === 'number');
    if (!terminals.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No terminals provided.', ships: [] }) };
    }

    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    let cache = await readCache();
    if (!cache) cache = { rotationIndex: 0, callsThisMonth: 0, monthKey, lastGlobalFetch: null, byTerminal: {} };
    if (cache.monthKey !== monthKey) { cache.callsThisMonth = 0; cache.monthKey = monthKey; }
    if (!cache.byTerminal) cache.byTerminal = {};

    const hoursSinceLastFetch = cache.lastGlobalFetch
      ? (now - new Date(cache.lastGlobalFetch)) / 3600000
      : Infinity;
    const dueForRefresh = hoursSinceLastFetch >= REFRESH_INTERVAL_HOURS;
    const underBudget = (cache.callsThisMonth + BATCH_SIZE) <= MONTHLY_BUDGET;

    let didRefresh = false;
    if (dueForRefresh && underBudget) {
      // Rotate through the terminal pool, BATCH_SIZE at a time.
      const batch = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        batch.push(terminals[(cache.rotationIndex + i) % terminals.length]);
      }
      const errors = [];
      await Promise.all(batch.map(async (t) => {
        const params = new URLSearchParams({
          'filter.latBottom': (t.lat - HALF_SPAN).toFixed(4),
          'filter.latTop': (t.lat + HALF_SPAN).toFixed(4),
          'filter.lonLeft': (t.lng - HALF_SPAN).toFixed(4),
          'filter.lonRight': (t.lng + HALF_SPAN).toFixed(4),
        });
        const url = `https://api.vesselapi.com/v1/location/vessels/bounding-box?${params.toString()}`;
        try {
          const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
          if (!res.ok) { errors.push(`terminal ${t.id}: HTTP ${res.status}`); return; }
          const data = await res.json();
          const list = data.vessels || data.vesselPositions || [];
          cache.byTerminal[t.id] = { ships: list, fetchedAt: now.toISOString() };
        } catch (e) {
          errors.push(`terminal ${t.id}: ${e.message}`);
        }
      }));
      cache.rotationIndex = (cache.rotationIndex + BATCH_SIZE) % terminals.length;
      cache.callsThisMonth += BATCH_SIZE;
      cache.lastGlobalFetch = now.toISOString();
      didRefresh = true;
      await writeCache(cache);
    }

    // Assemble the merged, deduped ship list from whatever's cached per terminal
    // (mix of freshly-updated and older-but-still-useful entries).
    const vesselMap = new Map();
    Object.values(cache.byTerminal).forEach(entry => {
      (entry.ships || []).forEach(v => {
        const key = v.mmsi || v.imo || `${v.latitude},${v.longitude}`;
        if (!vesselMap.has(key)) vesselMap.set(key, v);
      });
    });

    const ships = Array.from(vesselMap.values()).map(v => {
      const sog = typeof v.sog === 'number' ? v.sog : 0;
      return {
        name: v.vessel_name || v.vesselName || ('MMSI ' + (v.mmsi || 'unknown')),
        imo: (v.imo && v.imo !== 0) ? v.imo : (v.mmsi ? ('MMSI ' + v.mmsi) : '—'),
        mmsi: v.mmsi || null,
        lat: typeof v.latitude === 'number' ? v.latitude : null,
        lon: typeof v.longitude === 'number' ? v.longitude : null,
        cog: typeof v.cog === 'number' ? v.cog : null,
        sog: sog,
        type: '—', flag: '—', dwt: '—', cargo: '—', eta: '—',
        status: sog > 0.5 ? 'moving' : 'berthed',
        last: NAV_STATUS[v.nav_status] != null ? NAV_STATUS[v.nav_status] : '—',
      };
    }).filter(s => s.lat != null && s.lon != null).slice(0, 300);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ships,
        meta: {
          didRefresh,
          fetchedAt: cache.lastGlobalFetch,
          cacheAgeHours: cache.lastGlobalFetch ? Math.round((now - new Date(cache.lastGlobalFetch)) / 3600000 * 10) / 10 : null,
          callsThisMonth: cache.callsThisMonth,
          monthlyBudget: MONTHLY_BUDGET,
          terminalsInRotation: terminals.length,
          batchSize: BATCH_SIZE,
        },
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message, ships: [] }) };
  }
};

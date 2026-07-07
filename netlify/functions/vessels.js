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
// Budget math: (BATCH_SIZE position terminals + DETAIL_BATCH_SIZE destination
// lookups) x 1 refresh/day x 30 days must stay under the monthly cap. With
// BATCH_SIZE=3, DETAIL_BATCH_SIZE=1, REFRESH_INTERVAL_HOURS=24:
// (3+1) x 30 = 120 calls/month, leaving a ~30-call buffer under a 150 cap.
// Destination/ETA data (GET /v1/vessel/{mmsi}/eta) is looked up once per
// vessel and cached for DETAILS_TTL_DAYS, since a ship's stated destination
// rarely changes mid-voyage — so coverage grows over time without spiking
// usage on any single day.
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
const BATCH_SIZE = 4;                  // terminals refreshed per position-cycle (full 20-terminal rotation every 5 cycles)
const DETAIL_BATCH_SIZE = 1;           // vessels enriched per ELIGIBLE cycle (each costs 2 calls: eta + static)
const DETAILS_EVERY_N_CYCLES = 2;      // only enrich on every Nth cycle, to protect the monthly budget
const DETAILS_TTL_DAYS = 14;           // static identity + destination rarely change; re-check infrequently
const REFRESH_INTERVAL_HOURS = 24;     // minimum time between real API-call cycles
const MONTHLY_BUDGET = 145;            // just under the 150 free-tier cap
// Budget math (worst case, once/day): positions 4/day * 30 = 120, plus
// enrichment 2 calls on every 2nd day = ~30/month → ~150 ceiling, guarded by
// the hard MONTHLY_BUDGET check so it never exceeds the cap even if traffic
// triggers extra cycles.

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
    if (!cache) cache = { rotationIndex: 0, callsThisMonth: 0, monthKey, lastGlobalFetch: null, byTerminal: {}, vesselDetails: {} };
    if (cache.monthKey !== monthKey) { cache.callsThisMonth = 0; cache.monthKey = monthKey; }
    if (!cache.byTerminal) cache.byTerminal = {};
    if (!cache.vesselDetails) cache.vesselDetails = {};

    const hoursSinceLastFetch = cache.lastGlobalFetch
      ? (now - new Date(cache.lastGlobalFetch)) / 3600000
      : Infinity;
    const dueForRefresh = hoursSinceLastFetch >= REFRESH_INTERVAL_HOURS;

    let didRefresh = false, didDetailsRefresh = false;

    // 1) Position rotation batch (unchanged approach, smaller batch to leave
    // room for destination/ETA lookups within the same monthly budget).
    if (dueForRefresh && (cache.callsThisMonth + BATCH_SIZE) <= MONTHLY_BUDGET) {
      const batch = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        batch.push(terminals[(cache.rotationIndex + i) % terminals.length]);
      }
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
          if (!res.ok) return;
          const data = await res.json();
          const list = data.vessels || data.vesselPositions || [];
          cache.byTerminal[t.id] = { ships: list, fetchedAt: now.toISOString() };
        } catch (e) { /* skip this terminal; try again next cycle */ }
      }));
      cache.rotationIndex = (cache.rotationIndex + BATCH_SIZE) % terminals.length;
      cache.callsThisMonth += BATCH_SIZE;
      cache.cycleCount = (cache.cycleCount || 0) + 1;
      didRefresh = true;
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

    // 2) Per-vessel enrichment — a SEPARATE, small slice of the same shared
    // monthly budget. For each picked vessel we fetch BOTH its crew-reported
    // ETA/destination (GET /v1/vessel/{mmsi}/eta) AND its static data
    // (GET /v1/vessel/{mmsi} → type, flag/country, DWT), since the position
    // bounding-box endpoint returns none of those. Both are cached for
    // DETAILS_TTL_DAYS (a vessel's identity/destination rarely change
    // mid-voyage), so coverage broadens gradually without spiking usage.
    // Each picked vessel costs 2 calls (eta + static), so the effective
    // per-cycle detail cost is DETAIL_BATCH_SIZE * 2.
    const enrichmentDue = didRefresh && (cache.cycleCount % DETAILS_EVERY_N_CYCLES === 0);
    if (enrichmentDue && (cache.callsThisMonth + DETAIL_BATCH_SIZE * 2) <= MONTHLY_BUDGET) {
      const knownMmsi = Array.from(vesselMap.values()).map(v => v.mmsi).filter(Boolean);
      const needsLookup = knownMmsi.filter(mmsi => {
        const d = cache.vesselDetails[mmsi];
        if (!d) return true;
        const ageDays = (now - new Date(d.fetchedAt)) / 86400000;
        return ageDays >= DETAILS_TTL_DAYS;
      });
      const pick = needsLookup.slice(0, DETAIL_BATCH_SIZE);
      if (pick.length) {
        await Promise.all(pick.map(async (mmsi) => {
          const entry = { fetchedAt: now.toISOString() };
          // (a) ETA / destination
          try {
            const etaRes = await fetch(`https://api.vesselapi.com/v1/vessel/${mmsi}/eta?filter.idType=mmsi`, { headers: { Authorization: `Bearer ${apiKey}` } });
            if (etaRes.ok) {
              const data = await etaRes.json();
              const e = data.vesselEta || data;
              entry.destination = e.destination || null;
              entry.destinationPort = e.destination_port || null;
              entry.eta = e.eta || null;
              entry.draught = typeof e.draught === 'number' ? e.draught : null;
            }
          } catch (e) { /* skip */ }
          // (b) Static data — type, flag (country), deadweight tonnage
          try {
            const stRes = await fetch(`https://api.vesselapi.com/v1/vessel/${mmsi}?filter.idType=mmsi`, { headers: { Authorization: `Bearer ${apiKey}` } });
            if (stRes.ok) {
              const data = await stRes.json();
              const s = data.vessel || data;
              entry.type = s.vessel_type || s.ship_type || null;
              entry.flag = s.country || s.flag || null;
              entry.dwt = (typeof s.deadweight === 'number' ? s.deadweight
                          : typeof s.dwt === 'number' ? s.dwt
                          : typeof s.deadweight_tonnage === 'number' ? s.deadweight_tonnage : null);
            }
          } catch (e) { /* skip */ }
          cache.vesselDetails[mmsi] = entry;
        }));
        cache.callsThisMonth += pick.length * 2; // eta + static per vessel
        didDetailsRefresh = true;
      }
    }

    if (didRefresh || didDetailsRefresh) {
      cache.lastGlobalFetch = now.toISOString();
      await writeCache(cache);
    }

    const ships = Array.from(vesselMap.values()).map(v => {
      const sog = typeof v.sog === 'number' ? v.sog : 0;
      const details = (v.mmsi && cache.vesselDetails[v.mmsi]) || null;
      return {
        name: v.vessel_name || v.vesselName || ('MMSI ' + (v.mmsi || 'unknown')),
        imo: (v.imo && v.imo !== 0) ? v.imo : (v.mmsi ? ('MMSI ' + v.mmsi) : '—'),
        mmsi: v.mmsi || null,
        lat: typeof v.latitude === 'number' ? v.latitude : null,
        lon: typeof v.longitude === 'number' ? v.longitude : null,
        cog: typeof v.cog === 'number' ? v.cog : null,
        sog: sog,
        type: (details && details.type) || '—',
        flag: (details && details.flag) || '—',
        dwt: (details && details.dwt != null) ? details.dwt : '—',
        cargo: '—',
        destination: (details && details.destination) || '—',
        destinationPort: (details && details.destinationPort) || null,
        eta: (details && details.eta) || '—',
        draught: (details && details.draught != null) ? details.draught : '—',
        status: sog > 0.5 ? 'moving' : 'berthed',
        navStatus: NAV_STATUS[v.nav_status] != null ? NAV_STATUS[v.nav_status] : '—',
      };
    }).filter(s => s.lat != null && s.lon != null).slice(0, 300);

    const detailsCoverage = ships.length ? Math.round(ships.filter(s => s.destination !== '—').length / ships.length * 100) : 0;
    const enrichedCoverage = ships.length ? Math.round(ships.filter(s => s.type !== '—').length / ships.length * 100) : 0;
    const terminalsCovered = Object.keys(cache.byTerminal).length;

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ships,
        meta: {
          didRefresh, didDetailsRefresh,
          fetchedAt: cache.lastGlobalFetch,
          cacheAgeHours: cache.lastGlobalFetch ? Math.round((now - new Date(cache.lastGlobalFetch)) / 3600000 * 10) / 10 : null,
          callsThisMonth: cache.callsThisMonth,
          monthlyBudget: MONTHLY_BUDGET,
          terminalsInRotation: terminals.length,
          terminalsCovered,
          batchSize: BATCH_SIZE,
          detailsCachedCount: Object.keys(cache.vesselDetails).length,
          detailsCoveragePct: detailsCoverage,
          enrichedCoveragePct: enrichedCoverage,
        },
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message, ships: [] }) };
  }
};

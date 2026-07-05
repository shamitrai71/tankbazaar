// TANK BAZAAR — Live vessel proxy (VesselAPI.com)
//
// Why this exists: browser-direct calls to maritime APIs expose the API key
// to anyone viewing page source, and many providers (including AISStream)
// explicitly ask integrators not to do this. This function holds the key
// server-side (Netlify environment variable) and proxies requests from the
// app, returning only the normalized vessel data the client needs.
//
// SETUP REQUIRED: in Netlify → Site configuration → Environment variables,
// add VESSELAPI_KEY = <your VesselAPI.com API key>. Get a free key (no card
// required) at https://vesselapi.com — sign up, then Dashboard → API Keys.
//
// The client POSTs { terminals: [{id, lat, lng, cap}, ...] } and this
// function queries VesselAPI's bounding-box endpoint around each terminal,
// merges/dedupes the results, and returns { ships: [...], meta: {...} }.

const NAV_STATUS = {
  0: 'Under way using engine', 1: 'At anchor', 2: 'Not under command',
  3: 'Restricted manoeuvrability', 4: 'Constrained by draught', 5: 'Moored',
  6: 'Aground', 7: 'Engaged in fishing', 8: 'Under way sailing',
  9: 'Reserved (HSC)', 10: 'Reserved (WIG)', 14: 'AIS-SART active', 15: 'Undefined',
};

// Half-span in degrees for each terminal's query box. VesselAPI requires
// |dLat| + |dLon| <= 4 degrees total; 2 x HALF x 2 dims = 3.6, safely under.
const HALF_SPAN = 0.9;
const MAX_TERMINALS_PER_CALL = 15;   // keep API usage modest on free tier
const BATCH_SIZE = 5;                // small concurrency batches

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  try {
    const apiKey = process.env.VESSELAPI_KEY;
    if (!apiKey) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          error: 'VESSELAPI_KEY is not set. Add it in Netlify → Site configuration → Environment variables, then redeploy.',
          ships: [],
        }),
      };
    }

    let terminals = [];
    try {
      const parsed = event.body ? JSON.parse(event.body) : {};
      terminals = Array.isArray(parsed.terminals) ? parsed.terminals : [];
    } catch (e) { /* fall through with empty terminals */ }

    if (!terminals.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No terminals provided in request body.', ships: [] }) };
    }

    // Prioritize the largest facilities first if the caller sent more than we'll use.
    terminals = terminals
      .filter(t => typeof t.lat === 'number' && typeof t.lng === 'number')
      .sort((a, b) => (b.cap || 0) - (a.cap || 0))
      .slice(0, MAX_TERMINALS_PER_CALL);

    const vesselMap = new Map();
    const errors = [];

    for (let i = 0; i < terminals.length; i += BATCH_SIZE) {
      const batch = terminals.slice(i, i + BATCH_SIZE);
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
          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            errors.push(`terminal ${t.id}: HTTP ${res.status} ${txt.slice(0, 150)}`);
            return;
          }
          const data = await res.json();
          const list = data.vessels || data.vesselPositions || [];
          list.forEach(v => {
            const key = v.mmsi || v.imo || `${v.latitude},${v.longitude}`;
            if (!vesselMap.has(key)) vesselMap.set(key, v);
          });
        } catch (e) {
          errors.push(`terminal ${t.id}: ${e.message}`);
        }
      }));
    }

    // Normalize into the shape the app's ship table expects. Fields the
    // bounding-box endpoint doesn't provide (type, flag, DWT, destination,
    // cargo) are left as "—" rather than guessed — honest blanks, not fakes.
    const ships = Array.from(vesselMap.values()).map(v => {
      const sog = typeof v.sog === 'number' ? v.sog : 0;
      return {
        name: v.vessel_name || v.vesselName || ('MMSI ' + (v.mmsi || 'unknown')),
        imo: (v.imo && v.imo !== 0) ? v.imo : (v.mmsi ? ('MMSI ' + v.mmsi) : '—'),
        type: '—',
        flag: '—',
        dwt: '—',
        status: sog > 0.5 ? 'moving' : 'berthed',
        last: NAV_STATUS[v.nav_status] != null ? NAV_STATUS[v.nav_status] : '—',
        eta: '—',
        cargo: '—',
      };
    }).slice(0, 200);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ships,
        meta: { terminalsQueried: terminals.length, vesselsFound: ships.length, errors: errors.slice(0, 5) },
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message, ships: [] }) };
  }
};

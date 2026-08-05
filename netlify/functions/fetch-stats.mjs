// ─────────────────────────────────────────────────────────────────────────────
// fetch-stats.mjs — Netlify Scheduled Function
//
// Runs daily at midnight UTC. Pulls live renewable energy statistics from:
//   • World Bank Open Data API (free, no key) — electricity mix percentages
//   • Our World in Data CSV exports (free, no key) — installed capacity GW
//
// Stores the merged result to Netlify Blobs under 'stats/global'.
// The frontend reads it via GET /api/stats (served by api.mjs).
//
// Data sources:
//   World Bank indicators (WLD = global aggregate):
//     EG.ELC.RNEW.ZS  Renewable electricity output (% of total)
//     EG.ELC.WIND.ZS  Wind electricity (% of total)
//     EG.ELC.FOSL.ZS  Fossil fuel electricity (% of total)
//     EG.FEC.RNEW.ZS  Renewable energy share of total final consumption
//
//   Our World in Data CSV:
//     installed-solar-pv-capacity            → solar GW
//     cumulative-installed-wind-energy-capacity-gigawatts → wind GW
//
//   Static (no free real-time API exists):
//     EV fleet size & market share  — IEA Global EV Outlook (updated manually)
//     Ocean plastic recovery        — UN Environment Programme (updated manually)
// ─────────────────────────────────────────────────────────────────────────────

import { setStats } from './lib/store.mjs';

const WB_BASE   = 'https://api.worldbank.org/v2/country/WLD/indicator';
const OWID_BASE = 'https://ourworldindata.org/grapher';
const TIMEOUT   = 15000;

// ── WORLD BANK ────────────────────────────────────────────────────────────────
// Returns { value, year } for the most recent non-null data point, or null.
async function fetchWorldBank(indicator) {
  try {
    const url = `${WB_BASE}/${indicator}?format=json&mrv=5&per_page=5`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const [, data] = await res.json();
    const point = (data || []).find(d => d.value !== null);
    return point
      ? { value: Math.round(point.value * 10) / 10, year: parseInt(point.date) }
      : null;
  } catch (e) {
    _fetchErrors.push(`WorldBank ${indicator}: ${e.message}`);
    console.warn(`[fetch-stats] World Bank ${indicator} failed:`, e.message);
    return null;
  }
}

// ── OUR WORLD IN DATA CSV ─────────────────────────────────────────────────────
// OWID changed their grapher CSV API in 2024. The current canonical form is:
//   https://ourworldindata.org/grapher/<slug>.csv?v=1&csvType=full&useColumnShortNames=true
// We try the modern URL first, then fall back to the legacy bare .csv. We scan
// from the bottom for the latest "World" / "OWID_WRL" row. Errors are recorded
// on the module-level _fetchErrors array so the daily run can report them.
const _fetchErrors = [];

async function fetchOWID(slug) {
  const urls = [
    `${OWID_BASE}/${slug}.csv?v=1&csvType=full&useColumnShortNames=true`,
    `${OWID_BASE}/${slug}.csv`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT),
        headers: { 'User-Agent': 'Renewonomics/1.0 (stats aggregator; contact: hello@renewonomics.org)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text  = await res.text();
      const lines = text.split('\n').filter(Boolean);
      if (lines.length < 2) throw new Error('empty CSV');

      // Header tells us which column holds the value (last data column)
      // Scan backwards — OWID CSVs are ordered oldest→newest
      for (let i = lines.length - 1; i >= 1; i--) {
        const cols   = splitCsvLine(lines[i]);
        const entity = (cols[0] || '').trim();
        if (entity !== 'World' && entity !== 'OWID_WRL') continue;
        const year  = parseInt(cols[2]);
        const value = parseFloat(cols[cols.length - 1]);
        if (!isNaN(value) && value > 0) {
          return { value: Math.round(value), year };
        }
      }
      throw new Error('no World row found');
    } catch (e) {
      // Try next URL; only record the final failure
      if (url === urls[urls.length - 1]) {
        _fetchErrors.push(`OWID ${slug}: ${e.message}`);
        console.warn(`[fetch-stats] OWID ${slug} failed:`, e.message);
      }
    }
  }
  return null;
}

// Minimal CSV line splitter that respects double-quoted fields (some OWID
// entity names contain commas, e.g. "Korea, Rep.").
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// ── CO2 AVOIDED ESTIMATE ──────────────────────────────────────────────────────
// Rough methodology:
//   World electricity generation ≈ 29,000 TWh/yr (IEA 2023)
//   Renewables displaced fossil generation at avg ~500g CO₂/kWh
//   Annual avoided = renewableShare * 29,000 TWh * 500gCO₂/kWh → tonnes
//   Daily avoided = annual / 365
function estimateCO2AvoidedToday(renewablesPct) {
  if (!renewablesPct) return 4_200_000; // fallback
  const renewablesTWh        = (renewablesPct / 100) * 29_000;       // TWh
  const renewablesKWh        = renewablesTWh * 1e9;                  // kWh
  const annualAvoidedTonnes  = (renewablesKWh * 500) / 1_000_000;   // g → tonnes
  return Math.round(annualAvoidedTonnes / 365);
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default async function handler() {
  const startMs = Date.now();
  _fetchErrors.length = 0;  // reset diagnostics for this run (module may be warm)
  console.log('[fetch-stats] Starting daily stats fetch');

  // Fetch all sources in parallel
  const [
    renewablesPct,
    windPct,
    fossilPct,
    renewablesFinalPct,
    solarGW,
    windGW,
  ] = await Promise.all([
    fetchWorldBank('EG.ELC.RNEW.ZS'),
    fetchWorldBank('EG.ELC.WIND.ZS'),
    fetchWorldBank('EG.ELC.FOSL.ZS'),
    fetchWorldBank('EG.FEC.RNEW.ZS'),
    fetchOWID('installed-solar-pv-capacity'),
    fetchOWID('cumulative-installed-wind-energy-capacity-gigawatts'),
  ]);

  // Derive hydroelectric share: renewables% - wind% - solar%
  // (rough proxy; hydro dominates remaining renewables)
  let hydroPct = null;
  if (renewablesPct?.value && windPct?.value) {
    const solarShare = solarGW?.value
      ? Math.round(((solarGW.value / 9000) * 100) * 10) / 10   // ~9000 TWh solar proxy
      : 4.5;
    hydroPct = Math.max(
      0,
      Math.round((renewablesPct.value - windPct.value - solarShare) * 10) / 10
    );
  }

  const co2AvoidedToday = estimateCO2AvoidedToday(renewablesPct?.value);

  // Build the stats object — fallback values come from 2024 public data
  const stats = {
    updatedAt: new Date().toISOString(),
    fetchMs:   Date.now() - startMs,

    co2: {
      avoidedToday: co2AvoidedToday,
      label:        'tonnes CO₂ avoided today vs all-fossil baseline',
      source:       'Calculated from World Bank EG.ELC.RNEW.ZS + IEA generation data',
    },

    solar: {
      gw:     solarGW?.value  ?? 1419,
      year:   solarGW?.year   ?? 2023,
      source: solarGW ? 'Our World in Data / IRENA' : 'static fallback',
      live:   !!solarGW,
    },

    wind: {
      gw:     windGW?.value   ?? 1017,
      year:   windGW?.year    ?? 2023,
      source: windGW ? 'Our World in Data / IRENA' : 'static fallback',
      live:   !!windGW,
    },

    renewables: {
      pct:    renewablesPct?.value     ?? 29.4,
      year:   renewablesPct?.year      ?? 2021,
      source: renewablesPct ? 'World Bank EG.ELC.RNEW.ZS' : 'static fallback',
      live:   !!renewablesPct,
    },

    wind_pct: {
      pct:    windPct?.value           ?? 7.8,
      year:   windPct?.year            ?? 2021,
      source: windPct ? 'World Bank EG.ELC.WIND.ZS' : 'static fallback',
      live:   !!windPct,
    },

    fossil: {
      pct:    fossilPct?.value         ?? 60.8,
      year:   fossilPct?.year          ?? 2021,
      source: fossilPct ? 'World Bank EG.ELC.FOSL.ZS' : 'static fallback',
      live:   !!fossilPct,
    },

    hydro: {
      pct:    hydroPct                 ?? 15.2,
      source: hydroPct != null ? 'derived from World Bank data' : 'static fallback',
      live:   hydroPct != null,
    },

    finalEnergyRenewables: {
      pct:    renewablesFinalPct?.value ?? 18.7,
      year:   renewablesFinalPct?.year  ?? 2021,
      source: renewablesFinalPct ? 'World Bank EG.FEC.RNEW.ZS' : 'static fallback',
      live:   !!renewablesFinalPct,
    },

    // No free real-time API — updated from IEA Global EV Outlook + UNEP annually
    ev: {
      millions:    45,
      marketShare: 22,
      year:        2024,
      source:      'IEA Global EV Outlook 2024',
      live:        false,
    },

    ocean: {
      kTonnes: 82,
      year:    2024,
      source:  'UNEP / The Ocean Cleanup annual report',
      live:    false,
    },
  };

  const liveCount = [solarGW, windGW, renewablesPct, windPct, fossilPct, renewablesFinalPct]
    .filter(Boolean).length;

  // Attach run diagnostics so the admin panel can show what succeeded/failed
  stats.diagnostics = {
    liveCount,
    totalSources: 6,
    errors: [..._fetchErrors],
    ranAt: stats.updatedAt,
  };

  await setStats(stats);
  console.log(`[fetch-stats] Done in ${stats.fetchMs}ms. ${liveCount}/6 live sources. Solar: ${stats.solar.gw}GW, Wind: ${stats.wind.gw}GW, Renewables: ${stats.renewables.pct}%`);
  if (_fetchErrors.length) console.warn(`[fetch-stats] ${_fetchErrors.length} source error(s):`, _fetchErrors);

  // Return a summary so the manual-trigger admin button can show results
  return {
    ok: true,
    liveCount,
    totalSources: 6,
    errors: [..._fetchErrors],
    solar: stats.solar.gw,
    wind:  stats.wind.gw,
    renewables: stats.renewables.pct,
    fetchMs: stats.fetchMs,
  };
}

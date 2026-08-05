// ─────────────────────────────────────────────────────────────────────────────
// store.mjs — thin wrapper around Netlify Blobs
//
// Netlify Blobs is a key-value store built into Netlify. Free tier: 1 GB.
// Docs: https://docs.netlify.com/blobs/overview/
//
// Keys used:
//   config/feeds        → array of feed config objects (set by admin)
//   config/auto-rules   → auto-publish rule settings (set by admin)
//   articles/all        → full deduplicated article array (written by scheduler)
//   articles/by-cat/:cat→ pre-filtered article arrays per category (written by scheduler)
//   meta/last-fetch     → ISO timestamp of last successful fetch
// ─────────────────────────────────────────────────────────────────────────────

import { getStore } from '@netlify/blobs';

// All our data lives in one store named 'renewonomics'
function getDataStore() {
  return getStore({
    name: 'renewonomics',
    // consistency: 'strong' ensures reads after writes return the new value.
    // The default is 'eventual' which is fine for articles but we use strong
    // for config so the scheduler always reads the latest feed list.
    consistency: 'strong',
  });
}

// ── ARTICLES ──────────────────────────────────────────────────────────────────

/** Read the full article list */
export async function getArticles() {
  const store = getDataStore();
  try {
    const data = await store.get('articles/all', { type: 'json' });
    if (!Array.isArray(data)) return [];
    // Defensively re-sort: even though setArticles sorts on write, this
    // guarantees order is correct regardless of when articles were written.
    return data.slice().sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  } catch {
    return [];
  }
}

/** Write the full article list (sorted newest-first, capped at 500) */
export async function setArticles(articles) {
  const store = getDataStore();
  const sorted = articles
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 500);
  await store.setJSON('articles/all', sorted);

  // Also write per-category slices so the feed page can filter without
  // loading all 500 articles. Updated to cover all 12 built-in categories.
  const categories = [
    'solar', 'wind', 'ev', 'storage', 'hydrogen', 'nuclear', 'water',
    'waste', 'bio', 'agri', 'recycling', 'diversified', 'environment', 'jobs', 'policy'
  ];
  await Promise.all(
    categories.map(cat =>
      store.setJSON(
        `articles/by-cat/${cat}`,
        sorted.filter(a => a.category === cat).slice(0, 100)
      )
    )
  );

  return sorted;
}

/** Get articles filtered by category */
export async function getArticlesByCategory(cat) {
  const store = getDataStore();
  try {
    const data = await store.get(`articles/by-cat/${cat}`, { type: 'json' });
    // If the per-cat slice exists AND has content, use it.
    if (Array.isArray(data) && data.length > 0) {
      return data.slice().sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    }
    // Otherwise fall through to filtering the full list. This covers two
    // cases: (1) the per-cat slice was never written (e.g. the category was
    // added after setArticles' last run), and (2) the slice has zero items
    // but the full list might have some via in-memory filtering.
    const all = await getArticles();
    return all.filter(a => a.category === cat);
  } catch {
    const all = await getArticles();
    return all.filter(a => a.category === cat);
  }
}

// ── FEED CONFIG ───────────────────────────────────────────────────────────────

/** Read the feed configuration array */
export async function getFeeds() {
  const store = getDataStore();
  try {
    const data = await store.get('config/feeds', { type: 'json' });
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Write the feed configuration array */
export async function setFeeds(feeds) {
  const store = getDataStore();
  await store.setJSON('config/feeds', feeds);
}

// ── AUTO-PUBLISH RULES ────────────────────────────────────────────────────────

export async function getAutoRules() {
  const store = getDataStore();
  try {
    const data = await store.get('config/auto-rules', { type: 'json' });
    return data || defaultRules();
  } catch {
    return defaultRules();
  }
}

export async function setAutoRules(rules) {
  const store  = getDataStore();
  const merged = { ...defaultRules(), ...rules };
  await store.setJSON('config/auto-rules', merged);
  return merged;
}

function defaultRules() {
  return { mode: 'dedupe', maxPerDay: 50, minWords: 0, dedupeWindow: '24 hours' };
}

// ── STATS ─────────────────────────────────────────────────────────────────────

/** Read the latest global renewable energy stats */
export async function getStats() {
  const store = getDataStore();
  try {
    const data = await store.get('stats/global', { type: 'json' });
    return data || null;
  } catch {
    return null;
  }
}

/** Write the latest global stats */
export async function setStats(stats) {
  const store = getDataStore();
  await store.setJSON('stats/global', stats);
}

// ── META ──────────────────────────────────────────────────────────────────────

export async function getLastFetch() {
  const store = getDataStore();
  try {
    return await store.get('meta/last-fetch', { type: 'text' }) || null;
  } catch {
    return null;
  }
}

export async function setLastFetch(isoString) {
  const store = getDataStore();
  await store.set('meta/last-fetch', isoString);
}

// ── CUSTOM CATEGORIES ─────────────────────────────────────────────────────────
// Users can add their own categories alongside the built-in ones (solar, wind, ev, etc).
// Custom categories get a default teal color/emoji until we add per-category styling.

const BUILT_IN_CATEGORIES = [
  { slug: 'solar',       label: 'Solar',       emoji: '☀️', color: '#f5c542', builtIn: true },
  { slug: 'wind',        label: 'Wind',        emoji: '💨', color: '#4a9bd1', builtIn: true },
  { slug: 'ev',          label: 'EV',          emoji: '⚡', color: '#9b6bf5', builtIn: true },
  { slug: 'storage',     label: 'Storage',     emoji: '🔋', color: '#5fcb6e', builtIn: true },
  { slug: 'hydrogen',    label: 'Hydrogen',    emoji: '⚛️', color: '#7fb8ff', builtIn: true },
  { slug: 'nuclear',     label: 'Nuclear',     emoji: '☢️', color: '#ffd60a', builtIn: true },
  { slug: 'water',       label: 'Water',       emoji: '💧', color: '#3ab0e0', builtIn: true },
  { slug: 'waste',       label: 'Waste',       emoji: '🗑️', color: '#a07f4a', builtIn: true },
  { slug: 'bio',         label: 'Bio',         emoji: '🌱', color: '#7fbf3a', builtIn: true },
  { slug: 'agri',        label: 'Agri',        emoji: '🌾', color: '#d4a83a', builtIn: true },
  { slug: 'recycling',   label: 'Recycling',   emoji: '♻️', color: '#b5e853', builtIn: true },
  { slug: 'diversified', label: 'Diversified', emoji: '🌐', color: '#8dd4c8', builtIn: true },
  { slug: 'environment', label: 'Environment', emoji: '🌍', color: '#5fcb6e', builtIn: true },
  { slug: 'policy',      label: 'Policy',      emoji: '📋', color: '#ff6b6b', builtIn: true },
  { slug: 'jobs',        label: 'Jobs',         emoji: '💼', color: '#b5e853', builtIn: true },
];

/** Read the list of custom (user-added) categories. */
export async function getCustomCategories() {
  const store = getDataStore();
  try {
    const data = await store.get('config/categories', { type: 'json' });
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Write the custom category list. */
export async function setCustomCategories(categories) {
  const store = getDataStore();
  await store.setJSON('config/categories', categories);
}

/** Return ALL categories (built-in + custom), with custom ones appended. */
export async function getAllCategories() {
  const custom = await getCustomCategories();
  return [...BUILT_IN_CATEGORIES, ...custom];
}

/** Built-in slugs are reserved — users can't create a category with these slugs. */
export function isBuiltInCategorySlug(slug) {
  return BUILT_IN_CATEGORIES.some(c => c.slug === (slug || '').toLowerCase());
}

// ── CHAMPIONS (Green Champions page) ──────────────────────────────────────────
// Stored as an array of champion objects. First deploy seeds the 7 hardcoded ones
// so nothing is lost from the original page.

const CHAMPION_SEED = [
  {
    id:        'first-solar',
    name:      'First Solar, Inc.',
    sector:    'Solar',
    cat:       'solar',
    emoji:     '☀️',
    featured:  true,
    rank:      1,
    stripeGrad: 'linear-gradient(135deg,#0a2a1a,#1a7a4a,#2d8a50)',
    tagline:   "Pioneering cadmium telluride thin-film panels — the cleanest solar tech in mass production today.",
    stats: [
      { val: '21GW', lbl: 'Annual Production' },
      { val: '$18B', lbl: 'Market Cap' },
      { val: '90%',  lbl: 'Recyclable Panels' },
    ],
    shortDesc: "First Solar's Series 7 modules use less energy to manufacture than any competitor, while producing more electricity per lifecycle. Their vertically integrated recycling programme recovers 90% of panel materials at end of life.",
    body: [
      "Founded in 1999 and headquartered in Tempe, Arizona, First Solar is the only US-headquartered company in the global top 10 solar manufacturers — and the only one with a genuinely closed-loop recycling programme for its panels.",
      "Their CdTe (cadmium telluride) technology produces panels with a carbon footprint roughly 3x lower than conventional silicon alternatives, largely because the manufacturing process requires far less energy. Each module contains only 0.5% of the tellurium used in a smartphone battery.",
      "In 2025, First Solar commissioned two new gigafactories in the United States under the Inflation Reduction Act, bringing total US manufacturing capacity to 10GW annually — the largest solar manufacturing footprint outside China.",
    ],
    tags: ['☀️ Solar', '♻️ Circular Economy', '🇺🇸 USA', 'Nasdaq: FSLR'],
  },
  {
    id: 'orsted', name: 'Ørsted A/S', sector: 'Wind', cat: 'wind', emoji: '🌬️',
    featured: false, rank: 2,
    stripeGrad: 'linear-gradient(180deg,#0d2a3d,#1a5c80)',
    tagline: "The world's largest offshore wind developer, transforming from oil & gas to 100% renewables.",
    stats: [
      { val: '15GW', lbl: 'Offshore Wind' },
      { val: '86%',  lbl: 'Green Share' },
      { val: '$40B', lbl: 'Market Cap' },
    ],
    shortDesc: '',
    body: [
      "Ørsted completed one of the most dramatic corporate transformations in energy history — pivoting from a fossil fuel company that generated 85% of its energy from coal and gas in 2006, to one that now generates 86% from renewables. The Danish company owns and operates over 15GW of offshore wind capacity across the UK, US, Europe, and Asia-Pacific.",
      "Its Hornsea 3 project off the Yorkshire coast, at 2.85GW, is the world's largest offshore wind farm currently under construction. Ørsted also leads the industry in green hydrogen pilot projects, using surplus offshore wind to electrolyse water at scale.",
    ],
    tags: ['💨 Wind', '🇩🇰 Denmark', 'Copenhagen: ORSTED'],
  },
  {
    id: 'catl', name: 'Contemporary Amperex Technology Co., Limited', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 3,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "The world's largest battery manufacturer — powering a third of all EVs sold globally.",
    stats: [
      { val: '37%',  lbl: 'Global EV Battery Share' },
      { val: '$170B',lbl: 'Market Cap' },
      { val: '500GWh',lbl: 'Annual Capacity' },
    ],
    shortDesc: '',
    body: [
      "Contemporary Amperex Technology Co. Limited (CATL) supplies batteries to Tesla, Volkswagen, BMW, Stellantis, Ford, and dozens of other automakers. The company commands over one-third of the global EV battery market and is pushing the industry toward denser, safer lithium iron phosphate (LFP) chemistries.",
      "In 2024, CATL unveiled a sodium-ion battery breakthrough that could halve EV pack costs by eliminating lithium and cobalt entirely. Their Shenxing battery platform offers 400km range from a 10-minute charge.",
    ],
    tags: ['🔋 Storage', '🇨🇳 China', 'Shenzhen: 300750'],
  },
  {
    id: 'vestas', name: 'Vestas Wind Systems A/S', sector: 'Wind', cat: 'wind', emoji: '🌀',
    featured: false, rank: 4,
    stripeGrad: 'linear-gradient(180deg,#0d2a3d,#1a5c80)',
    tagline: "The world's #1 wind turbine manufacturer — 173GW installed across 88 countries.",
    stats: [
      { val: '173GW',lbl: 'Turbines Installed' },
      { val: '88',   lbl: 'Countries' },
      { val: '$16B', lbl: 'Revenue' },
    ],
    shortDesc: '',
    body: [
      "Danish turbine maker Vestas has installed more onshore and offshore wind capacity than any other company — equivalent to the power output of 173 nuclear reactors. Their V236-15MW offshore turbine is currently the largest in commercial production.",
      "Vestas also runs one of the most ambitious turbine blade recycling programmes in the industry, with a goal of zero-waste blades by 2040.",
    ],
    tags: ['💨 Wind', '🇩🇰 Denmark', 'Copenhagen: VWS'],
  },
  {
    id: 'umicore', name: 'Umicore SA', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 5,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "The world leader in battery recycling — recovering cobalt, nickel, and lithium at industrial scale.",
    stats: [
      { val: '7k',  lbl: 'Tonnes/Year Recycled' },
      { val: '95%', lbl: 'Metal Recovery' },
      { val: '€21B',lbl: 'Revenue' },
    ],
    shortDesc: '',
    body: [
      "Belgian materials giant Umicore operates the largest battery recycling plant in Europe and is scaling aggressively to meet the coming wave of end-of-life EV batteries. Their hydrometallurgical process recovers over 95% of cobalt, nickel, and lithium from spent packs.",
      "Umicore is building a gigafactory-scale recycling plant in Ontario, Canada, expected to process 150,000 EV batteries annually by 2027.",
    ],
    tags: ['♻️ Recycling', '🇧🇪 Belgium', 'Brussels: UMI'],
  },
  {
    id: 'byd', name: 'BYD Company Limited', sector: 'EV + Storage', cat: 'storage', emoji: '🚗',
    featured: false, rank: 6,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "The world's largest EV maker by volume, and a top-3 battery manufacturer.",
    stats: [
      { val: '3.0M', lbl: 'EVs Sold (2024)' },
      { val: '$85B', lbl: 'Market Cap' },
      { val: '15%',  lbl: 'Global EV Share' },
    ],
    shortDesc: '',
    body: [
      "BYD (Build Your Dreams) overtook Tesla in 2023 to become the world's largest electric vehicle maker. Unlike Tesla, BYD produces its own batteries — giving it a cost and supply chain advantage over virtually all competitors.",
      "BYD's Blade Battery uses LFP chemistry with a proprietary cell-to-pack design that delivers 600km range with industry-leading safety. Their Yuan Plus and Seal models are reshaping the affordable EV market globally.",
    ],
    tags: ['🚗 EV', '🔋 Storage', '🇨🇳 China', 'Shenzhen: 002594'],
  },
  {
    id: 'jinko-solar', name: 'JinkoSolar Holding Co., Ltd.', sector: 'Solar', cat: 'solar', emoji: '🌞',
    featured: false, rank: 7,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Global #2 solar panel maker, pushing TOPCon technology into mainstream adoption.",
    stats: [
      { val: '90GW', lbl: 'Annual Shipments' },
      { val: '26.4%',lbl: 'TOPCon Efficiency' },
      { val: '160+', lbl: 'Countries' },
    ],
    shortDesc: '',
    body: [
      "JinkoSolar ships more solar panels than any company outside of China's top 3. Their TOPCon (Tunnel Oxide Passivated Contact) technology now holds the world record for mass-production cell efficiency at 26.4%.",
      "Jinko operates one of the largest vertically integrated solar supply chains in the world, from polysilicon to finished modules. Their Tiger Neo series has become the default choice for utility-scale projects in 2025–2026.",
    ],
    tags: ['☀️ Solar', '🇨🇳 China', 'NYSE: JKS'],
  },

  // ── HYDROGEN ─────────────────────────────────────────────────────────────
  {
    id: 'plug-power', name: 'Plug Power Inc.', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 8,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#001a2e,#003d6b)',
    tagline: "America's largest end-to-end green hydrogen ecosystem builder.",
    stats: [
      { val: '500+', lbl: 'Sites Deployed' },
      { val: '95%', lbl: 'Material Handling' },
      { val: '1GW',  lbl: 'Electrolyser Pipeline' },
    ],
    shortDesc: '',
    body: [
      "Plug Power operates the largest hydrogen fuel-cell deployment in North America, powering forklifts and material-handling fleets at Walmart, Amazon, and Home Depot warehouses. The company is now scaling from end-use to full vertical integration — building green hydrogen production plants across Georgia, Tennessee, New York, and Louisiana.",
      "In 2025 Plug commissioned its 45 ton-per-day green hydrogen plant in Woodbine, Georgia — one of the largest operating green H₂ facilities in the world. Their PEM electrolyser stacks are also sold to third-party customers, including major industrial gas companies.",
    ],
    tags: ['⚛️ Hydrogen', '🇺🇸 USA', 'NASDAQ: PLUG'],
  },
  {
    id: 'linde', name: 'Linde plc', sector: 'Hydrogen', cat: 'hydrogen', emoji: '💨',
    featured: false, rank: 9,
    stripeGrad: 'linear-gradient(135deg,#001423,#003a52)',
    tagline: "World's largest industrial gas company, leading the hydrogen mobility build-out.",
    stats: [
      { val: '$33B', lbl: 'Annual Revenue' },
      { val: '200+', lbl: 'H₂ Production Plants' },
      { val: '100+', lbl: 'Years in Gases' },
    ],
    shortDesc: '',
    body: [
      "Linde produces, transports and dispenses more hydrogen than any company on earth. Through its acquisition of Praxair, it operates over 200 hydrogen plants across the Americas, Europe, and Asia-Pacific — supplying refineries, ammonia producers, and increasingly, fuel cell vehicle networks.",
      "Linde is co-developing the world's largest PEM electrolyser plant with ITM Power in Leuna, Germany, and supplies green hydrogen to Linde's own refining customers as part of their Scope 3 decarbonisation commitments.",
    ],
    tags: ['⚛️ Hydrogen', '🇮🇪 Ireland', 'NYSE: LIN'],
  },
  {
    id: 'air-liquide', name: 'Air Liquide S.A.', sector: 'Hydrogen', cat: 'hydrogen', emoji: '🌬️',
    featured: false, rank: 10,
    stripeGrad: 'linear-gradient(135deg,#0a1f3d,#1e4d8c)',
    tagline: "French industrial gases giant betting €8 billion on the hydrogen economy by 2035.",
    stats: [
      { val: '€8B',  lbl: 'H₂ Investment Plan' },
      { val: '230+', lbl: 'H₂ Stations' },
      { val: '60+',  lbl: 'Countries Operating' },
    ],
    shortDesc: '',
    body: [
      "Air Liquide is one of the founding members of the Hydrogen Council and operates over 230 hydrogen refuelling stations worldwide. The company is building Europe's largest industrial-scale electrolyser at Normandy, France — a 200 MW facility set to produce 28,000 tonnes of green hydrogen per year for ExxonMobil's nearby refinery.",
      "Their Bécancour, Quebec facility is already North America's largest PEM electrolyser, powered entirely by Quebec's hydroelectric grid.",
    ],
    tags: ['⚛️ Hydrogen', '🇫🇷 France', 'EPA: AI'],
  },
  {
    id: 'nel-asa', name: 'Nel ASA', sector: 'Hydrogen', cat: 'hydrogen', emoji: '🔬',
    featured: false, rank: 11,
    stripeGrad: 'linear-gradient(135deg,#0d1f33,#22466e)',
    tagline: "Norwegian electrolyser pioneer, supplying both alkaline and PEM tech worldwide.",
    stats: [
      { val: '1927', lbl: 'Founded' },
      { val: '3,500+',lbl: 'Electrolysers Delivered' },
      { val: '500MW',lbl: 'Annual Capacity' },
    ],
    shortDesc: '',
    body: [
      "Nel is one of the oldest electrolyser manufacturers in the world, with roots tracing back to Norsk Hydro in 1927. The company is now one of only a handful that produces both alkaline (mature, lower-cost) and PEM (faster response, higher purity) electrolyser technology at scale.",
      "Their gigafactory at Herøya, Norway has 500 MW of automated electrolyser production capacity. Major customers include Statkraft, Iberdrola, and Hyundai's hydrogen mobility programme.",
    ],
    tags: ['⚛️ Hydrogen', '🇳🇴 Norway', 'OSE: NEL'],
  },

  // ── WATER ────────────────────────────────────────────────────────────────
  {
    id: 'xylem', name: 'Xylem Inc.', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 12,
    stripeGrad: 'linear-gradient(135deg,#001830,#0066a3)',
    tagline: "Water-tech leader using AI and smart infrastructure to cut municipal water losses worldwide.",
    stats: [
      { val: '$8B+', lbl: 'Annual Revenue' },
      { val: '150+', lbl: 'Countries Served' },
      { val: '23,000',lbl: 'Employees' },
    ],
    shortDesc: '',
    body: [
      "Xylem is the world's largest pure-play water technology company, serving utilities, industries, and agricultural users. Their smart-metering and leak-detection systems help cities reduce non-revenue water losses by up to 30% — a critical lever in water-stressed regions.",
      "Following the merger with Evoqua Water Technologies in 2023, Xylem now offers an end-to-end water cycle portfolio: from treatment and pumping to advanced analytics for asset management.",
    ],
    tags: ['💧 Water', '🇺🇸 USA', 'NYSE: XYL'],
  },
  {
    id: 'veolia', name: 'Veolia Environnement SA', sector: 'Water', cat: 'water', emoji: '🌊',
    featured: false, rank: 13,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#00203d,#005280)',
    tagline: "Global leader in water, waste and energy services — touching 110M people daily.",
    stats: [
      { val: '110M', lbl: 'People Served' },
      { val: '€44B', lbl: 'Annual Revenue' },
      { val: '57',   lbl: 'Countries' },
    ],
    shortDesc: '',
    body: [
      "Veolia is the world's largest provider of water, waste, and energy management services. Following the 2022 acquisition of Suez, the combined entity supplies drinking water to 110 million people and treats wastewater for 97 million more.",
      "Veolia is also a major operator of recycled water and desalination plants — including the Sorek B desalination plant in Israel, one of the world's largest at 200 million cubic metres per year.",
    ],
    tags: ['💧 Water', '🗑️ Waste', '🇫🇷 France', 'EPA: VIE'],
  },

  // ── WASTE ────────────────────────────────────────────────────────────────
  {
    id: 'waste-management', name: 'Waste Management, Inc.', sector: 'Waste', cat: 'waste', emoji: '🗑️',
    featured: false, rank: 14,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#1c2400,#3d5500)',
    tagline: "North America's largest waste services company, converting landfills into renewable energy plants.",
    stats: [
      { val: '$21B', lbl: 'Annual Revenue' },
      { val: '20M+', lbl: 'Customers' },
      { val: '120+', lbl: 'Renewable Gas Sites' },
    ],
    shortDesc: '',
    body: [
      "Waste Management is the largest waste collection and disposal company in North America. Beyond core hauling, the company operates over 120 landfill-gas-to-energy facilities — capturing methane that would otherwise vent to atmosphere and using it to generate electricity or pipeline-quality renewable natural gas.",
      "Through 2027, Waste Management plans to invest $1.4 billion in new RNG facilities, displacing diesel in heavy trucking and natural gas in industrial heat applications.",
    ],
    tags: ['🗑️ Waste', '⚡ Renewable Gas', '🇺🇸 USA', 'NYSE: WM'],
  },
  {
    id: 'republic-services', name: 'Republic Services, Inc.', sector: 'Waste', cat: 'waste', emoji: '♻️',
    featured: false, rank: 15,
    stripeGrad: 'linear-gradient(135deg,#1f2c00,#46620a)',
    tagline: "Second-largest US waste handler, building the country's first integrated plastics recycling complex.",
    stats: [
      { val: '13M',  lbl: 'Customers' },
      { val: '$15B', lbl: 'Annual Revenue' },
      { val: '70+',  lbl: 'Recycling Centers' },
    ],
    shortDesc: '',
    body: [
      "Republic Services operates one of the largest recycling networks in North America, processing over 6 million tons of recyclables annually. Their Polymer Center initiative — with the first facility in Las Vegas — is the country's first vertically integrated plastics recycling complex, producing food-grade recycled PET pellets at scale.",
      "Republic also runs a growing fleet of CNG (compressed natural gas) collection trucks fueled by methane captured at their own landfills.",
    ],
    tags: ['🗑️ Waste', '♻️ Recycling', '🇺🇸 USA', 'NYSE: RSG'],
  },

  // ── BIO (biofuels / bioenergy) ───────────────────────────────────────────
  {
    id: 'praj-industries', name: 'Praj Industries Limited', sector: 'Biofuel', cat: 'bio', emoji: '🌱',
    featured: false, rank: 16,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#0a2400,#1f5a00)',
    tagline: "India's biofuel engineering champion — leading global ethanol, bio-CNG and SAF technology exports.",
    stats: [
      { val: '1,100+', lbl: 'Plants Worldwide' },
      { val: '75+',    lbl: 'Countries' },
      { val: '40+',    lbl: 'Years Experience' },
    ],
    shortDesc: '',
    body: [
      "Praj Industries is the world's largest engineering company focused exclusively on bio-based renewables. Headquartered in Pune, Praj has designed and built over 1,100 ethanol and biofuel plants across 75 countries — making it the dominant supplier in the global ethanol industry.",
      "The company is now leading India's push into Sustainable Aviation Fuel (SAF), having commissioned the country's first commercial SAF demonstration plant. Praj also develops bio-CNG, second-generation cellulosic ethanol, and bio-based chemicals from agricultural waste.",
    ],
    tags: ['🌱 Bio', '⛽ Ethanol', '🇮🇳 India', 'NSE: PRAJIND'],
  },
  {
    id: 'balrampur-chini', name: 'Balrampur Chini Mills Limited', sector: 'Biofuel', cat: 'bio', emoji: '🌾',
    featured: false, rank: 17,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6600)',
    tagline: "India's largest integrated sugar and ethanol producer, anchoring the country's E20 biofuel mandate.",
    stats: [
      { val: '1.05M', lbl: 'Tonnes Sugar/yr' },
      { val: '1.05B', lbl: 'Litres Ethanol/yr' },
      { val: '10',    lbl: 'Manufacturing Units' },
    ],
    shortDesc: '',
    body: [
      "Balrampur Chini is one of India's largest sugar producers and a leading ethanol manufacturer. With 10 integrated mills across Uttar Pradesh, the company has become a key supplier under India's Ethanol Blending Programme, helping the country reach its 20% ethanol blending (E20) target by 2025.",
      "The company is investing heavily in distillery expansion to convert surplus sugar production into fuel-grade ethanol, plus a new PLA (bioplastic) facility — one of India's first commercial bioplastic plants.",
    ],
    tags: ['🌱 Bio', '⛽ Ethanol', '🇮🇳 India', 'NSE: BALRAMCHIN'],
  },

  // ── AGRI (sustainable food / regenerative agriculture) ───────────────────
  {
    id: 'beyond-meat', name: 'Beyond Meat, Inc.', sector: 'Sustainable Food', cat: 'agri', emoji: '🌾',
    featured: false, rank: 18,
    stripeGrad: 'linear-gradient(135deg,#2d1a00,#6b3d00)',
    tagline: "Pioneer of plant-based meat at scale, cutting livestock's vast greenhouse footprint.",
    stats: [
      { val: '90%',  lbl: 'Less GHG vs Beef' },
      { val: '99%',  lbl: 'Less Water' },
      { val: '80+',  lbl: 'Countries' },
    ],
    shortDesc: '',
    body: [
      "Beyond Meat produces plant-based burgers, sausages, and ground meat that match the taste and texture of animal protein, using pea and rice protein bases. According to a Michigan University LCA, a Beyond Burger uses 99% less water, 93% less land, and emits 90% fewer greenhouse gases than a conventional beef burger.",
      "The company partners with major QSR chains globally — including McDonald's (McPlant), Pizza Hut, Starbucks China, and KFC — bringing low-carbon protein into mainstream food culture.",
    ],
    tags: ['🌾 Agri', '🍔 Plant-Based', '🇺🇸 USA', 'NASDAQ: BYND'],
  },
  {
    id: 'indigo-ag', name: 'Indigo Agriculture, Inc.', sector: 'Regenerative Agri', cat: 'agri', emoji: '🌿',
    featured: false, rank: 19,
    stripeGrad: 'linear-gradient(135deg,#0a2d1f,#1f5c3d)',
    tagline: "Soil-health platform paying farmers to capture carbon through regenerative practices.",
    stats: [
      { val: '5M+',  lbl: 'Acres Enrolled' },
      { val: '1M+',  lbl: 'Tonnes CO₂ Captured' },
      { val: '15,000+',lbl: 'Farmers' },
    ],
    shortDesc: '',
    body: [
      "Indigo Ag operates one of the world's largest agricultural carbon programmes — paying farmers per verified tonne of CO₂ captured in their soil through cover cropping, reduced tillage, and crop rotation. Each enrolled acre also benefits from improved water retention and yield resilience.",
      "Indigo's microbial seed treatments — using naturally occurring soil microbes — help crops resist drought and disease without synthetic pesticides, reducing chemical input dependence across millions of acres.",
    ],
    tags: ['🌾 Agri', '🌍 Carbon Markets', '🇺🇸 USA', 'Private'],
  },
  {
    id: 'pivot-bio', name: 'Pivot Bio, Inc.', sector: 'Sustainable Agri', cat: 'agri', emoji: '🌱',
    featured: false, rank: 20,
    stripeGrad: 'linear-gradient(135deg,#0d2400,#264d00)',
    tagline: "Microbial nitrogen fertiliser replacement — eliminating one of agriculture's largest emission sources.",
    stats: [
      { val: '6M+',   lbl: 'Acres Treated' },
      { val: '40lbs', lbl: 'N/acre Replaced' },
      { val: '1B+',   lbl: 'lbs Synthetic N Avoided' },
    ],
    shortDesc: '',
    body: [
      "Pivot Bio engineers naturally occurring soil microbes to deliver nitrogen directly to crop roots — replacing a meaningful portion of synthetic fertiliser. Synthetic nitrogen production is responsible for ~2% of global CO₂ emissions, and runoff causes massive ocean dead zones, so substitution is one of the highest-impact agricultural climate levers.",
      "Their flagship products PROVEN and RETURN are used on millions of acres of US corn, wheat, and sorghum, replacing roughly 40 lbs of synthetic nitrogen per acre with no yield penalty.",
    ],
    tags: ['🌾 Agri', '🌍 Climate', '🇺🇸 USA', 'Private'],
  },
  // ══════════════════════════════════════════════════════════════════════
  // INDIA CHAMPIONS — added by category. Stats shown as "—" are pending
  // verification with current figures before display; descriptions are
  // accurate to each company's business. Fill numbers via admin or update.
  // ══════════════════════════════════════════════════════════════════════

  // ── RECYCLING ──────────────────────────────────────────────────────────
  {
    id: 'gravita-india', name: 'Gravita India Limited', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 21,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "India's largest lead recycler — turning end-of-life batteries into recycled metal at scale.",
    stats: [
      { val: '—', lbl: 'Annual Capacity' },
      { val: '—', lbl: 'Market Cap' },
      { val: '8+', lbl: 'Countries' },
    ],
    shortDesc: "Gravita recycles lead-acid batteries, aluminium, plastic and rubber into recycled raw materials, closing the loop on some of the most polluting waste streams in the economy.",
    body: [
      "Gravita India is one of the country's largest organised recyclers, with operations spanning lead, aluminium, plastic and rubber. Its core business — recycling used lead-acid batteries into pure lead and lead alloys — displaces primary mining, which is far more energy- and emissions-intensive.",
      "Headquartered in Jaipur, Gravita operates recycling plants across India, Africa, and other geographies, and has expanded into aluminium and lithium recycling as EV battery volumes grow. The company is listed on the NSE and BSE.",
    ],
    tags: ['♻️ Recycling', '🔋 Battery Recycling', '🇮🇳 India', 'NSE: GRAVITA'],
  },
  {
    id: 'pondy-oxides', name: 'Pondy Oxides & Chemicals Limited', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 22,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "One of India's leading lead recyclers and metal reprocessors.",
    stats: [
      { val: '—', lbl: 'Annual Capacity' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Revenue' },
    ],
    shortDesc: "Pondy Oxides & Chemicals recycles used lead-acid batteries and metal scrap into refined lead, lead alloys and plastic additives, supplying the battery and chemical industries.",
    body: [
      "Pondy Oxides & Chemicals Limited (POCL) is one of India's largest secondary lead producers, recovering lead from used batteries and scrap rather than primary ore. Its recycled lead feeds the battery manufacturing supply chain, reducing dependence on energy-intensive mining.",
      "The Chennai-headquartered company also produces plastic additives and other metal products, and is listed on the NSE and BSE. Its zinc and aluminium recycling verticals extend its circular-economy footprint.",
    ],
    tags: ['♻️ Recycling', '🔋 Lead Recovery', '🇮🇳 India', 'NSE: POCL'],
  },
  {
    id: 'jain-recycling', name: 'Jain Resource Recycling Limited', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 23,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "Metal and battery recycling supporting India's circular-economy supply chain.",
    stats: [
      { val: '—', lbl: 'Annual Capacity' },
      { val: '—', lbl: 'Facilities' },
      { val: '—', lbl: 'Revenue' },
    ],
    shortDesc: "Jain Recycling processes end-of-life metals and batteries into recovered raw materials, reducing the need for virgin mining inputs.",
    body: [
      "Jain Recycling operates in the secondary metals and battery-recycling space, recovering lead and other metals from end-of-life products for reuse in manufacturing.",
      "Recycling metals such as lead and aluminium consumes a fraction of the energy required to produce them from ore, making organised recyclers an important part of India's decarbonisation and waste-management effort. (Company figures pending verification.)",
    ],
    tags: ['♻️ Recycling', '🔋 Battery Recovery', '🇮🇳 India', 'Private'],
  },

  // ── SOLAR ──────────────────────────────────────────────────────────────
  {
    id: 'acme-solar', name: 'ACME Solar Holdings Limited', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 24,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "One of India's largest solar power producers, building utility-scale generation.",
    stats: [
      { val: '—', lbl: 'Operational Capacity' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Project Pipeline' },
    ],
    shortDesc: "ACME Solar develops, builds and operates large-scale solar power plants across India, and is expanding into hybrid solar-plus-storage and green hydrogen.",
    body: [
      "ACME Solar Holdings is one of India's largest independent solar power producers, with a portfolio of operational and under-construction utility-scale projects. The company sells power under long-term agreements to state and central utilities.",
      "Beyond generation, ACME has announced ambitions in green hydrogen and ammonia, positioning itself across the clean-energy value chain. The company is listed on Indian exchanges. (Capacity and financial figures pending verification.)",
    ],
    tags: ['☀️ Solar', '⚡ Utility Scale', '🇮🇳 India', 'NSE: ACMESOLAR'],
  },
  {
    id: 'emmvee-photovoltaic', name: 'Emmvee Photovoltaic Power Limited', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 25,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Bengaluru-based solar module and cell manufacturer with integrated production.",
    stats: [
      { val: '—', lbl: 'Module Capacity' },
      { val: '—', lbl: 'Cell Capacity' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Emmvee manufactures solar PV modules and cells, and also produces solar water heating systems, serving both domestic and export markets.",
    body: [
      "Emmvee is a Bengaluru-headquartered solar manufacturer producing photovoltaic modules and cells, with vertically integrated operations. It is one of India's established module makers, supplying utility, commercial and residential projects.",
      "The company also has a long-standing solar water-heating business. It has been expanding manufacturing capacity to meet rising domestic demand driven by India's renewable-energy targets. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🏭 Manufacturing', '🇮🇳 India', 'NSE: EMMVEE'],
  },
  {
    id: 'premier-energies', name: 'Premier Energies Limited', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 26,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "India's second-largest integrated solar cell and module manufacturer.",
    stats: [
      { val: '—', lbl: 'Cell Capacity' },
      { val: '—', lbl: 'Module Capacity' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Premier Energies manufactures solar cells and modules with integrated operations, and is one of the few Indian players with significant domestic cell-production capacity.",
    body: [
      "Premier Energies is a Hyderabad-headquartered solar manufacturer and one of India's largest producers of solar cells — a critical, harder-to-localise part of the PV supply chain. Its integrated cell-and-module operations reduce dependence on imports.",
      "The company completed a large, heavily-subscribed IPO and is listed on Indian exchanges. It supplies domestic and international customers and has been expanding capacity aggressively. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🏭 Cells & Modules', '🇮🇳 India', 'NSE: PREMIERENE'],
  },
  {
    id: 'waaree-energies', name: 'Waaree Energies Limited', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: true, rank: 61,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#8b5a00,#b5820a)',
    tagline: "India's largest solar module manufacturer by capacity.",
    stats: [
      { val: '—', lbl: 'Module Capacity' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Export Markets' },
    ],
    shortDesc: "Waaree Energies is India's largest solar PV module manufacturer, with a significant share of domestic production and a growing export presence, particularly to the US.",
    body: [
      "Waaree Energies is India's largest manufacturer of solar PV modules by installed capacity, headquartered in Mumbai. Its scale makes it a cornerstone of India's push to build a domestic solar supply chain and reduce reliance on Chinese imports.",
      "The company completed one of India's most anticipated IPOs and is listed on the NSE and BSE. It has been expanding into solar cells and US-based manufacturing to serve export demand. (Capacity and financial figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🏭 #1 Module Maker', '🇮🇳 India', 'NSE: WAAREEENER'],
  },
  {
    id: 'vikram-solar', name: 'Vikram Solar Limited', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 27,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Established solar module manufacturer and EPC solutions provider.",
    stats: [
      { val: '—', lbl: 'Module Capacity' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Global Presence' },
    ],
    shortDesc: "Vikram Solar manufactures high-efficiency solar PV modules and provides engineering, procurement and construction (EPC) services for solar projects.",
    body: [
      "Vikram Solar is a Kolkata-headquartered solar module manufacturer and EPC provider, and one of India's long-established PV producers with a presence in domestic and international markets.",
      "The company has been expanding module manufacturing capacity and moving toward integrated cell production to align with India's domestic-content requirements. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🏭 Modules & EPC', '🇮🇳 India', 'NSE: VIKRAMSOLR'],
  },
  {
    id: 'borosil-renewables', name: 'Borosil Renewables Limited', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 28,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "India's first and only solar-glass manufacturer — a critical PV supply-chain input.",
    stats: [
      { val: '—', lbl: 'Glass Capacity' },
      { val: 'Only', lbl: 'Indian Solar-Glass Maker' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Borosil Renewables is India's first manufacturer of solar-grade tempered glass — the protective front layer every solar module needs — reducing import dependence for a key component.",
    body: [
      "Borosil Renewables is India's first and, for a long period, only manufacturer of solar glass — the low-iron tempered glass used as the front cover of PV modules. This localises a critical component that would otherwise be imported.",
      "As India scales domestic module manufacturing, demand for locally made solar glass grows in step. The company is listed on Indian exchanges and has been expanding furnace capacity. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🪟 Solar Glass', '🇮🇳 India', 'NSE: BORORENEW'],
  },

  // ── STORAGE ────────────────────────────────────────────────────────────
  {
    id: 'hbl-engineering', name: 'HBL Engineering Limited', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 29,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "Specialised battery and electronics manufacturer for industrial and defence use.",
    stats: [
      { val: '—', lbl: 'Battery Types' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "HBL Engineering (formerly HBL Power Systems) makes specialised batteries — including nickel-cadmium, lithium and industrial cells — plus defence electronics and railway signalling systems.",
    body: [
      "HBL Engineering, formerly HBL Power Systems, is a Hyderabad-headquartered manufacturer of specialised batteries and electronic systems. Its product range spans industrial batteries, defence and aviation cells, and railway signalling equipment.",
      "The company is positioned to benefit from India's push into advanced battery chemistries and rail-safety systems (such as Kavach). It is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🛡️ Defence & Rail', '🇮🇳 India', 'NSE: HBLENGINE'],
  },
  {
    id: 'pace-digitek', name: 'Pace Digitek Limited', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 30,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "Energy storage and telecom-infrastructure solutions provider.",
    stats: [
      { val: '—', lbl: 'BESS Capacity' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Projects' },
    ],
    shortDesc: "Pace Digitek works in battery energy storage systems (BESS) and telecom/power infrastructure, supporting grid-scale storage deployment in India.",
    body: [
      "Pace Digitek operates in energy storage and infrastructure, including battery energy storage systems (BESS) that help integrate intermittent renewable generation into the grid.",
      "Grid-scale storage is one of the fastest-growing segments of India's clean-energy build-out, as solar and wind require firming to deliver round-the-clock power. (Company figures pending verification.)",
    ],
    tags: ['🔋 Storage', '⚡ Grid BESS', '🇮🇳 India', 'NSE: PACEDIGITK'],
  },
  {
    id: 'amara-raja-mobility', name: 'Amara Raja Energy & Mobility Limited', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 31,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "One of India's two largest battery makers, moving into lithium-ion and EV cells.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Lithium Gigafactory' },
      { val: 'Amaron', lbl: 'Flagship Brand' },
    ],
    shortDesc: "Amara Raja Energy & Mobility (maker of Amaron batteries) is one of India's largest lead-acid battery manufacturers and is investing heavily in lithium-ion cell and gigafactory capacity.",
    body: [
      "Amara Raja Energy & Mobility, best known for the Amaron battery brand, is one of India's two dominant automotive and industrial battery makers. It supplies OEMs, telecom, and the aftermarket.",
      "The company is building lithium-ion cell manufacturing and a gigafactory to serve the EV transition, moving beyond its lead-acid heritage. It is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🔌 Li-ion Gigafactory', '🇮🇳 India', 'NSE: ARE&M'],
  },
  {
    id: 'exide-industries', name: 'Exide Industries Limited', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 32,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "India's largest battery manufacturer, building a lithium-ion gigafactory.",
    stats: [
      { val: '#1', lbl: 'Indian Battery Maker' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Li-ion Capacity' },
    ],
    shortDesc: "Exide Industries is India's largest storage battery manufacturer, and is building one of the country's first large lithium-ion cell gigafactories to serve the EV and storage markets.",
    body: [
      "Exide Industries is India's largest manufacturer of lead-acid storage batteries, supplying automotive, industrial and inverter markets nationwide for decades.",
      "To capture the EV transition, Exide is investing in a multi-gigawatt lithium-ion cell gigafactory in Karnataka — one of India's most significant moves toward domestic advanced-battery manufacturing. The company is listed on the NSE and BSE. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🔌 Li-ion Gigafactory', '🇮🇳 India', 'NSE: EXIDEIND'],
  },

  // ── WIND ───────────────────────────────────────────────────────────────
  {
    id: 'suzlon-energy', name: 'Suzlon Energy Limited', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: true, rank: 62,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80,#2478a8)',
    tagline: "India's largest wind turbine manufacturer, with a global installed fleet.",
    stats: [
      { val: '—', lbl: 'Installed Capacity' },
      { val: '—', lbl: 'Countries' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Suzlon Energy is India's largest wind-turbine maker and one of the world's most experienced, with turbines installed across India and internationally.",
    body: [
      "Suzlon Energy is India's largest and one of the world's leading wind turbine manufacturers, headquartered in Pune. It designs, builds, installs and services turbines and provides end-to-end wind project solutions.",
      "After a major debt restructuring, Suzlon has returned to growth on the back of India's renewed wind-energy push and a large order book. It is listed on the NSE and BSE. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '🏭 #1 Indian Turbine Maker', '🇮🇳 India', 'NSE: SUZLON'],
  },
  {
    id: 'inox-wind', name: 'Inox Wind Limited', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 33,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "Integrated wind-energy solutions provider and turbine manufacturer.",
    stats: [
      { val: '—', lbl: 'Turbine Capacity' },
      { val: '—', lbl: 'Order Book' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Inox Wind manufactures wind turbine generators and provides turnkey wind project solutions, part of the larger INOXGFL group.",
    body: [
      "Inox Wind is a major Indian wind-turbine manufacturer offering integrated solutions — from turbine supply to project commissioning and O&M services. It operates manufacturing plants for key turbine components.",
      "The company has benefited from India's shift to competitive wind auctions and a strong order pipeline. It is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '🏭 Turbines & EPC', '🇮🇳 India', 'NSE: INOXWIND'],
  },

  // ── HYDROGEN ───────────────────────────────────────────────────────────
  {
    id: 'thermax', name: 'Thermax Limited', sector: 'Hydrogen & Energy', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 34,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "Energy and environment engineering major moving into green hydrogen.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Green H₂ Projects' },
    ],
    shortDesc: "Thermax provides energy, environment and chemical engineering solutions — boilers, heating, cooling, water and air-pollution control — and is expanding into green hydrogen and electrolysers.",
    body: [
      "Thermax is a Pune-headquartered engineering company serving industrial energy and environment needs, from clean heating and cooling to water treatment and emissions control.",
      "The company has entered green hydrogen through electrolyser development and integrated clean-energy projects, positioning itself for industrial decarbonisation. It is listed on the NSE and BSE. (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '🏭 Industrial Decarb', '🇮🇳 India', 'NSE: THERMAX'],
  },

  // ── BIO / BIOFUELS ─────────────────────────────────────────────────────
  {
    id: 'trualt-bioenergy', name: 'TruAlt Bioenergy Limited', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 36,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b00)',
    tagline: "One of India's largest ethanol producers, supporting fuel-blending targets.",
    stats: [
      { val: '—', lbl: 'Ethanol Capacity' },
      { val: '—', lbl: 'Plants' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "TruAlt Bioenergy produces ethanol and other biofuels at scale, supplying India's ethanol-blended petrol programme and expanding into compressed biogas.",
    body: [
      "TruAlt Bioenergy is among India's largest ethanol producers, supplying the national ethanol-blending programme that aims to cut petroleum imports and reduce vehicle emissions.",
      "The company is expanding into second-generation ethanol and compressed biogas (CBG), broadening its biofuel portfolio. (Company figures pending verification.)",
    ],
    tags: ['🌱 Bio', '⛽ Ethanol & CBG', '🇮🇳 India', 'Private'],
  },
  {
    id: 'godawari-biorefineries', name: 'Godavari Biorefineries Limited', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 37,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b00)',
    tagline: "Integrated bio-refinery producing ethanol, sugar and bio-based chemicals.",
    stats: [
      { val: '—', lbl: 'Ethanol Capacity' },
      { val: '—', lbl: 'Bio-products' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Godawari Biorefineries converts sugarcane into ethanol, sugar, power and bio-based chemicals, including renewable feedstocks for the chemical industry.",
    body: [
      "Godawari Biorefineries is an integrated bio-refinery producing ethanol, sugar, and a range of bio-based chemicals derived from sugarcane — substituting fossil-derived inputs across fuel and chemicals.",
      "Its ethanol supports India's fuel-blending programme, while its bio-chemicals business supplies greener alternatives to petrochemicals. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '⚗️ Bio-chemicals', '🇮🇳 India', 'NSE: GODAWARIB'],
  },

  // ── NUCLEAR ────────────────────────────────────────────────────────────
  {
    id: 'ntpc-bhel', name: 'NTPC–BHEL (Nuclear)', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 38,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "State power and heavy-engineering majors partnering on India's nuclear expansion.",
    stats: [
      { val: '—', lbl: 'Nuclear Pipeline' },
      { val: '—', lbl: 'Combined Cap' },
      { val: '—', lbl: 'Partnership' },
    ],
    shortDesc: "NTPC (India's largest power producer) and BHEL (its largest power-equipment maker) are expanding into nuclear generation, a key low-carbon baseload source for India's grid.",
    body: [
      "NTPC, India's largest power generator, and BHEL, its largest power-equipment manufacturer, are both central to India's ambition to significantly expand nuclear capacity as a clean baseload complement to solar and wind.",
      "NTPC has established dedicated nuclear ventures and partnerships, while BHEL manufactures reactor and turbine equipment. Both are listed public-sector enterprises. (Specific figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '⚡ Baseload', '🇮🇳 India', 'NSE: NTPC · BHEL'],
  },
  {
    id: 'hcc', name: 'Hindustan Construction Company Limited', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 39,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "India's leading builder of nuclear power plants and hydro infrastructure.",
    stats: [
      { val: '—', lbl: 'Nuclear Plants Built' },
      { val: '—', lbl: 'Order Book' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Hindustan Construction Company has built a large share of India's nuclear power plants and major hydroelectric and infrastructure projects.",
    body: [
      "Hindustan Construction Company (HCC) is one of India's foremost infrastructure builders and has constructed a significant portion of the country's nuclear power capacity, along with large hydroelectric projects, tunnels, dams and bridges.",
      "As India expands nuclear and pumped-hydro storage for a low-carbon grid, specialised heavy-civil builders like HCC are critical. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '🏗️ Heavy Civil', '🇮🇳 India', 'NSE: HCC'],
  },
  {
    id: 'mtar-technologies', name: 'MTAR Technologies Limited', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 40,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "Precision engineering for nuclear, space, defence and clean-energy sectors.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Sectors Served' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "MTAR Technologies manufactures precision components for nuclear reactors, space and defence programmes, and clean-energy applications including hydrogen fuel cells.",
    body: [
      "MTAR Technologies is a Hyderabad-based precision-engineering company supplying critical components for India's nuclear power programme, space missions (ISRO), and defence systems.",
      "It has diversified into clean energy, manufacturing components for hydrogen fuel cells and electrolysers. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '🚀 Precision Eng', '🇮🇳 India', 'NSE: MTARTECH'],
  },

  // ── AGRI ───────────────────────────────────────────────────────────────
  {
    id: 'upl-limited', name: 'UPL Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 41,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "One of the world's largest agrochemical and sustainable-agriculture companies.",
    stats: [
      { val: '—', lbl: 'Countries' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Revenue' },
    ],
    shortDesc: "UPL is a global agri-solutions major offering crop protection, seeds, and increasingly biosolutions and sustainable inputs to farmers across the world.",
    body: [
      "UPL Limited is one of the world's largest agricultural-solutions companies, providing crop-protection products, seeds and post-harvest solutions to farmers in over a hundred countries.",
      "The company has been growing its biosolutions and sustainable-agriculture portfolio — biological inputs that reduce chemical load and support soil health. It is listed on the NSE and BSE. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🌍 Global Agri', '🇮🇳 India', 'NSE: UPL'],
  },
  {
    id: 'godrej-agrovet', name: 'Godrej Agrovet Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 42,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Diversified agribusiness spanning animal feed, crop protection and palm oil.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Business Lines' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Godrej Agrovet is a diversified agribusiness active in animal feed, crop protection, oil palm, dairy and poultry — improving farm productivity across India.",
    body: [
      "Godrej Agrovet is one of India's leading diversified agribusinesses, with operations across animal feed, crop protection, oil palm plantations, dairy and processed foods.",
      "Its scale in animal nutrition and sustainable oil-palm cultivation supports food security and farm incomes. The company is part of the Godrej group and listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🐄 Feed & Agri', '🇮🇳 India', 'NSE: GODREJAGRO'],
  },
  {
    id: 'dehaat', name: 'Green Agrevolution Private Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 43,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Agritech platform giving farmers end-to-end access to inputs, advice and markets.",
    stats: [
      { val: '—', lbl: 'Farmers Served' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Funding' },
    ],
    shortDesc: "DeHaat is one of India's largest agritech startups, offering farmers a full-stack platform for quality inputs, crop advisory, financing and market linkage.",
    body: [
      "DeHaat operates a technology platform connecting smallholder farmers to agricultural inputs, personalised crop advisory, credit, and buyers for their produce — improving yields and incomes.",
      "By aggregating demand and digitising the rural supply chain, DeHaat reduces waste and inefficiency in Indian agriculture. It is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '📱 Agritech', '🇮🇳 India', 'Private'],
  },
  {
    id: 'ninjacart', name: 'Ninjacart Private Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 44,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Agri supply-chain platform connecting farmers directly to retailers.",
    stats: [
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Cities' },
      { val: '—', lbl: 'Funding' },
    ],
    shortDesc: "Ninjacart runs a technology-driven fresh-produce supply chain that links farmers directly with retailers and businesses, cutting waste and middlemen.",
    body: [
      "Ninjacart is one of India's largest agri-supply-chain startups, using technology and logistics to move fresh produce from farmers to retailers and restaurants quickly and efficiently.",
      "Shortening the farm-to-retail chain reduces the very high spoilage rates in Indian fresh produce, improving both farmer realisation and food-system efficiency. It is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🚚 Supply Chain', '🇮🇳 India', 'Private'],
  },
  {
    id: 'kaveri-seeds', name: 'Kaveri Seed Company Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 45,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Leading Indian hybrid-seed developer improving crop yields and resilience.",
    stats: [
      { val: '—', lbl: 'Seed Portfolio' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Kaveri Seed develops and markets high-yield hybrid seeds for crops including cotton, maize, rice and vegetables, helping raise farm productivity.",
    body: [
      "Kaveri Seed Company is one of India's leading private seed producers, developing hybrid seeds that improve yield, pest resistance and climate resilience across major crops.",
      "Higher-yielding, more resilient seed varieties are a foundational lever for food security and reduced land pressure. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🌱 Hybrid Seeds', '🇮🇳 India', 'NSE: KSCL'],
  },

  // ── WATER ──────────────────────────────────────────────────────────────
  {
    id: 'ion-exchange', name: 'Ion Exchange (India) Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 46,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "One of India's oldest and largest water and environment solutions companies.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Countries' },
    ],
    shortDesc: "Ion Exchange provides water and wastewater treatment across industrial, municipal and home segments — including resins, plants, and zero-liquid-discharge systems.",
    body: [
      "Ion Exchange (India) is a pioneer in water and environment management, offering treatment for drinking water, industrial process water, wastewater recycling and zero-liquid-discharge systems.",
      "As water scarcity and industrial-effluent norms tighten across India, demand for treatment and reuse solutions grows. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '♻️ Treatment & Reuse', '🇮🇳 India', 'NSE: IONEXCHANG'],
  },
  {
    id: 'ems-limited', name: 'EMS Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 47,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Water and wastewater infrastructure builder for municipal projects.",
    stats: [
      { val: '—', lbl: 'Order Book' },
      { val: '—', lbl: 'Projects' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "EMS Limited builds sewerage, water-supply and wastewater-treatment infrastructure, largely for government and municipal clients.",
    body: [
      "EMS Limited is a water and wastewater infrastructure company executing sewerage networks, water-supply schemes and treatment plants, primarily under government contracts.",
      "Municipal water and sanitation infrastructure is central to public health and to reducing untreated-sewage pollution of rivers. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🏗️ Infrastructure', '🇮🇳 India', 'NSE: EMSLIMITED'],
  },
  {
    id: 'va-tech-wabag', name: 'VA Tech Wabag Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 48,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Global water-technology multinational headquartered in India.",
    stats: [
      { val: '—', lbl: 'Countries' },
      { val: '—', lbl: 'Plants Delivered' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "VA Tech Wabag is a leading pure-play water-technology company delivering desalination, water and wastewater treatment plants across the world.",
    body: [
      "VA Tech Wabag is an Indian-headquartered multinational focused entirely on water — designing and building desalination, drinking-water and wastewater-treatment plants across Asia, Africa, the Middle East and Europe.",
      "With water stress rising globally, Wabag's desalination and reuse technology addresses one of the defining resource challenges of the century. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🌊 Desalination', '🇮🇳 India', 'NSE: WABAG'],
  },
  {
    id: 'denta-water', name: 'Denta Water and Infra Solutions Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 49,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Water-management and groundwater-recharge infrastructure specialist.",
    stats: [
      { val: '—', lbl: 'Projects' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Denta Water & Infra Solutions specialises in water-management projects, including groundwater recharge and canal/irrigation infrastructure.",
    body: [
      "Denta Water & Infra Solutions focuses on water-management infrastructure, including groundwater recharge, borewell recharge and irrigation projects that improve water availability and security.",
      "Groundwater depletion is a critical issue across much of India, making recharge and efficient-use infrastructure increasingly important. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '💦 Groundwater Recharge', '🇮🇳 India', 'NSE: DENTA'],
  },
  {
    id: 'enviro-infra', name: 'Enviro Infra Engineers Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 50,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Water and wastewater treatment plant builder for municipal and industrial clients.",
    stats: [
      { val: '—', lbl: 'Plants Built' },
      { val: '—', lbl: 'Order Book' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Enviro Infra Engineers designs and builds water-supply schemes and sewage/effluent treatment plants, including zero-liquid-discharge systems.",
    body: [
      "Enviro Infra Engineers builds water and wastewater treatment infrastructure — water-supply projects, sewage-treatment plants and common effluent-treatment plants — mostly for government and industrial clients.",
      "Treating and reusing wastewater reduces freshwater demand and river pollution, key priorities under India's clean-rivers and sanitation missions. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '♻️ Treatment Plants', '🇮🇳 India', 'NSE: EIEL'],
  },

  // ── EV (Electric Vehicles / Mobility) ──────────────────────────────────
  {
    id: 'tata-motors-cv', name: 'Tata Motors Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 51,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Tata's commercial-vehicle arm electrifying buses and trucks.",
    stats: [
      { val: '—', lbl: 'EV Models' },
      { val: '—', lbl: 'E-buses Deployed' },
      { val: '—', lbl: 'Market Position' },
    ],
    shortDesc: "Tata Motors Commercial Vehicles (TMCV) builds electric buses and is developing electric trucks, decarbonising India's heavy-transport and public-transit fleets.",
    body: [
      "Tata Motors Commercial Vehicles is India's largest commercial-vehicle maker and a leader in electric buses, which are transforming urban public transport in cities across the country.",
      "Electrifying buses and freight is one of the highest-impact transport levers, given their high daily mileage and diesel consumption. Following Tata Motors' October 2025 demerger, the commercial-vehicle business now trades independently under the Tata Motors Limited name, separate from the passenger-vehicle and Jaguar Land Rover business. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🚌 E-buses & Trucks', '🇮🇳 India', 'NSE: TATAMOTORS'],
  },
  {
    id: 'tata-motors-pv', name: 'Tata Motors Passenger Vehicles Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: true, rank: 63,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#5a1a9a,#7a2ac0)',
    tagline: "India's leading electric passenger-car maker.",
    stats: [
      { val: '#1', lbl: 'Indian EV Car Maker' },
      { val: '—', lbl: 'EV Models' },
      { val: '—', lbl: 'EV Market Share' },
    ],
    shortDesc: "Tata Motors Passenger Vehicles (TMPV) dominates India's electric passenger-car market with models like the Nexon EV, Tiago EV and Punch EV.",
    body: [
      "Tata Motors Passenger Vehicles is the clear leader in India's electric passenger-car market, having brought EVs into the mainstream with accessible models such as the Nexon EV, Tiago EV and Punch EV.",
      "By pricing EVs within reach of mass-market buyers, TMPV has done more than any other company to kickstart India's personal-EV transition. Following Tata Motors' October 2025 demerger, TMPV — which also holds the Jaguar Land Rover business — trades as its own independently listed entity, separate from the commercial-vehicle business that now carries the Tata Motors Limited name. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🚗 #1 EV Cars', '🇮🇳 India', 'NSE: TMPV'],
  },
  {
    id: 'mahindra', name: 'Mahindra & Mahindra Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 52,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Auto and farm-equipment major scaling electric SUVs.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'EV SUV Range' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Mahindra & Mahindra is a leading Indian automaker rolling out a dedicated electric-SUV lineup (the BE and XUV.e range), alongside its tractor and farm-equipment leadership.",
    body: [
      "Mahindra & Mahindra is one of India's largest automotive and farm-equipment companies, and the world's largest tractor manufacturer by volume. It is investing heavily in a born-electric SUV platform.",
      "Its dedicated EV lineup targets the fast-growing premium electric-SUV segment, while its farm-equipment arm supports agricultural productivity. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🚙 Electric SUVs', '🇮🇳 India', 'NSE: M&M'],
  },
  {
    id: 'ather-energy', name: 'Ather Energy Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 53,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Premium electric-scooter maker and fast-charging network pioneer.",
    stats: [
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Chargers Deployed' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Ather Energy designs premium electric scooters and operates the Ather Grid fast-charging network, and is one of India's most vertically integrated EV two-wheeler makers.",
    body: [
      "Ather Energy is a Bengaluru-based electric-scooter manufacturer known for its performance-focused, software-rich two-wheelers and its Ather Grid public fast-charging network.",
      "Two-wheelers are India's highest-volume vehicle category, so electrifying them is one of the country's biggest emissions and oil-import levers. Ather is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🛵 E-scooters', '🇮🇳 India', 'NSE: ATHERENERG'],
  },
  {
    id: 'ola-electric', name: 'Ola Electric Mobility Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 54,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "High-volume electric-scooter maker building domestic cell manufacturing.",
    stats: [
      { val: '—', lbl: 'Market Share' },
      { val: '—', lbl: 'Gigafactory' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Ola Electric is one of India's largest electric two-wheeler makers by volume, and is building in-house lithium-ion cell manufacturing to localise its supply chain.",
    body: [
      "Ola Electric is a leading Indian electric two-wheeler manufacturer that rapidly scaled to a large share of the e-scooter market, selling through an online-first model.",
      "The company is building a lithium-ion cell gigafactory to localise battery production — the highest-value part of the EV supply chain. It is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🛵 E-scooters', '🇮🇳 India', 'NSE: OLAELEC'],
  },
  {
    id: 'hero-motocorp', name: 'Hero MotoCorp Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 55,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "World's largest two-wheeler maker, electrifying through its Vida brand.",
    stats: [
      { val: '#1', lbl: 'Global 2W Maker' },
      { val: '—', lbl: 'EV Brand: Vida' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Hero MotoCorp, the world's largest two-wheeler manufacturer by volume, is entering electric mobility through its Vida brand of electric scooters.",
    body: [
      "Hero MotoCorp is the world's largest manufacturer of motorcycles and scooters by volume, headquartered in India. Its sheer scale means its electrification directly affects millions of vehicles.",
      "The company's Vida electric-scooter brand marks its entry into EVs, backed by its enormous distribution and service network. Hero is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🏍️ Vida E-scooters', '🇮🇳 India', 'NSE: HEROMOTOCO'],
  },
  {
    id: 'bajaj-auto', name: 'Bajaj Auto Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 56,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Two- and three-wheeler major electrifying with Chetak and e-autos.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'EV Range' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Bajaj Auto, a leading two- and three-wheeler maker and major exporter, is electrifying through the Chetak electric scooter and electric three-wheelers.",
    body: [
      "Bajaj Auto is one of India's largest two- and three-wheeler manufacturers and a major global exporter. Its electric Chetak scooter and electric three-wheelers extend its long heritage into clean mobility.",
      "Electric three-wheelers are especially impactful in India, where they serve as high-utilisation last-mile transport. Bajaj is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🛺 E-2W & E-3W', '🇮🇳 India', 'NSE: BAJAJ-AUTO'],
  },
  {
    id: 'tvs-motor', name: 'TVS Motor Company Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 57,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Two-wheeler major scaling EVs with the iQube and electric three-wheelers.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'EV: iQube' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "TVS Motor is a leading Indian two-wheeler maker whose electric iQube scooter is among the market leaders, with electric three-wheelers also in its lineup.",
    body: [
      "TVS Motor Company is one of India's largest two-wheeler manufacturers, and its electric iQube scooter has become one of the best-selling e-scooters in the country.",
      "TVS is expanding across electric two- and three-wheelers and investing in EV R&D and manufacturing. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🛵 iQube', '🇮🇳 India', 'NSE: TVSMOTOR'],
  },
  {
    id: 'olectra-greentech', name: 'Olectra Greentech Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 58,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "India's largest electric-bus manufacturer.",
    stats: [
      { val: '—', lbl: 'E-buses Delivered' },
      { val: '—', lbl: 'Order Book' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Olectra Greentech is one of India's largest electric-bus manufacturers, supplying state transport undertakings, and also produces composite insulators.",
    body: [
      "Olectra Greentech is a leading Indian electric-bus maker, delivering e-buses to state transport corporations and helping electrify public transit in major cities.",
      "Electric buses replace some of the highest-mileage, highest-emitting diesel vehicles on the road, making them a high-impact segment. Olectra is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🚌 #1 E-buses', '🇮🇳 India', 'NSE: OLECTRA'],
  },
  {
    id: 'jbm-auto', name: 'JBM Auto Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 59,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Electric-bus and auto-components maker with integrated e-mobility solutions.",
    stats: [
      { val: '—', lbl: 'E-buses' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "JBM Auto manufactures electric buses and auto components, offering integrated e-mobility solutions including charging infrastructure.",
    body: [
      "JBM Auto is an Indian manufacturer of electric buses and automotive components, providing end-to-end e-mobility solutions spanning vehicles, charging and even solar power for depots.",
      "Its integrated model — buses plus charging plus energy — positions it for large public-transit electrification contracts. JBM Auto is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🚌 E-buses & Components', '🇮🇳 India', 'NSE: JBMA'],
  },

  // ── WASTE ──────────────────────────────────────────────────────────────
  {
    id: 'antony-waste', name: 'Antony Waste Handling Cell Limited', sector: 'Waste', cat: 'waste', emoji: '🗑️',
    featured: false, rank: 60,
    stripeGrad: 'linear-gradient(135deg,#2a2010,#5c4a2a)',
    tagline: "One of India's largest municipal solid-waste management companies.",
    stats: [
      { val: '—', lbl: 'Waste Handled/Day' },
      { val: '—', lbl: 'Cities Served' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Antony Waste Handling Cell provides municipal solid-waste collection, transport, processing and waste-to-energy services for Indian cities.",
    body: [
      "Antony Waste Handling Cell is one of India's largest municipal solid-waste management companies, handling collection, transportation, mechanised sweeping, processing and disposal for urban local bodies.",
      "Proper waste processing — including waste-to-energy and material recovery — cuts methane emissions from landfills and reduces pollution. The company is listed on Indian exchanges. (Figures pending verification.)",
    ],
    tags: ['🗑️ Waste', '♻️ Municipal Waste', '🇮🇳 India', 'NSE: AWHCL'],
  },
  // ══════════════════════════════════════════════════════════════════════
  // CHINA 🇨🇳 & USA 🇺🇸 CHAMPIONS. Stats shown as "—" pending verification of
  // current figures; descriptions are accurate to each company's business.
  // ══════════════════════════════════════════════════════════════════════

  // ── SOLAR ──────────────────────────────────────────────────────────────
  {
    id: 'longi-green', name: 'LONGi Green Energy Technology Co., Ltd.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: true, rank: 64,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#8b5a00,#b5820a)',
    tagline: "The world's largest solar manufacturer by value, and a monocrystalline pioneer.",
    stats: [
      { val: '—', lbl: 'Module Shipments' },
      { val: '—', lbl: 'Market Cap' },
      { val: '#1', lbl: 'Global Solar (by value)' },
    ],
    shortDesc: "LONGi is the world's largest solar technology company, pioneering monocrystalline silicon wafers, cells and modules, and holding multiple cell-efficiency world records.",
    body: [
      "LONGi Green Energy Technology is the world's most valuable solar company and the leading maker of monocrystalline silicon products — the wafers, cells and modules that dominate today's solar market. Its scale helped drive the industry-wide shift from multicrystalline to higher-efficiency mono technology.",
      "The Xi'an-headquartered company repeatedly sets cell-efficiency world records and is investing in next-generation tandem and hydrogen technologies. It is listed on the Shanghai Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🏭 #1 Global', '🇨🇳 China', 'SHA: 601012'],
  },
  {
    id: 'trina-solar', name: 'Trina Solar Co., Ltd.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 65,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "One of the world's largest solar module makers and smart-energy providers.",
    stats: [
      { val: '—', lbl: 'Module Shipments' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Trina Solar is a top-tier global solar module manufacturer that also provides trackers, storage and smart-energy solutions worldwide.",
    body: [
      "Trina Solar is one of the world's largest solar PV module manufacturers and an early cumulative-shipment leader. It has diversified into trackers, energy storage and integrated smart-energy solutions.",
      "The company holds several efficiency and output world records for large-format modules and is listed on the Shanghai STAR market. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🏭 Modules & Storage', '🇨🇳 China', 'SHA: 688599'],
  },
  {
    id: 'ja-solar', name: 'JA Solar Technology Co., Ltd.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 66,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "A leading global manufacturer of high-performance solar cells and modules.",
    stats: [
      { val: '—', lbl: 'Module Shipments' },
      { val: '—', lbl: 'Countries Served' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "JA Solar is one of the world's largest vertically integrated solar manufacturers, producing silicon wafers, cells and modules for markets across the globe.",
    body: [
      "JA Solar is a major vertically integrated solar manufacturer, spanning wafers, cells and modules, and consistently ranks among the top global module suppliers by shipments.",
      "The company supplies utility, commercial and residential projects across more than a hundred countries and is listed on the Shenzhen Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🏭 Integrated', '🇨🇳 China', 'SHE: 002459'],
  },
  {
    id: 'sungrow', name: 'Sungrow Power Supply Co., Ltd.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 67,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "The world's largest solar inverter manufacturer, and a major storage supplier.",
    stats: [
      { val: '#1', lbl: 'Global Inverters' },
      { val: '—', lbl: 'Storage Shipped' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Sungrow is the world's largest supplier of solar inverters — the devices that convert panel DC into grid-ready AC — and a leading provider of battery storage systems.",
    body: [
      "Sungrow Power Supply is the world's largest manufacturer of PV inverters, a critical piece of equipment in every solar installation. It also ranks among the top global suppliers of grid-scale energy-storage systems.",
      "The Hefei-based company's inverter and storage technology underpins solar deployments worldwide. It is listed on the Shenzhen Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '⚡ #1 Inverters', '🇨🇳 China', 'SHE: 300274'],
  },
  {
    id: 'sunrun', name: 'Sunrun, Inc.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 68,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "The largest residential solar and home-battery provider in the United States.",
    stats: [
      { val: '#1', lbl: 'US Residential Solar' },
      { val: '—', lbl: 'Customers' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Sunrun is America's largest residential solar company, installing rooftop solar and home batteries through a subscription model that lets households go solar with no upfront cost.",
    body: [
      "Sunrun is the leading provider of residential solar and battery storage in the United States, pioneering the solar-as-a-service subscription model that removed the upfront cost barrier for homeowners.",
      "Its growing fleet of home batteries increasingly functions as virtual power plants that support the grid during peak demand. Sunrun is listed on the Nasdaq. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🏠 #1 US Residential', '🇺🇸 USA', 'NASDAQ: RUN'],
  },
  {
    id: 'nextracker', name: 'Nextpower Inc.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 69,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "The world's leading maker of solar trackers for utility-scale plants.",
    stats: [
      { val: '#1', lbl: 'Global Solar Trackers' },
      { val: '—', lbl: 'GW Shipped' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Nextracker builds the smart tracking systems that tilt solar panels to follow the sun, boosting energy yield at utility-scale solar farms worldwide.",
    body: [
      "Nextracker is the global market leader in solar trackers — the motorised mounting systems that rotate panels to follow the sun across the sky, increasing a plant's energy output by a significant margin versus fixed mounts.",
      "Its software-driven trackers optimise for terrain and weather at some of the world's largest solar farms. The California-based company is listed on the Nasdaq. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🔆 #1 Trackers', '🇺🇸 USA', 'NASDAQ: NXT'],
  },
  {
    id: 'enphase', name: 'Enphase Energy, Inc.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 70,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Pioneer of solar microinverters and integrated home-energy systems.",
    stats: [
      { val: '—', lbl: 'Microinverters Shipped' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Countries' },
    ],
    shortDesc: "Enphase makes microinverters that optimise each solar panel individually, plus integrated home batteries and energy-management software for residential solar.",
    body: [
      "Enphase Energy pioneered the microinverter — a small inverter attached to each individual solar panel, improving reliability and per-panel performance compared with a single central inverter.",
      "The company has expanded into home batteries, EV charging and energy-management software, building an integrated home-energy platform. It is listed on the Nasdaq. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🔌 Microinverters', '🇺🇸 USA', 'NASDAQ: ENPH'],
  },

  // ── WIND ───────────────────────────────────────────────────────────────
  {
    id: 'goldwind', name: 'Goldwind Science & Technology Co., Ltd.', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: true, rank: 71,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80,#2478a8)',
    tagline: "The world's largest wind turbine manufacturer by installed capacity.",
    stats: [
      { val: '#1', lbl: 'Global Wind Turbines' },
      { val: '—', lbl: 'Installed Capacity' },
      { val: '—', lbl: 'Countries' },
    ],
    shortDesc: "Xinjiang Goldwind is the world's largest wind turbine maker, known for its direct-drive permanent-magnet technology and a vast global installed fleet.",
    body: [
      "Goldwind is the world's largest manufacturer of wind turbines by annual installed capacity, and a pioneer of gearless direct-drive permanent-magnet turbine technology, which reduces maintenance and improves reliability.",
      "The company supplies onshore and offshore turbines across China and international markets. It is listed in Shenzhen and Hong Kong. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '🏭 #1 Global', '🇨🇳 China', 'SHE: 002202'],
  },
  {
    id: 'mingyang', name: 'Ming Yang Smart Energy Group Limited', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 72,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "A leading offshore wind turbine maker building some of the world's largest turbines.",
    stats: [
      { val: '—', lbl: 'Largest Turbine' },
      { val: '—', lbl: 'Installed Capacity' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Mingyang Smart Energy specialises in large offshore wind turbines, including some of the biggest-capacity machines in the world, plus hybrid renewable solutions.",
    body: [
      "Mingyang Smart Energy is a leading Chinese wind turbine manufacturer that has pushed the frontier of offshore turbine size, unveiling some of the world's largest-capacity offshore machines.",
      "Larger turbines capture more energy per foundation, lowering the cost of offshore wind. The company is listed on the Shanghai Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '🌊 Offshore Giants', '🇨🇳 China', 'SHA: 601615'],
  },
  {
    id: 'ge-vernova', name: 'GE Vernova Inc.', sector: 'Wind & Grid', cat: 'wind', emoji: '💨',
    featured: false, rank: 73,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "GE's energy spinoff — wind turbines, grid equipment and power technology.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Wind Installed' },
      { val: '—', lbl: 'Grid Share' },
    ],
    shortDesc: "GE Vernova is General Electric's dedicated energy company, spanning onshore and offshore wind turbines, grid transmission equipment, and gas and nuclear power technology.",
    body: [
      "GE Vernova is the energy business spun off from General Electric, combining onshore and offshore wind, grid and electrification equipment, and gas and nuclear power technology under one company focused on the energy transition.",
      "Its grid segment is a major global supplier of the transformers and high-voltage equipment needed to connect renewables. GE Vernova is listed on the NYSE. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '🔌 Grid & Power', '🇺🇸 USA', 'NYSE: GEV'],
  },

  // ── EV (Electric Vehicles) ─────────────────────────────────────────────
  {
    id: 'tesla', name: 'Tesla, Inc.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: true, rank: 74,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#5a1a9a,#7a2ac0)',
    tagline: "The company that made electric cars mainstream — plus solar and grid storage.",
    stats: [
      { val: '—', lbl: 'Vehicles Delivered' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Storage Deployed' },
    ],
    shortDesc: "Tesla is the world's most valuable automaker, a pioneer of mass-market electric vehicles, and — through Tesla Energy — a major supplier of solar and grid-scale battery storage.",
    body: [
      "Tesla transformed the automobile industry by proving electric vehicles could be desirable, high-performance and mass-produced, forcing legacy automakers worldwide to accelerate their own EV programmes.",
      "Beyond cars, Tesla Energy is a significant player in solar and grid-scale storage, with its Megapack battery systems deployed at utility scale globally. Tesla is listed on the Nasdaq. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🔋 + Energy Storage', '🇺🇸 USA', 'NASDAQ: TSLA'],
  },
  {
    id: 'nio', name: 'NIO Inc.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 75,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Premium Chinese EV maker known for battery-swap technology.",
    stats: [
      { val: '—', lbl: 'Vehicles Delivered' },
      { val: '—', lbl: 'Swap Stations' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "NIO is a premium Chinese electric-vehicle maker best known for its battery-swap network, which lets drivers exchange a depleted battery for a full one in minutes instead of charging.",
    body: [
      "NIO is a leading premium Chinese EV manufacturer, differentiated by its battery-swap model — automated stations that replace a depleted pack with a charged one in minutes, sidestepping charging wait times.",
      "Battery-as-a-service also lowers the upfront cost of its vehicles. NIO is listed on the NYSE, Hong Kong and Singapore exchanges. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🔄 Battery Swap', '🇨🇳 China', 'NYSE: NIO'],
  },
  {
    id: 'xpeng', name: 'XPeng Inc.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 76,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Tech-focused Chinese EV maker investing in autonomous driving.",
    stats: [
      { val: '—', lbl: 'Vehicles Delivered' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "XPeng is a Chinese smart-EV manufacturer focused on in-house autonomous-driving technology and software-defined vehicles, and is exploring flying cars and robotics.",
    body: [
      "XPeng is a technology-driven Chinese EV maker that develops its own advanced driver-assistance and autonomous-driving software, positioning itself as a smart-mobility company rather than just a carmaker.",
      "It is also investing in eVTOL flying vehicles and robotics. XPeng is listed on the NYSE and Hong Kong exchange. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🤖 Autonomous', '🇨🇳 China', 'NYSE: XPEV'],
  },
  {
    id: 'li-auto', name: 'Li Auto Inc.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 77,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Chinese EV maker that popularised extended-range electric SUVs.",
    stats: [
      { val: '—', lbl: 'Vehicles Delivered' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Li Auto is a Chinese EV manufacturer that found early success with extended-range electric SUVs — battery-electric vehicles with a small onboard generator to eliminate range anxiety — and is expanding into pure EVs.",
    body: [
      "Li Auto built its early lead with extended-range electric vehicles (EREVs), which pair a battery with a small petrol generator that charges it on the go, addressing range anxiety in markets with sparse charging.",
      "The company is now expanding its pure battery-electric lineup and charging network. Li Auto is listed on the Nasdaq and Hong Kong exchange. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🚙 Range-Extended', '🇨🇳 China', 'NASDAQ: LI'],
  },
  {
    id: 'rivian', name: 'Rivian Automotive, Inc.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 78,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "American maker of electric trucks, SUVs and commercial delivery vans.",
    stats: [
      { val: '—', lbl: 'Vehicles Delivered' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Rivian is a US electric-vehicle maker focused on adventure-oriented electric trucks and SUVs, and electric delivery vans, with a large commercial-van programme.",
    body: [
      "Rivian is an American EV manufacturer specialising in electric pickup trucks and SUVs built for the outdoors, along with electric commercial delivery vans developed initially for a major e-commerce fleet.",
      "It targets segments — trucks and vans — that are high-emitting and were slower to electrify. Rivian is listed on the Nasdaq. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🛻 Trucks & Vans', '🇺🇸 USA', 'NASDAQ: RIVN'],
  },
  {
    id: 'lucid', name: 'Lucid Group, Inc.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 79,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "US maker of long-range luxury electric vehicles with class-leading efficiency.",
    stats: [
      { val: '—', lbl: 'Range Record' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Lucid Motors builds luxury electric vehicles renowned for industry-leading range and powertrain efficiency, and licenses its EV technology to other manufacturers.",
    body: [
      "Lucid Motors is a US luxury EV maker whose flagship sedan set records for electric range, thanks to a highly efficient in-house powertrain that squeezes more miles from each kilowatt-hour.",
      "Lucid also supplies its advanced EV technology to other automakers. The company is listed on the Nasdaq. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🏎️ Long-Range Luxury', '🇺🇸 USA', 'NASDAQ: LCID'],
  },
  {
    id: 'chargepoint', name: 'ChargePoint Holdings, Inc.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 80,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "One of the largest EV charging networks in North America and Europe.",
    stats: [
      { val: '—', lbl: 'Charging Ports' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "ChargePoint operates one of the largest EV charging networks, providing charging hardware and software for homes, businesses and fleets across North America and Europe.",
    body: [
      "ChargePoint runs one of the largest networks of EV charging points, selling charging hardware and the cloud software that manages it to businesses, fleets and drivers.",
      "Charging infrastructure is the essential enabler of EV adoption, and ChargePoint is a key builder of it. The company is listed on the NYSE. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🔌 Charging Network', '🇺🇸 USA', 'NYSE: CHPT'],
  },

  // ── STORAGE ────────────────────────────────────────────────────────────
  {
    id: 'eve-energy', name: 'EVE Energy Co., Ltd.', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 81,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "Major Chinese lithium battery maker for EVs and energy storage.",
    stats: [
      { val: '—', lbl: 'Cell Capacity' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "EVE Energy is a leading Chinese manufacturer of lithium batteries, supplying cells for electric vehicles, grid-scale storage and consumer applications.",
    body: [
      "EVE Energy is one of China's larger battery manufacturers, producing lithium-ion and lithium-iron-phosphate cells for EVs, energy storage systems and consumer electronics.",
      "As grid storage scales globally, large low-cost cell makers like EVE are central to bringing down storage costs. The company is listed on the Shenzhen Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🔌 Li-ion Cells', '🇨🇳 China', 'SHE: 300014'],
  },
  {
    id: 'fluence', name: 'Fluence Energy, Inc.', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 82,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "A global leader in grid-scale battery storage systems and software.",
    stats: [
      { val: '—', lbl: 'Storage Deployed' },
      { val: '—', lbl: 'Countries' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Fluence provides grid-scale energy storage products and AI-driven trading software, helping utilities integrate renewables and stabilise power grids worldwide.",
    body: [
      "Fluence Energy, originally a joint venture of Siemens and AES, is a leading global supplier of grid-scale battery energy storage systems and the software that optimises how stored energy is dispatched and traded.",
      "Grid storage is the linchpin of a high-renewables grid, smoothing solar and wind intermittency. Fluence is listed on the Nasdaq. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '⚡ Grid-Scale', '🇺🇸 USA', 'NASDAQ: FLNC'],
  },
  {
    id: 'form-energy', name: 'Form Energy, Inc.', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 83,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "Developer of iron-air batteries for multi-day, low-cost grid storage.",
    stats: [
      { val: '100h', lbl: 'Discharge Duration' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Funding' },
    ],
    shortDesc: "Form Energy is building iron-air batteries that store energy for up to 100 hours at a fraction of lithium's cost, targeting the multi-day storage gap that renewables need.",
    body: [
      "Form Energy is developing iron-air battery technology designed to deliver up to 100 hours of storage — far longer than lithium-ion's typical few hours — using cheap, abundant iron rather than scarce critical minerals.",
      "Multi-day storage is one of the hardest unsolved problems for a fully renewable grid, needed to bridge long spells of low sun and wind. Form Energy is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '⏳ Multi-Day (Iron-Air)', '🇺🇸 USA', 'Private'],
  },
  {
    id: 'quantumscape', name: 'QuantumScape Corporation', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 84,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "Developer of solid-state batteries for longer-range, faster-charging EVs.",
    stats: [
      { val: '—', lbl: 'Technology' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "QuantumScape is developing solid-state lithium-metal batteries that promise greater range, faster charging and improved safety compared with today's lithium-ion cells.",
    body: [
      "QuantumScape is pioneering solid-state battery technology, replacing the flammable liquid electrolyte in conventional lithium-ion cells with a solid ceramic separator to enable higher energy density, faster charging and better safety.",
      "If commercialised at scale, solid-state batteries could be a step-change for EV range and charging. The company is listed on the NYSE. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🔬 Solid-State', '🇺🇸 USA', 'NYSE: QS'],
  },

  // ── HYDROGEN ───────────────────────────────────────────────────────────
  {
    id: 'bloom-energy', name: 'Bloom Energy Corporation', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 85,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "Maker of solid-oxide fuel cells and electrolysers for clean power and hydrogen.",
    stats: [
      { val: '—', lbl: 'Fuel Cells Deployed' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Bloom Energy makes solid-oxide fuel cells that generate on-site electricity, and solid-oxide electrolysers that produce clean hydrogen efficiently.",
    body: [
      "Bloom Energy manufactures solid-oxide fuel cells (its 'Energy Servers') that generate electricity on-site from natural gas, biogas or hydrogen with high efficiency and low emissions, giving data centres and factories resilient power.",
      "Its solid-oxide electrolysers can also produce hydrogen more efficiently than conventional methods when paired with heat. Bloom is listed on the NYSE. (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '🔋 Fuel Cells', '🇺🇸 USA', 'NYSE: BE'],
  },
  {
    id: 'air-products', name: 'Air Products and Chemicals, Inc.', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 86,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "Global industrial-gas major and one of the largest hydrogen producers.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'H₂ Projects' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Air Products is one of the world's largest industrial-gas companies and hydrogen producers, and is investing in mega-scale green and blue hydrogen projects.",
    body: [
      "Air Products is a leading global industrial-gas company and one of the largest producers and distributors of hydrogen, long used in refining and chemicals.",
      "It is now backing some of the world's largest green- and blue-hydrogen mega-projects, aiming to supply clean hydrogen for transport and industry. The company is listed on the NYSE. (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '🏭 Industrial Gas', '🇺🇸 USA', 'NYSE: APD'],
  },

  // ── NUCLEAR ────────────────────────────────────────────────────────────
  {
    id: 'constellation', name: 'Constellation Energy Corporation', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 87,
    isFocus: true,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "The largest producer of carbon-free nuclear power in the United States.",
    stats: [
      { val: '#1', lbl: 'US Nuclear Fleet' },
      { val: '—', lbl: 'Clean Output' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Constellation Energy operates the largest fleet of nuclear reactors in the US, making it the country's biggest producer of carbon-free electricity.",
    body: [
      "Constellation Energy is the largest operator of nuclear power plants in the United States and the nation's biggest producer of emissions-free electricity, supplying reliable baseload power that complements variable renewables.",
      "It has signed landmark clean-power deals with large data-centre customers and is working to extend and even restart reactor capacity. Constellation is listed on the Nasdaq. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '⚡ #1 US Clean Power', '🇺🇸 USA', 'NASDAQ: CEG'],
  },
  {
    id: 'nuscale', name: 'NuScale Power Corporation', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 88,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "Developer of small modular reactors (SMRs) for flexible clean power.",
    stats: [
      { val: 'SMR', lbl: 'Reactor Type' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "NuScale Power develops small modular reactors — factory-built, scalable nuclear units designed to be cheaper and faster to deploy than conventional large plants.",
    body: [
      "NuScale Power is a leading developer of small modular reactors (SMRs), compact factory-manufactured nuclear units that can be added incrementally, potentially lowering the cost and construction risk that have plagued large nuclear projects.",
      "Its design was among the first SMRs to receive US regulatory approval. NuScale is listed on the NYSE. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '🔬 Small Modular Reactors', '🇺🇸 USA', 'NYSE: SMR'],
  },
  {
    id: 'cgn-power', name: 'CGN Power Co., Ltd.', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 89,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "China's largest nuclear power operator.",
    stats: [
      { val: '#1', lbl: 'China Nuclear' },
      { val: '—', lbl: 'Reactors' },
      { val: '—', lbl: 'Capacity' },
    ],
    shortDesc: "China General Nuclear (CGN) Power is China's largest nuclear power producer, operating a large fleet of reactors as part of the country's clean-baseload expansion.",
    body: [
      "CGN Power, the listed arm of China General Nuclear, operates the largest fleet of nuclear reactors in China — the country building more new nuclear capacity than any other.",
      "Nuclear provides steady carbon-free baseload that supports China's enormous renewable build-out. CGN Power is listed in Hong Kong and Shanghai. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '⚡ #1 China', '🇨🇳 China', 'HK: 1816'],
  },

  // ── WASTE ──────────────────────────────────────────────────────────────
  {
    id: 'everbright-env', name: 'China Everbright Environment Group Limited', sector: 'Waste', cat: 'waste', emoji: '🗑️',
    featured: false, rank: 90,
    stripeGrad: 'linear-gradient(135deg,#2a2010,#5c4a2a)',
    tagline: "One of the world's largest waste-to-energy operators.",
    stats: [
      { val: '—', lbl: 'WtE Capacity' },
      { val: '—', lbl: 'Projects' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "China Everbright Environment is one of the world's largest waste-to-energy companies, converting municipal solid waste into electricity while reducing landfill.",
    body: [
      "China Everbright Environment is among the world's largest operators of waste-to-energy plants, which incinerate municipal solid waste to generate electricity, cutting both landfill volume and the methane emissions that rotting waste produces.",
      "The company also operates water treatment and other environmental infrastructure. It is listed in Hong Kong. (Figures pending verification.)",
    ],
    tags: ['🗑️ Waste', '♻️ Waste-to-Energy', '🇨🇳 China', 'HK: 0257'],
  },

  // ── RECYCLING ──────────────────────────────────────────────────────────
  {
    id: 'redwood-materials', name: 'Redwood Materials, Inc.', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 91,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "US battery-recycling and materials company closing the EV battery loop.",
    stats: [
      { val: '—', lbl: 'Recovery Rate' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Funding' },
    ],
    shortDesc: "Redwood Materials recycles end-of-life batteries and manufacturing scrap into battery-grade materials, aiming to build a domestic US supply chain for cathode and anode components.",
    body: [
      "Redwood Materials, founded by a Tesla co-founder, recycles lithium-ion batteries and manufacturing scrap, recovering the lithium, nickel, cobalt and copper inside and remanufacturing them into new battery components.",
      "By closing the loop, it aims to reduce mining demand and localise the US battery supply chain. Redwood is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['♻️ Recycling', '🔋 Battery Loop', '🇺🇸 USA', 'Private'],
  },
  {
    id: 'gem-co', name: 'GEM Co., Ltd.', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 92,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "One of China's largest battery and electronic-waste recyclers.",
    stats: [
      { val: '—', lbl: 'Recycling Capacity' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "GEM Co. is a major Chinese recycler of used batteries and electronic waste, recovering cobalt, nickel and other materials and remanufacturing battery precursors.",
    body: [
      "GEM Co. is one of China's largest recyclers of spent batteries and electronic waste, recovering critical metals like cobalt and nickel and turning them into precursor materials for new batteries.",
      "With China dominating global battery production, domestic recyclers like GEM are increasingly important to the material supply chain. GEM is listed on the Shenzhen Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['♻️ Recycling', '🔋 Battery & E-waste', '🇨🇳 China', 'SHE: 002340'],
  },

  // ── WATER ──────────────────────────────────────────────────────────────
  {
    id: 'ecolab', name: 'Ecolab Inc.', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 93,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Global leader in water treatment, hygiene and industrial water efficiency.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Water Saved' },
      { val: '—', lbl: 'Countries' },
    ],
    shortDesc: "Ecolab provides water, hygiene and infection-prevention solutions to industry, helping customers dramatically cut water use and reuse water in their operations.",
    body: [
      "Ecolab is a global leader in water, hygiene and industrial process solutions, helping factories, hospitals, hotels and data centres use far less water through treatment, monitoring and reuse technology.",
      "Industrial water efficiency is a major, often overlooked lever for conserving freshwater. Ecolab is listed on the NYSE. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🏭 Industrial Efficiency', '🇺🇸 USA', 'NYSE: ECL'],
  },
  {
    id: 'beijing-water', name: 'Beijing Enterprises Water', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 94,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "One of China's largest water and wastewater treatment operators.",
    stats: [
      { val: '—', lbl: 'Treatment Capacity' },
      { val: '—', lbl: 'Projects' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "Beijing Enterprises Water Group builds and operates water and wastewater treatment plants across China and beyond, tackling large-scale water pollution and reuse.",
    body: [
      "Beijing Enterprises Water Group is one of China's largest water utilities, designing, building and operating sewage- and water-treatment plants that address the country's severe water-pollution and scarcity challenges.",
      "Its treatment and reuse infrastructure is central to cleaning up China's rivers and stretching limited freshwater. The company is listed in Hong Kong. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '♻️ Treatment & Reuse', '🇨🇳 China', 'HK: 0371'],
  },

  // ── BIO ────────────────────────────────────────────────────────────────
  {
    id: 'lanzatech', name: 'LanzaTech Global, Inc.', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 95,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b00)',
    tagline: "Carbon-recycling company turning industrial emissions into fuels and chemicals.",
    stats: [
      { val: '—', lbl: 'Carbon Recycled' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Market Cap' },
    ],
    shortDesc: "LanzaTech uses engineered microbes to ferment waste carbon — industrial off-gases and CO — into ethanol and chemicals, recycling emissions that would otherwise be released.",
    body: [
      "LanzaTech has developed a biological process in which engineered microbes consume carbon-rich industrial waste gases (like those from steel mills) and ferment them into ethanol and other chemicals — effectively recycling carbon that would otherwise be emitted.",
      "The ethanol can be upgraded into sustainable aviation fuel and consumer products. LanzaTech is listed on the Nasdaq. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '♻️ Carbon Recycling', '🇺🇸 USA', 'NASDAQ: LNZA'],
  },
  {
    id: 'gevo', name: 'Gevo, Inc.', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 96,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b00)',
    tagline: "Producer of sustainable aviation fuel and low-carbon renewable fuels.",
    stats: [
      { val: 'SAF', lbl: 'Core Product' },
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Gevo produces sustainable aviation fuel and other renewable hydrocarbons from plant sugars, targeting hard-to-electrify sectors like aviation.",
    body: [
      "Gevo makes sustainable aviation fuel (SAF) and other drop-in renewable fuels from plant-based feedstocks, aiming to decarbonise aviation and heavy transport that can't easily switch to batteries.",
      "SAF is one of the few near-term options for cutting aviation emissions. Gevo is listed on the Nasdaq. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '✈️ Aviation Fuel', '🇺🇸 USA', 'NASDAQ: GEVO'],
  },

  // ── AGRI ───────────────────────────────────────────────────────────────
  {
    id: 'deere', name: 'Deere & Company', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 97,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Farm-equipment giant leading precision and autonomous agriculture.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Precision Acres' },
    ],
    shortDesc: "Deere & Company (John Deere) is the world's largest farm-machinery maker, pioneering precision agriculture, GPS-guided and autonomous equipment that cut inputs and boost yields.",
    body: [
      "John Deere is the world's largest agricultural-equipment manufacturer, increasingly a technology company — its precision-agriculture systems use GPS, sensors and AI to apply seed, water and chemicals exactly where needed, reducing waste and emissions.",
      "It has introduced fully autonomous tractors and see-and-spray systems that cut herbicide use dramatically. Deere is listed on the NYSE. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🚜 Precision Farming', '🇺🇸 USA', 'NYSE: DE'],
  },
  {
    id: 'corteva', name: 'Corteva, Inc.', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 98,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Global seed and crop-protection company advancing sustainable agriculture.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Countries' },
      { val: '—', lbl: 'R&D Pipeline' },
    ],
    shortDesc: "Corteva Agriscience is a leading global pure-play agriculture company providing seeds, crop protection and biologicals that raise yields while reducing environmental impact.",
    body: [
      "Corteva Agriscience is one of the world's largest agricultural-input companies, developing improved seeds, crop-protection products and increasingly biological solutions that help farmers grow more with fewer resources.",
      "Higher-yield, more resilient crops reduce the land and inputs needed per unit of food. Corteva is listed on the NYSE. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🌱 Seeds & Biologicals', '🇺🇸 USA', 'NYSE: CTVA'],
  },
  // ══════════════════════════════════════════════════════════════════════
  // INDIA 🇮🇳 & SOUTHEAST ASIA STARTUPS — isStartup:true renders with the
  // light-green card variant + 🚀 Startup badge (see champions.html CSS).
  // Stats shown as "—" pending verification.
  // ══════════════════════════════════════════════════════════════════════

  // ── STORAGE ────────────────────────────────────────────────────────────
  {
    id: 'log9-materials', name: 'Log9 Materials Scientific Private Limited', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 99, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "Indian deep-tech startup building fast-charging and aluminium-fuel battery cells.",
    stats: [
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Cell Capacity' },
    ],
    shortDesc: "Log9 Materials develops fast-charging lithium-titanate battery cells and aluminium-fuel cell technology, targeting EV and industrial applications that need rapid charging or long range.",
    body: [
      "Log9 Materials is a Bengaluru-based deep-tech startup manufacturing battery cells in-house, with a focus on fast-charging chemistries (LTO) that can charge in minutes rather than hours — useful for commercial EVs with tight duty cycles.",
      "It has also developed aluminium-fuel cell technology as a range-extending backup power source. Log9 is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '⚡ Fast-Charging Cells', '🇮🇳 India', 'Private'],
  },
  {
    id: 'battery-smart', name: 'Upgrid Solutions Private Limited', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 100, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "India's largest battery-swapping network for electric two- and three-wheelers.",
    stats: [
      { val: '—', lbl: 'Swap Stations' },
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Battery Smart operates a battery-swapping network that lets electric-rickshaw and two-wheeler drivers exchange a depleted battery for a charged one in seconds, removing charging downtime for commercial EV fleets.",
    body: [
      "Battery Smart runs one of India's largest battery-swapping networks, aimed at the drivers of electric three-wheelers and two-wheelers who need to stay on the road all day and can't afford lengthy charging stops.",
      "By decoupling the vehicle from the battery, swapping also lowers the upfront cost of the vehicle itself. Battery Smart is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🔄 Battery Swapping', '🇮🇳 India', 'Private'],
  },

  // ── EV ──────────────────────────────────────────────────────────────────
  {
    id: 'euler-motors', name: 'Euler Motors Private Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 101, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Indian startup building electric commercial three-wheelers for last-mile logistics.",
    stats: [
      { val: '—', lbl: 'Vehicles Deployed' },
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Euler Motors manufactures electric three-wheeler cargo vehicles purpose-built for high-utilisation last-mile delivery and logistics fleets.",
    body: [
      "Euler Motors designs and manufactures electric three-wheeler commercial vehicles aimed squarely at India's booming e-commerce and logistics delivery fleets, which run high daily mileage and are natural early adopters of EVs.",
      "The company also runs its own charging and service network to support fleet uptime. Euler Motors is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🛺 Commercial 3-Wheelers', '🇮🇳 India', 'Private'],
  },
  {
    id: 'yulu', name: 'Yulu Bikes Private Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 102, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Shared electric micro-mobility startup for Indian cities.",
    stats: [
      { val: '—', lbl: 'Cities' },
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Yulu operates a shared electric-scooter and moped fleet across Indian cities, offering short point-to-point rides as an alternative to short car and auto-rickshaw trips.",
    body: [
      "Yulu runs a dockless shared electric micro-mobility service, with fleets of small electric vehicles ('Yulu bikes') that riders can rent for short urban trips via an app, aimed at cutting short-distance fossil-fuel journeys.",
      "The company has also partnered with delivery platforms to electrify last-mile delivery fleets. Yulu is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🛵 Shared Micro-Mobility', '🇮🇳 India', 'Private'],
  },
  {
    id: 'zypp-electric', name: 'Zypp Electric Fleetech Private Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 103, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Electric-vehicle-as-a-service fleet for last-mile delivery riders.",
    stats: [
      { val: '—', lbl: 'Delivery Riders' },
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Zypp Electric leases electric scooters to gig-economy delivery riders, bundling the vehicle, charging and swappable batteries as a subscription service.",
    body: [
      "Zypp Electric provides electric two-wheelers to delivery riders on a rental/subscription basis, removing the upfront cost barrier that keeps gig workers on petrol scooters, and supports its fleet with a battery-swapping network.",
      "Its model targets the fast-growing quick-commerce and food-delivery sector, one of urban India's highest-mileage vehicle segments. Zypp is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '📦 Delivery Fleet-as-a-Service', '🇮🇳 India', 'Private'],
  },

  // ── HYDROGEN ───────────────────────────────────────────────────────────
  {
    id: 'newtrace', name: 'Newtrace', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 104, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "Indian deep-tech startup building low-cost electrolysers for green hydrogen.",
    stats: [
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Electrolyser Type' },
    ],
    shortDesc: "Newtrace designs electrolyser technology aimed at lowering the cost of producing green hydrogen, using catalyst innovations to reduce dependence on scarce precious metals.",
    body: [
      "Newtrace is an Indian green-hydrogen startup developing next-generation electrolyser stacks that use catalysts free of scarce precious metals, aiming to bring down the cost of splitting water into hydrogen at scale.",
      "Lowering electrolyser cost is one of the biggest levers for making green hydrogen price-competitive with fossil-based hydrogen. Newtrace is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '🔬 Electrolysers', '🇮🇳 India', 'Private'],
  },

  // ── WATER ──────────────────────────────────────────────────────────────
  {
    id: 'uravu-labs', name: 'Uravu Labs Private Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 105, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Indian startup harvesting drinking water from air using solar thermal energy.",
    stats: [
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Technology' },
    ],
    shortDesc: "Uravu Labs builds atmospheric water-generation systems that extract drinking water from humidity in the air, powered by solar thermal energy rather than grid electricity.",
    body: [
      "Uravu Labs has developed a solar-thermal atmospheric water-generation technology that condenses water vapour from ambient air into potable water — a decentralised alternative for water-stressed and off-grid communities.",
      "Because it runs on solar heat rather than the electricity-hungry refrigeration used by most atmospheric water generators, it targets a lower cost per litre. Uravu is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '☀️ Solar Atmospheric Water', '🇮🇳 India', 'Private'],
  },

  // ── RECYCLING ──────────────────────────────────────────────────────────
  {
    id: 'recykal', name: 'Recykal', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 106, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "India's largest circular-economy marketplace connecting waste generators to recyclers.",
    stats: [
      { val: '—', lbl: 'Waste Processed' },
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Recykal operates a digital marketplace and traceability platform that connects waste generators, waste-collectors and recyclers, formalising India's largely informal recycling supply chain.",
    body: [
      "Recykal runs a technology marketplace for the circular economy — matching businesses that generate waste (plastic, e-waste, batteries) with certified recyclers, while providing digital traceability for extended-producer-responsibility compliance.",
      "By formalising and digitising waste flows, it aims to improve recycling rates and transparency across India's fragmented waste sector. Recykal is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['♻️ Recycling', '📱 Circular Marketplace', '🇮🇳 India', 'Private'],
  },
  {
    id: 'attero-recycling', name: 'Attero Recycling', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 107, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "Indian e-waste and lithium-battery recycling startup recovering critical minerals.",
    stats: [
      { val: '—', lbl: 'Recovery Rate' },
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Attero Recycling processes e-waste and end-of-life lithium-ion batteries to recover critical minerals like lithium, cobalt and nickel for reuse in new batteries.",
    body: [
      "Attero Recycling is one of India's earliest movers in electronic-waste and lithium-battery recycling, extracting critical minerals that would otherwise be lost to landfill and feeding them back into battery manufacturing.",
      "As India's EV battery volumes rise, domestic recycling capacity for these minerals becomes increasingly strategic. Attero is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['♻️ Recycling', '🔋 Battery & E-waste', '🇮🇳 India', 'Private'],
  },

  // ── WASTE ──────────────────────────────────────────────────────────────
  {
    id: 'saahas-zero-waste', name: 'Saahas Waste Management Private Limited', sector: 'Waste', cat: 'waste', emoji: '🗑️',
    featured: false, rank: 108, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#2a2010,#5c4a2a)',
    tagline: "Indian startup helping businesses and residential communities achieve zero waste to landfill.",
    stats: [
      { val: '—', lbl: 'Waste Diverted' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Clients Served' },
    ],
    shortDesc: "Saahas Zero Waste provides end-to-end waste-management services — segregation, composting, recycling coordination — helping corporate campuses and residential communities divert waste away from landfills.",
    body: [
      "Saahas Zero Waste works with businesses, tech campuses and apartment communities to design and run on-site waste-segregation and composting systems, aiming to send as little waste as possible to landfill.",
      "Its work sits at the practical, operational end of the circular economy — turning zero-waste ambitions into working processes. Saahas is a private company. (Figures pending verification.)",
    ],
    tags: ['🗑️ Waste', '♻️ Zero Waste to Landfill', '🇮🇳 India', 'Private'],
  },

  // ── BIO ────────────────────────────────────────────────────────────────
  {
    id: 'string-bio', name: 'String Bio', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 109, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b00)',
    tagline: "Indian biomanufacturing startup converting methane into sustainable bio-products.",
    stats: [
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Feedstock' },
    ],
    shortDesc: "String Bio uses proprietary fermentation technology to convert methane — a potent greenhouse gas — into proteins and other bio-based products, turning an emissions problem into a manufacturing input.",
    body: [
      "String Bio has developed a bio-manufacturing platform that feeds methane (captured from sources like biogas or industrial off-gas) to engineered microbes, which convert it into proteins for animal feed and other bio-based ingredients.",
      "By using a greenhouse gas as feedstock instead of releasing it, the process offers a rare combination of emissions reduction and useful output. String Bio is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '🧪 Methane Biomanufacturing', '🇮🇳 India', 'Private'],
  },

  // ── AGRI ───────────────────────────────────────────────────────────────
  {
    id: 'bijak', name: 'Krishiacharya Technologies Private Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 110, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "B2B trading platform bringing transparency to India's agricultural commodity markets.",
    stats: [
      { val: '—', lbl: 'Traders on Platform' },
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Bijak operates a B2B trading and payments platform for agricultural commodities, connecting farmers, traders and buyers with more transparent pricing and faster payments.",
    body: [
      "Bijak digitises the historically opaque, relationship-driven trade of agricultural commodities in India, giving traders and farmers visibility into prices and access to working-capital and payment tools.",
      "Reducing information asymmetry in agri-trade can improve farmer price realisation and cut post-harvest losses caused by trading inefficiency. Bijak is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '📊 B2B Commodity Trading', '🇮🇳 India', 'Private'],
  },
  {
    id: 'waycool-foods', name: 'WayCool Foods and Products Private Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 111, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Agri-tech startup building a full-stack fresh produce and food supply chain.",
    stats: [
      { val: '—', lbl: 'Farmers Sourced From' },
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "WayCool Foods operates an integrated agri-supply chain — sourcing directly from farmers, processing, and distributing fresh produce and food products to retailers — cutting waste and middlemen.",
    body: [
      "WayCool Foods runs a full-stack agri-food supply chain, working directly with farmers on sourcing and quality, then processing and distributing fresh produce, staples and branded food products to retail and horeca customers.",
      "Shortening and formalising the farm-to-shelf chain reduces the very high spoilage typical of fragmented fresh-produce logistics in India. WayCool is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🚚 Full-Stack Supply Chain', '🇮🇳 India', 'Private'],
  },

  // ── SOLAR (Southeast Asia) ─────────────────────────────────────────────
  {
    id: 'xurya', name: 'PT Xurya Daya Indonesia', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 112, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Indonesia's leading solar-as-a-service startup for commercial and industrial rooftops.",
    stats: [
      { val: '—', lbl: 'Installed Capacity' },
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
    ],
    shortDesc: "Xurya installs and finances rooftop solar for commercial and industrial customers in Indonesia under a zero-upfront-cost subscription model, letting businesses switch to solar without capital spend.",
    body: [
      "Xurya is a solar-as-a-service provider in Indonesia, installing and owning rooftop solar systems on commercial and industrial buildings while customers simply pay for the electricity generated — removing the upfront cost barrier to adoption.",
      "This model has helped drive rooftop solar growth in a market where large capital outlays were previously the main obstacle. Xurya is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🏢 Solar-as-a-Service', '🇮🇩 Indonesia', 'Private'],
  },

  // ── EV (Southeast Asia) ────────────────────────────────────────────────
  {
    id: 'electrum', name: 'PT Energi Kreasi Bersama', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 114, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Indonesian electric-motorcycle venture backed by Gojek, building EVs for ride-hailing fleets.",
    stats: [
      { val: '—', lbl: 'Fleet Deployed' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Backers' },
    ],
    shortDesc: "Electrum develops electric motorcycles and battery-swapping infrastructure for Indonesia's massive ride-hailing and delivery-driver population, a joint venture between Gojek and TBS Energi Utama.",
    body: [
      "Electrum is an Indonesian electric-motorcycle venture formed by ride-hailing giant Gojek and energy company TBS Energi Utama, purpose-built to electrify the huge fleet of motorcycle drivers who power Southeast Asia's ride-hailing and delivery economy.",
      "It pairs electric motorcycles with battery-swap stations to match the high daily mileage these drivers need. Electrum is a private joint venture. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🏍️ Ride-Hailing Fleet', '🇮🇩 Indonesia', 'Private'],
  },

  // ── WATER (added on user request, duplicates checked against existing roster) ──
  {
    id: 'felix-industries', name: 'Felix Industries Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 115,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Ahmedabad-based environmental engineering firm built around a zero-waste philosophy.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Order Book' },
    ],
    shortDesc: "Felix Industries provides integrated water and wastewater treatment, zero liquid discharge systems, hydrocarbon recycling, and e-waste management under one roof.",
    body: [
      "Felix Industries is an environmental engineering company built around what it calls a zero-waste philosophy, offering water and wastewater treatment, zero liquid discharge (ZLD) systems, effluent recycling, and industrial anti-corrosion piping (C-PVC, PVDF, HDPE and related materials).",
      "Beyond water, the company has extended into hydrocarbon recycling and e-waste management, positioning itself as a broader environmental-services player rather than a single-product water company. It is listed on the NSE. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '♻️ ZLD & Recycling', '🇮🇳 India', 'NSE: FELIX'],
  },
  {
    id: 'indian-hume-pipe', name: 'The Indian Hume Pipe Company Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 116,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Century-old pipe manufacturer underpinning India's water-supply and irrigation infrastructure.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '1926', lbl: 'Founded' },
      { val: '—', lbl: 'Order Book' },
    ],
    shortDesc: "Indian Hume Pipe manufactures and lays the concrete and steel pipelines that carry drinking water, irrigation water and sewage across Indian cities and towns.",
    body: [
      "Indian Hume Pipe is one of India's oldest infrastructure manufacturers, founded in 1926, producing prestressed concrete pipes, steel pipes and penstock pipes used in water-supply, irrigation, sewer and drainage projects nationwide.",
      "The company also fabricates penstock pipes for hydroelectric projects and cooling-water pipelines for thermal power plants, putting it at the physical foundation of both water and power infrastructure. It is listed on the NSE and BSE. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🏗️ Pipes & Infrastructure', '🇮🇳 India', 'NSE: INDIANHUME'],
  },
  {
    id: 'shakti-pumps', name: 'Shakti Pumps (India) Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 117,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Leading manufacturer of energy-efficient and solar-powered pumps, exporting to 100+ countries.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '100+', lbl: 'Export Countries' },
      { val: '1982', lbl: 'Founded' },
    ],
    shortDesc: "Shakti Pumps manufactures energy-efficient submersible and solar-powered pumps for agriculture, municipal water supply, and industrial use, with a large export footprint.",
    body: [
      "Shakti Pumps is a leading Indian manufacturer of energy-efficient pumps and electric motors, with a product range spanning solar-powered submersible pumps, agricultural irrigation pumps, and municipal and industrial water-supply systems.",
      "The company supplies through a network of 500-plus dealers and 400-plus service centres in India and exports to more than 100 countries, giving it one of the widest international footprints among Indian water-equipment makers. It is listed on the NSE and BSE. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '☀️ Solar Pumps', '🇮🇳 India', 'NSE: SHAKTIPUMP'],
  },
  {
    id: 'jash-engineering', name: 'Jash Engineering Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 118,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Global manufacturer of water control gates and screening equipment for treatment plants.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '1948', lbl: 'Founded' },
      { val: '—', lbl: 'Order Book' },
    ],
    shortDesc: "Jash Engineering manufactures water control gates, screening and screening-conveying equipment used at water intake systems, pumping stations and treatment plants worldwide.",
    body: [
      "Jash Engineering makes the specialised mechanical equipment that sits at the front end of water infrastructure — control gates, screens and screening-conveying systems that manage flow and filter debris at water intake systems, pumping stations and treatment plants.",
      "The company operates both within India and internationally, with expanding capacity in the US and Saudi Arabia alongside its Indore manufacturing base, and counts municipal and industrial water systems worldwide among its customers. It is listed on the NSE. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '⚙️ Control Gates & Screens', '🇮🇳 India', 'NSE: JASH'],
  },
  {
    id: 'concord-enviro', name: 'Concord Enviro Systems Limited', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 119,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Mumbai-based zero liquid discharge specialist with an established international footprint.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Export Markets' },
    ],
    shortDesc: "Concord Enviro Systems designs and builds water and wastewater treatment plants, including zero liquid discharge (ZLD) systems, for industrial and municipal clients in India and abroad.",
    body: [
      "Concord Enviro Systems provides end-to-end water and wastewater treatment solutions — including zero liquid discharge (ZLD) systems that recover essentially all water from an industrial process, leaving no liquid effluent to discharge — serving pharmaceuticals, chemicals, textiles, power and food-processing clients.",
      "The company has an established presence in international markets including Latin America, Africa and North America alongside its Indian operations, and works under EPC, BOOT, PPP and O&M contract models. It listed on the NSE and BSE in December 2024. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '♻️ Zero Liquid Discharge', '🇮🇳 India', 'NSE: CEWATER'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // GERMANY 🇩🇪 — first country-wise batch (user request). Legal/registered
  // names verified individually (German commercial registry / SEC-equivalent
  // filings / official investor relations pages). Startups marked isStartup.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'siemens-energy', name: 'Siemens Energy AG', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 120,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Spun off from Siemens in 2020, now spans gas services, grid technology and wind through its wholly owned Siemens Gamesa.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '~1/6', lbl: 'of Global Electricity Generation' },
      { val: '2020', lbl: 'Spun Off' },
    ],
    shortDesc: "Siemens Energy is a German energy-technology group spanning gas services, grid technology and industrial decarbonisation, and wholly owns wind-turbine maker Siemens Gamesa.",
    body: [
      "Siemens Energy was spun off from Siemens in 2020, combining the former Gas and Power division with full ownership of Siemens Gamesa, one of the world's largest wind-turbine manufacturers. The company estimates its technology underpins roughly a sixth of global electricity generation.",
      "Operating through Gas Services, Grid Technologies, Transformation of Industry and Siemens Gamesa segments, the group sits at the intersection of conventional and renewable power infrastructure. It is listed on the Frankfurt Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '⚡ Grid & Wind', '🇩🇪 Germany', 'FWB: ENR'],
  },
  {
    id: 'rwe', name: 'RWE AG', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 121,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "One of Europe's largest energy groups, transitioning from fossil generation toward wind, solar and storage.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '~10 GW', lbl: 'Renewable Capacity' },
      { val: '2030', lbl: 'Climate-Neutral Target' },
    ],
    shortDesc: "RWE is a major German energy group that generates and trades electricity from wind, solar, hydro, biomass and gas, with a stated target of climate neutrality by 2030.",
    body: [
      "RWE is one of Europe's leading energy groups, historically built on coal and gas generation and now repositioning around renewables — onshore and offshore wind, solar, hydroelectric and biomass — alongside battery storage and hydrogen production activities.",
      "The company generates roughly half its net sales in Germany, with the remainder split across the UK, wider Europe and North America. RWE is listed on the Frankfurt Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💨 Wind & Storage', '🇩🇪 Germany', 'FWB: RWE'],
  },
  {
    id: 'sma-solar', name: 'SMA Solar Technology AG', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 122,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Europe's largest solar technology company by revenue, specialising in inverters.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '20', lbl: 'Countries' },
      { val: '1981', lbl: 'Founded' },
    ],
    shortDesc: "SMA Solar Technology manufactures solar inverters — the devices that convert a panel's DC output into grid-ready AC — for grid-connected, off-grid and backup power systems.",
    body: [
      "SMA Solar Technology is the largest Europe-based solar technology company by revenue, focused on inverters, battery-storage system technology and energy management for photovoltaic installations ranging from residential rooftops to utility-scale plants.",
      "Founded in 1981 and headquartered in Niestetal, Germany, the company operates in 20 countries. It is listed on the Frankfurt Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🔌 Inverters', '🇩🇪 Germany', 'FWB: S92'],
  },
  {
    id: 'nordex', name: 'Nordex SE', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 123,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "German wind turbine manufacturer with roughly 50 GW installed across more than 40 countries.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '~50 GW', lbl: 'Installed' },
      { val: '40+', lbl: 'Countries' },
    ],
    shortDesc: "Nordex designs, manufactures and services onshore wind turbines, with production spanning Germany, Brazil, India, Mexico and Spain.",
    body: [
      "Nordex is a European wind-turbine manufacturer headquartered in Hamburg, with a track record dating to the mass production of one of the first 1 MW turbines in the mid-1990s. By the end of 2023 the company had installed turbines totalling roughly 50 GW across more than 40 countries.",
      "Nordex reported record order intake in 2024, with Germany among its largest single-country sources of demand. The company is listed on the Frankfurt Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '🏭 Turbine Manufacturer', '🇩🇪 Germany', 'FWB: NDX1'],
  },
  {
    id: 'thyssenkrupp-nucera', name: 'thyssenkrupp nucera AG & Co. KGaA', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 124,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "Electrolysis technology provider with more than 10 GW of installed capacity worldwide.",
    stats: [
      { val: '10+ GW', lbl: 'Installed Capacity' },
      { val: '600+', lbl: 'Projects' },
      { val: '2023', lbl: 'IPO' },
    ],
    shortDesc: "thyssenkrupp nucera supplies large-scale alkaline water electrolysis technology for green hydrogen production, alongside chlor-alkali electrolysis for the chemical industry.",
    body: [
      "thyssenkrupp nucera provides electrolysis technology for industrial-scale green hydrogen production, built on more than 60 years of electrochemical engineering experience and over 600 installed projects totalling more than 10 GW of capacity.",
      "The company completed an IPO in July 2023 and has traded on the SDAX of the Frankfurt Stock Exchange since September 2023. It has signed cooperation agreements with Air Products for gigawatt-scale electrolysis plants and is developing high-temperature SOEC technology alongside its core alkaline systems. (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '🔬 Electrolysis', '🇩🇪 Germany', 'FWB: NCH2'],
  },
  {
    id: 'sunfire', name: 'Sunfire AG', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 125, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "Dresden startup building both alkaline and high-temperature solid oxide electrolysers.",
    stats: [
      { val: '€500M+', lbl: 'Funding Raised' },
      { val: '2010', lbl: 'Founded' },
      { val: '650+', lbl: 'Employees' },
    ],
    shortDesc: "Sunfire develops industrial electrolysers using both pressurised alkaline and high-temperature solid oxide (SOEC) technology, producing green hydrogen and syngas for hard-to-decarbonise industries.",
    body: [
      "Sunfire is a Dresden-based electrolyser manufacturer offering two distinct technologies side by side: pressurised alkaline electrolysis for straightforward green hydrogen production, and high-temperature solid oxide electrolysis (SOEC), which reaches higher efficiency when paired with industrial waste heat and can also produce syngas for e-fuels.",
      "Founded in 2010, Sunfire has raised more than €500 million from investors including Neste and SMS Group, and employs over 650 people across Germany and Switzerland. It is a venture-backed private company (registered as an AG). (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '🔬 Alkaline & SOEC', '🇩🇪 Germany', 'Private'],
  },
  {
    id: 'varta', name: 'VARTA AG', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 126,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "Long-established German battery manufacturer serving automotive, industrial and consumer markets.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'Founded' },
      { val: '—', lbl: 'Employees' },
    ],
    shortDesc: "VARTA manufactures batteries for automotive, industrial and consumer electronics markets, including lithium-ion cells for portable devices and energy storage.",
    body: [
      "VARTA is a long-established German battery manufacturer whose name originates as an acronym for the German phrase for distribution, recharging and repair of portable accumulators. The company today makes batteries spanning automotive starter batteries, industrial cells and consumer lithium-ion products.",
      "VARTA has expanded into microbatteries for hearables and wearables alongside its traditional automotive and industrial lines. The company is listed on the Frankfurt Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🔌 Batteries', '🇩🇪 Germany', 'FWB: VAR1'],
  },
  {
    id: 'remondis', name: 'REMONDIS SE & Co. KG', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 127,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "One of the world's largest recycling, water-management and industrial-services companies.",
    stats: [
      { val: '—', lbl: 'Revenue' },
      { val: '30+', lbl: 'Countries' },
      { val: '800+', lbl: 'Locations' },
    ],
    shortDesc: "REMONDIS is a German recycling and water-management group operating across raw-material recovery, industrial services and water supply and treatment in more than 30 countries.",
    body: [
      "REMONDIS is among the world's largest recycling firms, recovering raw materials, operating water-supply and wastewater-treatment systems, and providing industrial and municipal services from more than 800 locations worldwide. The company is part of the family-owned Rethmann Group.",
      "REMONDIS has also been trialling electric and hydrogen-powered waste-collection vehicles, including a battery-electric refuse truck in Cologne, as it works to decarbonise its own operations alongside the recycling services it provides to others. It is a privately held company. (Figures pending verification.)",
    ],
    tags: ['♻️ Recycling', '💧 + Water Services', '🇩🇪 Germany', 'Private'],
  },
  {
    id: 'rement', name: 'Rement GmbH', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 128, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "KIT spin-off upcycling demolition concrete into raw materials while storing CO2 in the process.",
    stats: [
      { val: '—', lbl: 'Funding Raised' },
      { val: '—', lbl: 'Founded' },
      { val: 'KIT', lbl: 'University Spin-off' },
    ],
    shortDesc: "Rement extracts sand, construction additives and a white pigment from fine demolition-concrete waste, feeding CO2 into the process so it ends up permanently stored in the recovered materials.",
    body: [
      "Rement is a spin-off from the Karlsruhe Institute of Technology (KIT) developing a process to upcycle fine demolition concrete — a waste stream that concrete recycling currently struggles to use — into sand, construction additives and a white pigment usable in construction chemicals, paints and plastics.",
      "The process feeds CO2 into the reaction, storing it permanently in the recovered materials rather than releasing it — concrete production and demolition together account for a meaningful share of global CO2 emissions. Rement's piloting is supported by Germany's EXIST research-transfer programme and backed by High-Tech Gründerfonds. It is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['♻️ Recycling', '🧱 Concrete Upcycling', '🇩🇪 Germany', 'Private'],
  },
  {
    id: 'volkswagen', name: 'Volkswagen AG', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 129,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Europe's largest automaker, building out its ID. electric-vehicle range under its NEW AUTO strategy.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '—', lbl: 'EV Models' },
      { val: '2050', lbl: 'Carbon-Neutral Target' },
    ],
    shortDesc: "Volkswagen Group is Europe's largest automaker, transitioning its mass-market lineup toward electric vehicles through its ID. range and a stated carbon-neutrality target of 2050.",
    body: [
      "Volkswagen AG is the parent of one of the world's largest automotive groups, spanning the VW, Audi, Porsche, Škoda and SEAT brands among others. Its NEW AUTO strategy centres on electrification, software and a stated goal of carbon neutrality across the business by 2050.",
      "Volkswagen has also backed climate-tech investment indirectly through Leitmotif, an independent venture fund it seeded with $300 million to back decarbonisation-focused startups. The company is listed on the Frankfurt Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🚗 ID. Range', '🇩🇪 Germany', 'FWB: VOW3'],
  },
  {
    id: 'basf', name: 'BASF SE', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 130,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "The world's largest chemical producer, with a major crop-technology and agricultural-inputs business.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '80+', lbl: 'Countries' },
      { val: '1865', lbl: 'Founded' },
    ],
    shortDesc: "BASF is the world's largest chemical producer, with crop-protection, seed and agricultural-technology products alongside its much broader chemicals and materials business.",
    body: [
      "BASF, an initialism of its original German name Badische Anilin- & Soda-Fabrik, is the world's largest chemical producer by revenue, operating in more than 80 countries. Its crop-technology division supplies crop-protection products, seeds and digital farming tools to growers globally.",
      "The company has also been developing chemical-recycling technology for plastics, converting mixed plastic waste into raw materials that can substitute for fossil inputs in its own production. BASF is listed on the Frankfurt Stock Exchange and is a DAX component. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 Crop Technology', '🇩🇪 Germany', 'FWB: BAS'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // SPAIN 🇪🇸 — second country-wise batch (user request). Legal/registered
  // names verified individually (CNMV filings, Wikipedia infoboxes cross-
  // checked against exchange data, commercial registry sources). One
  // company (Velca Motor) verified only to trade-name level with the exact
  // Spanish corporate suffix (S.L. assumed) unconfirmed — flagged below.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'iberdrola', name: 'Iberdrola, S.A.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 131,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "The world's largest producer of wind energy, spanning wind, solar, hydro and green hydrogen across four continents.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '46,177 MW', lbl: 'Installed Capacity' },
      { val: '30M', lbl: 'Customers' },
    ],
    shortDesc: "Iberdrola is a Spanish multinational electric utility and the world's largest producer of wind energy, with generation, distribution and green hydrogen operations across Spain, the UK, the US, Brazil and beyond.",
    body: [
      "Iberdrola is one of the world's largest electric utilities, generating power from onshore and offshore wind, solar, hydro and combined-cycle plants, and holds the title of the world's number one wind energy producer. Its subsidiaries include ScottishPower in the UK, Avangrid in the US, and Neoenergia in Brazil.",
      "The company operates Europe's largest green hydrogen plant, in Puertollano, Spain, and was the first company to receive the AENOR renewable hydrogen certificate. Iberdrola is listed on the Madrid Stock Exchange and is an IBEX 35 component. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💨 #1 Global Wind Producer', '🇪🇸 Spain', 'BME: IBE'],
  },
  {
    id: 'acciona-energia', name: 'Corporación Acciona Energías Renovables, S.A.', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 132,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "Pure-play renewable arm of the Acciona conglomerate, with wind as its single largest generation segment.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '13,630 MW', lbl: 'Installed Capacity' },
      { val: '20+', lbl: 'Countries' },
    ],
    shortDesc: "Acciona Energía develops, builds and operates renewable power plants across onshore wind, solar PV, hydroelectric, biomass and thermal solar, alongside battery storage and green hydrogen projects.",
    body: [
      "Acciona Energía is the dedicated renewable-energy subsidiary of the Spanish infrastructure conglomerate Acciona, S.A., with wind power its single largest generation segment by net sales, followed by solar, hydroelectric, thermal-solar and biomass.",
      "The company has been listed separately from its parent on the Madrid, Barcelona, Bilbao and Valencia exchanges since July 2021, and is also involved in green hydrogen production and electric-vehicle charging infrastructure. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '☀️ + Solar & Storage', '🇪🇸 Spain', 'BME: ANE'],
  },
  {
    id: 'solaria', name: 'Solaria Energía y Medio Ambiente, S.A.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 133,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Pure-play Spanish solar developer with a pipeline of roughly 14,200 MW across five countries.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '14,200 MW', lbl: 'Project Pipeline' },
      { val: '2002', lbl: 'Founded' },
    ],
    shortDesc: "Solaria designs, builds and operates solar photovoltaic plants, with a pipeline of roughly 14,200 MW across Spain, Italy, Portugal, Uruguay and Greece.",
    body: [
      "Solaria Energía y Medio Ambiente is a pure-play solar developer, handling the full lifecycle of photovoltaic projects from licensing and design through construction, operation and maintenance. Spain accounts for the large majority of its net sales.",
      "The company was incorporated in 2002 and is based in Madrid. It is listed on the Madrid Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🏭 Pure-Play Developer', '🇪🇸 Spain', 'BME: SLR'],
  },
  {
    id: 'moeve', name: 'Moeve, S.A.', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 134,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "Formerly Cepsa — rebranded in 2024 as it shifts toward green hydrogen, biofuels and electric mobility.",
    stats: [
      { val: '€8B', lbl: 'Decarbonisation Investment' },
      { val: '2 GW', lbl: 'Green H₂ Target' },
      { val: '2024', lbl: 'Rebranded' },
    ],
    shortDesc: "Moeve, known for over 90 years as Cepsa, is a Spanish energy company shifting its business toward green hydrogen, second-generation biofuels and ultra-fast electric-vehicle charging.",
    body: [
      "Moeve — Cepsa's new identity since October 2024 — is developing the Andalusian Green Hydrogen Valley, with two 1 GW electrolysis plants in Huelva and Cádiz that together aim to produce up to 300,000 tonnes of green hydrogen a year, backed by an €8 billion decarbonisation investment plan through 2030.",
      "The company has sold nearly 70% of its oil and gas production assets since 2022 as part of this shift, and is also building Southern Europe's largest second-generation biofuels plant. Moeve is majority owned by Mubadala Investment Company and The Carlyle Group. (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '✈️ + Biofuels', '🇪🇸 Spain', 'Private'],
  },
  {
    id: 'fcc-group', name: 'Fomento de Construcciones y Contratas, S.A.', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 135,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Barcelona-based infrastructure group whose Aqualia subsidiary is one of Europe's largest water operators.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '1900', lbl: 'Founded' },
      { val: '67,000', lbl: 'Employees' },
    ],
    shortDesc: "FCC Group is a diversified Spanish infrastructure company whose Aqualia subsidiary manages water supply and wastewater treatment for millions of people across Spain and internationally.",
    body: [
      "FCC Group, trading as FCC and formally Fomento de Construcciones y Contratas, is a Barcelona-based group spanning construction, civil engineering, environmental services and water management. Its water business, Aqualia, is one of the largest water operators in Europe by population served.",
      "Founded in 1900, the group is listed on the Madrid Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🏗️ + Infrastructure', '🇪🇸 Spain', 'BME: FCC'],
  },
  {
    id: 'urbaser', name: 'Urbaser, S.A.U.', sector: 'Waste', cat: 'waste', emoji: '🗑️',
    featured: false, rank: 136,
    stripeGrad: 'linear-gradient(135deg,#2a2010,#5c4a2a)',
    tagline: "Global waste management platform serving more than 60 million people, recently valued at €5.8 billion.",
    stats: [
      { val: '60M+', lbl: 'People Served' },
      { val: '50,000+', lbl: 'Employees' },
      { val: '1990', lbl: 'Founded' },
    ],
    shortDesc: "Urbaser provides integrated waste management and environmental services — urban cleaning, waste collection, municipal and industrial waste treatment, and water management — to municipalities and industrial clients worldwide.",
    body: [
      "Urbaser is a Madrid-headquartered environmental infrastructure company operating across urban services, municipal waste treatment and industrial waste treatment, serving more than 60 million people through a workforce of over 50,000.",
      "In February 2026, Urbaser's owner Platinum Equity agreed to sell the company to a consortium of Blackstone and EQT in a transaction valued at approximately €5.8 billion, with Platinum Equity retaining Urbaser's Argentina operations separately. Urbaser is a privately held company. (Figures pending verification.)",
    ],
    tags: ['🗑️ Waste', '♻️ + Recycling', '🇪🇸 Spain', 'Private'],
  },
  {
    id: 'velca', name: 'Velca Motor, S.L.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 137, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Madrid startup building electric motorcycles and mopeds with swappable batteries, growing share in a shrinking market.",
    stats: [
      { val: '$13M+', lbl: 'Funding Raised' },
      { val: '14.4%', lbl: 'Private-Channel Market Share' },
      { val: '2020', lbl: 'Founded' },
    ],
    shortDesc: "Velca manufactures 100% electric motorcycles and mopeds with swappable batteries, and has grown its share of Spain's private electric-motorcycle market even as overall registrations have declined.",
    body: [
      "Velca is a Madrid-based electric two-wheeler manufacturer, building motorcycles and mopeds aimed at sustainable urban commuting, with swappable batteries and an app-connected GPS system. The company sells through more than 80 points of sale and a network of over 350 service workshops across Spain.",
      "Despite a contracting Spanish electric-motorcycle market, Velca grew its private-channel market share to 14.4% in 2025, up from 8.8% the year before — a 62% year-on-year gain. The company has raised more than $13 million across five funding rounds and is now expanding into Italy, France and Germany. It is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🏍️ Electric Motorcycles', '🇪🇸 Spain', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // FRANCE 🇫🇷 — third country-wise batch (user request). Air Liquide S.A.
  // (hydrogen) and Veolia Environnement SA (water) already covered from
  // earlier batches, so this set fills Nuclear, Diversified, EV, Recycling
  // and Storage instead. Legal names verified individually — note EDF's
  // ownership/listing status changed materially in 2023 (see below).
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'edf', name: 'Électricité de France', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 138,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "Operator of France's 56-reactor nuclear fleet, which supplies roughly 70% of the country's electricity.",
    stats: [
      { val: '56', lbl: 'Reactors Operated' },
      { val: '~70%', lbl: 'of France\'s Electricity' },
      { val: '100%', lbl: 'State-Owned' },
    ],
    shortDesc: "EDF operates France's nuclear power fleet — 56 reactors supplying around 70% of the country's electricity — making France one of the world's largest net exporters of power.",
    body: [
      "Électricité de France (EDF) is the operator of France's nuclear fleet, the backbone of a grid that draws roughly 70% of its electricity from nuclear power — among the highest shares of any country in the world. EDF invested close to €5 billion in 2024 alone on operating and maintaining its 18 nuclear power stations.",
      "EDF was fully renationalised by the French state in 2023, and its shares were delisted from Euronext Paris that same year after having traded there since 2005 — it is now 100% state-owned rather than a publicly traded company. Subsidiaries include EDF Renewables and EDF Energy in the UK. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '⚡ #1 France', '🇫🇷 France', 'State-Owned'],
  },
  {
    id: 'totalenergies', name: 'TotalEnergies SE', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 139,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Global oil major renamed in 2021 as it builds toward 100 GW of renewable capacity by 2030.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '26 GW', lbl: 'Renewable Capacity' },
      { val: '100 GW', lbl: '2030 Target' },
    ],
    shortDesc: "TotalEnergies is a French multi-energy major that renamed itself from Total in 2021 to reflect its expansion beyond oil and gas into solar, wind, hydrogen, biofuels and electric-vehicle charging.",
    body: [
      "TotalEnergies traces back to 1924 as Compagnie Française des Pétroles and traded for decades simply as Total before shareholders approved the renaming to TotalEnergies SE in 2021, signalling its shift toward electricity and renewables alongside its traditional oil and gas business.",
      "The company currently operates roughly 26 GW of renewable electricity capacity and has set a target of 100 GW by 2030, alongside an extensive network of EV charging infrastructure across its service stations. TotalEnergies is listed on Euronext Paris and the NYSE. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '☀️ + Renewables Push', '🇫🇷 France', 'EPA: TTE'],
  },
  {
    id: 'engie', name: 'Engie SA', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 140,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Renewables, storage, gas and nuclear conglomerate investing roughly €12 billion a year in the energy transition.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '46+ GW', lbl: 'Renewables Deployed' },
      { val: '5+ GW', lbl: 'Storage Capacity' },
    ],
    shortDesc: "Engie is a French multinational utility spanning renewable electricity generation, battery storage, gas and electricity networks, and nuclear power, operating across 31 countries.",
    body: [
      "Engie combines renewable electricity and green gas production with battery storage, gas and electricity transmission networks, and district heating and cooling infrastructure. The company has deployed more than 46 GW of renewable capacity worldwide and over 5 GW of storage capacity either operational or under construction.",
      "Engie invests an average of €12 billion a year toward its net-zero carbon goal by 2045, and is active in emerging renewable markets across Africa and South America. The company is listed on Euronext Paris and Brussels, and is a CAC 40 component. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '🔋 + Storage & Grids', '🇫🇷 France', 'EPA: ENGI'],
  },
  {
    id: 'renault', name: 'Renault S.A.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 141,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "France's flagship automaker, spinning up its EV and software business through subsidiary Ampere.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '2.26M', lbl: 'Vehicles Sold (2024)' },
      { val: '15%', lbl: 'French State Stake' },
    ],
    shortDesc: "Renault Group is a French multinational automaker building out its electric-vehicle lineup across the Renault, Alpine and Dacia brands, with EV development consolidated under its Ampere subsidiary.",
    body: [
      "Renault S.A., trading as Renault Group, is one of France's flagship automakers, producing vehicles under the Renault, Alpine, Dacia and Mobilize brands across 128 countries. In 2022 it created Ampere, a dedicated EV and software subsidiary intended to operate as what CEO Luca de Meo called a next-generation car company — though Renault cancelled Ampere's planned 2024 IPO citing market conditions, keeping it in-house instead.",
      "Renault has also built out automotive circular-economy operations through subsidiaries Indra and Gaia, recovering materials from end-of-life vehicles for reuse in new production. The company is listed on Euronext Paris and is a CAC 40 component. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🔋 Ampere Division', '🇫🇷 France', 'EPA: RNO'],
  },
  {
    id: 'paprec', name: 'Paprec S.A.', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 142,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "France's leading recycling company, processing 15 million tonnes of waste a year across ten countries.",
    stats: [
      { val: '€3.5B', lbl: 'Revenue (2025)' },
      { val: '15M tonnes', lbl: 'Waste Processed' },
      { val: '16,000', lbl: 'Employees' },
    ],
    shortDesc: "Paprec is France's largest recycling company and the third-largest waste management and energy-recovery operator in the country, processing household and industrial waste across ten countries.",
    body: [
      "Paprec was founded in 1994 when Jean-Luc Petithuguenin bought the business out from Compagnie Générale des Eaux for €3 million; it has since grown into France's leading recycling company, collecting and processing 15 million tonnes of waste a year across 300 sites in ten countries.",
      "The company is now led by Sébastien Petithuguenin as CEO and Mathieu Petithuguenin as chairman, and reported revenue of €3.5 billion in 2025. Paprec is a privately held company. (Figures pending verification.)",
    ],
    tags: ['♻️ Recycling', '🗑️ + Waste & Energy Recovery', '🇫🇷 France', 'Private'],
  },
  {
    id: 'verkor', name: 'Verkor SAS', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 143, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "Grenoble battery startup building France's flagship low-carbon EV cell gigafactory in Dunkirk.",
    stats: [
      { val: '€2B+', lbl: 'Funding Raised' },
      { val: '16 GWh', lbl: 'Gigafactory Capacity' },
      { val: '2020', lbl: 'Founded' },
    ],
    shortDesc: "Verkor manufactures low-carbon lithium-ion battery cells for electric vehicles and stationary storage, and is building a 16 GWh gigafactory in Dunkirk powered by France's low-carbon nuclear grid.",
    body: [
      "Verkor was founded in 2020 with the goal of fast-tracking low-carbon battery-cell production in France. Its Dunkirk gigafactory, which began commissioning in late 2025, is designed to reach 16 GWh of annual capacity — enough for roughly 300,000 electric vehicles — and deliberately located in France to draw on the country's low-carbon nuclear-powered grid.",
      "The company has raised more than €2 billion in financing, including a €1.3 billion green loan backed by 19 banks and the European Investment Bank, and holds a long-term commercial partnership with Renault Group, whose Alpine A390 and other EV programmes now run on Verkor cells. It is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🚗 EV Battery Cells', '🇫🇷 France', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // ITALY 🇮🇹 — fourth country-wise batch (user request). Legal/registered
  // names verified individually (Borsa Italiana filings, LEI records).
  // Iveco deliberately excluded — despite being Turin-based and commonly
  // thought of as Italian, its holding company is legally incorporated in
  // the Netherlands (Iveco Group N.V.), so it's a candidate for a future
  // Netherlands batch instead, not this one.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'enel', name: 'Enel S.p.A.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 144,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Italy's largest electric utility, with 56 GW of renewable capacity out of 81 GW installed worldwide.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '56 GW', lbl: 'Renewable Capacity' },
      { val: '81 GW', lbl: 'Total Generation' },
    ],
    shortDesc: "Enel is Italy's largest electricity producer and distributor, with renewables — including a large share of hydro — making up the majority of its 81 GW global generation fleet through its Enel Green Power arm.",
    body: [
      "Enel is Italy's number one electricity producer and distributor, operating across generation, transmission and distribution, with a footprint spanning Italy, Spain, Latin America and beyond. Renewables account for 56 GW of its roughly 81 GW of installed generation capacity, developed primarily through its wholly owned subsidiary Enel Green Power.",
      "The Italian state, through the Ministry of Economy and Finance, remains Enel's largest single shareholder at 23.6%. The company is listed on Borsa Italiana and is a FTSE MIB component. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '☀️ + Enel Green Power', '🇮🇹 Italy', 'BIT: ENEL'],
  },
  {
    id: 'erg', name: 'ERG S.p.A.', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 145,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "Genoa-based renewable power producer that transformed from an oil refiner into a pure-play wind, solar and hydro operator.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '€752M', lbl: 'Revenue (2025)' },
      { val: '1938', lbl: 'Founded' },
    ],
    shortDesc: "ERG develops, owns and operates onshore wind, solar and hydro power plants across Italy, other European markets and the United States, having transitioned fully out of oil refining into renewable power.",
    body: [
      "ERG was founded in Genoa in 1938 as an oil refining business — its name is an acronym for Edoardo Raffinerie Garrone — before transforming over the following decades into a pure-play renewable energy producer focused on onshore wind, solar and hydroelectric power.",
      "The company has signed long-term power purchase agreements with major industrial customers including semiconductor maker STMicroelectronics, and also holds port and logistics infrastructure assets around Genoa. ERG is listed on Borsa Italiana. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '☀️ + Solar & Hydro', '🇮🇹 Italy', 'BIT: ERG'],
  },
  {
    id: 'hera', name: 'Hera S.p.A.', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 146,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Bologna-based multi-utility whose integrated water service reaches 3.6 million people across 227 municipalities.",
    stats: [
      { val: '3.6M', lbl: 'People Served (Water)' },
      { val: '35,080 km', lbl: 'Water Network' },
      { val: '227', lbl: 'Municipalities' },
    ],
    shortDesc: "Hera is an Italian multi-utility providing integrated water services — collection, drinking-water treatment, distribution, sewerage and sewage treatment — alongside waste management, gas and electricity across northern and central Italy.",
    body: [
      "Hera was formed in 2002 through the merger of eleven municipally owned utility companies in the Emilia-Romagna region, and has since grown into one of Italy's largest multi-utilities, with water services reaching 3.6 million people across 227 municipalities through a 35,080-kilometre network.",
      "Beyond water, Hera operates in waste management and recycling — including a plant producing 160 tonnes of recycled carbon fibre a year at 75% energy savings versus virgin fibre — as well as gas and electricity distribution. Hera is listed on Borsa Italiana and is a FTSE MIB component. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '♻️ + Waste & Recycling', '🇮🇹 Italy', 'BIT: HER'],
  },
  {
    id: 'energy-dome', name: 'Energy Dome S.p.A.', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 147, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "Milan startup storing renewable energy in giant inflatable domes full of compressed CO2, at half the cost of lithium-ion.",
    stats: [
      { val: '$128M+', lbl: 'Funding Raised' },
      { val: '9+ GWh', lbl: 'Sales Pipeline' },
      { val: '2020', lbl: 'Founded' },
    ],
    shortDesc: "Energy Dome's CO2 Battery stores renewable electricity by compressing and liquefying carbon dioxide inside large inflatable dome structures, discharging it later through a turbine — delivering 8 to 24 hours of storage without lithium or rare earths.",
    body: [
      "Energy Dome has built the world's first full-scale, grid-connected CO2 Battery on the Italian island of Sardinia — a striking inflatable dome holding 2,000 tonnes of carbon dioxide that cycles between liquid and gas form to store and release electricity, using only steel, water and CO2 rather than scarce battery materials.",
      "The company has signed commercial agreements with Italian utility A2A, energy major ENGIE, and a license deal with Ansaldo Energia to build projects across Italy, Germany, the Middle East and Africa, and partnered with Google in 2025 on long-duration storage for data centres. Founded in Milan in February 2020, Energy Dome has raised more than $128 million and is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🌫️ CO₂ Battery', '🇮🇹 Italy', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // UNITED KINGDOM 🇬🇧 — fifth country-wise batch (user request). Legal
  // names verified individually (Wikipedia infoboxes cross-checked against
  // LSE/Companies House data). Deliberately excludes ScottishPower (already
  // Iberdrola, Spain), EDF Renewables UK (already EDF, France), and RWE UK
  // (already RWE, Germany) — all UK-operating but foreign-domiciled
  // subsidiaries of companies already covered in earlier batches.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'sse', name: 'SSE plc', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 148,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "Scotland-headquartered energy group building Coire Glas, the UK's largest new pumped-storage hydro project in decades.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '4.5 GW', lbl: 'Renewable Portfolio' },
      { val: '19+ GW', lbl: 'Secured Pipeline' },
    ],
    shortDesc: "SSE develops and operates onshore and offshore wind farms, hydroelectric plants and battery storage across the UK and Ireland, and owns the electricity networks serving much of Scotland and southern England.",
    body: [
      "SSE, headquartered in Perth, Scotland, operates a 4.5 GW renewable portfolio spanning offshore wind, onshore wind and hydropower, with a secured project pipeline exceeding 19 GW. Its renewable arm, SSE Renewables, began life as Airtricity, an Irish wind company SSE acquired in 2008.",
      "The company is leading development of Coire Glas, a pumped-storage hydro project that will provide long-duration grid storage at a scale the UK hasn't built in decades. SSE also owns SSEN, the electricity distribution network covering much of Scotland and central southern England. It is listed on the London Stock Exchange and is a FTSE 100 component. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '💧 + Hydro & Storage', '🇬🇧 United Kingdom', 'LSE: SSE'],
  },
  {
    id: 'national-grid', name: 'National Grid plc', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 149,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Owner and operator of the electricity and gas transmission networks that connect Britain's renewable generation to homes and businesses.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '£17.7B', lbl: 'Revenue (2026)' },
      { val: '1990', lbl: 'Founded' },
    ],
    shortDesc: "National Grid owns and operates the high-voltage electricity transmission network across England and Wales and major gas transmission infrastructure, forming the backbone that renewable power must connect through to reach consumers.",
    body: [
      "National Grid is the critical infrastructure company behind Britain's energy transition — without transmission capacity to move power from offshore wind farms and solar arrays to where it's consumed, renewable generation capacity alone can't reach the grid. Together with SSE, it owns the entirety of the UK's electricity and gas transmission systems.",
      "The company also operates significant US utility operations following its 2000s expansion into New England and New York. National Grid is listed on the London Stock Exchange and NYSE, and is a FTSE 100 component. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '⚡ Grid Infrastructure', '🇬🇧 United Kingdom', 'LSE: NG.'],
  },
  {
    id: 'octopus-energy', name: 'Octopus Energy Group Limited', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 150,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "The UK's largest energy supplier, whose Kraken tech platform and EV charging arm now operate across nine countries.",
    stats: [
      { val: '14M', lbl: 'Customer Accounts' },
      { val: '9', lbl: 'Countries Served' },
      { val: '2015', lbl: 'Founded' },
    ],
    shortDesc: "Octopus Energy is the UK's largest energy supplier, combining retail electricity and gas with renewable generation, EV charging services and its Kraken software platform, which it also licenses to other energy suppliers worldwide.",
    body: [
      "Octopus Energy has grown since its 2015 founding into the UK's largest energy supplier by customer accounts, with 14 million accounts across 8 million households as of 2026. Its Kraken technology platform manages millions of smart devices in real time to help balance grid demand, and is licensed out to other energy companies internationally.",
      "Beyond retail supply, the company operates Octopus Electric Vehicles and Octopus Energy Generation, which owns and manages solar and onshore wind assets. Octopus Energy is a private company, wholly owned by its parent, Octopus Group. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🔌 + Retail & Kraken Tech', '🇬🇧 United Kingdom', 'Private'],
  },
  {
    id: 'biffa', name: 'Biffa Limited', sector: 'Waste', cat: 'waste', emoji: '🗑️',
    featured: false, rank: 151,
    stripeGrad: 'linear-gradient(135deg,#2a2010,#5c4a2a)',
    tagline: "One of Britain's oldest and largest waste management companies, tracing back to 1912.",
    stats: [
      { val: '—', lbl: 'Revenue' },
      { val: '1912', lbl: 'Founded' },
      { val: '8,000+', lbl: 'Employees' },
    ],
    shortDesc: "Biffa provides waste collection, landfill, recycling and special waste services to local authorities and businesses across the UK, and was historically the country's second-largest waste management company.",
    body: [
      "Biffa was founded in 1912 in Wembley, London, originally collecting and selling ash and clinker waste from London's power stations, and has grown over more than a century into one of the UK's largest waste management operators, serving local authorities and industrial and commercial clients nationwide.",
      "The company traded on the London Stock Exchange from 2016 until it was acquired by private equity firm Energy Capital Partners in January 2023 and taken private again. Biffa is headquartered in High Wycombe, England. (Figures pending verification.)",
    ],
    tags: ['🗑️ Waste', '♻️ + Recycling', '🇬🇧 United Kingdom', 'Private'],
  },
  {
    id: 'zenobe', name: 'Zenobe Energy Limited', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 152, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "London startup that skipped venture capital entirely, raising over £3.2 billion to electrify bus fleets and build grid-scale batteries.",
    stats: [
      { val: '£3.2B+', lbl: 'Funding Raised' },
      { val: '1,500 MW', lbl: 'Grid Batteries' },
      { val: '2017', lbl: 'Founded' },
    ],
    shortDesc: "Zenobe designs, finances, builds and operates battery storage for the electricity grid and for electric bus and commercial vehicle fleets, and repurposes batteries for second-life use once their first application ends.",
    body: [
      "Zenobe was founded in 2017 to address a gap its founders spotted early: as the UK built out more wind and solar, it would need serious storage capacity to keep the grid stable. The company now operates roughly 1,500 MW of grid-connected batteries live or under contract, and powers around 25% of the UK's electric bus market by supporting roughly 90% of major bus operators.",
      "Notably, Zenobe never raised traditional venture capital, instead going straight to infrastructure and private equity investors — including a £600 million raise from KKR and £270 million from Mubadala-backed Infracapital in 2023 — arguing it was too capital-intensive for typical VC funding. It has since expanded into Australia, New Zealand, North America and Benelux. Zenobe is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🚌 + Fleet Electrification', '🇬🇧 United Kingdom', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // UNITED STATES 🇺🇸 (supplemental) — 29 US champions already existed from
  // earlier in this build (Tesla, First Solar, Plug Power, Sunrun, etc.),
  // so this batch fills genuine gaps only: no "Diversified" US utility
  // existed, Wind had only an equipment maker (GE Vernova), and the
  // "Environment" category was completely empty. One name below (CFS)
  // could only be confirmed to trade-name level — flagged in its entry.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'nextera-energy', name: 'NextEra Energy, Inc.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 153,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "The world's largest generator of renewable energy from wind and sun, and North America's largest electric utility company.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '~40,000 MW', lbl: 'Total Generation' },
      { val: '~1/3', lbl: 'from Wind & Solar' },
    ],
    shortDesc: "NextEra Energy owns Florida Power & Light, the largest rate-regulated electric utility in the US, alongside NextEra Energy Resources, the world's largest generator of renewable energy from wind and solar and a leader in battery storage.",
    body: [
      "NextEra Energy is the largest electric power and energy infrastructure company in North America. Its regulated utility, Florida Power & Light, serves roughly 6 million customer accounts and around 12 million people, while its competitive arm, NextEra Energy Resources, is the world's largest generator of renewable electricity from wind and sun and also operates nuclear plants across four states.",
      "In 2026, NextEra Energy and Dominion Energy announced a definitive agreement to combine and create the world's largest regulated electric utility business — a deal that, if completed, would materially reshape the company's scale beyond what's reflected here. NextEra Energy is listed on the NYSE. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💨 + #1 Wind & Solar Generator', '🇺🇸 USA', 'NYSE: NEE'],
  },
  {
    id: 'invenergy', name: 'Invenergy LLC', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 154,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "North America's largest privately held renewable energy developer, with 220+ projects totaling over 36 GW.",
    stats: [
      { val: '36+ GW', lbl: 'Developed Capacity' },
      { val: '220+', lbl: 'Projects' },
      { val: '2001', lbl: 'Founded' },
    ],
    shortDesc: "Invenergy develops, builds, owns and operates wind, solar, natural gas and battery storage projects, and is North America's largest privately held renewable power generation company.",
    body: [
      "Invenergy, headquartered in Chicago, has developed more than 220 power generation and storage projects totalling over 36 GW of capacity since its 2001 founding, spanning onshore wind, solar, energy storage, transmission and, more recently, clean hydrogen production.",
      "Blackstone Infrastructure Partners and Caisse de dépôt et placement du Québec (CDPQ) invested roughly $3 billion for a stake in the company in 2022 to accelerate its renewables development, with Invenergy management remaining majority owners. The company is privately held. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '☀️ + Solar & Storage', '🇺🇸 USA', 'Private'],
  },
  {
    id: 'fervo-energy', name: 'Fervo Energy Company', sector: 'Environment', cat: 'environment', emoji: '🌋',
    featured: false, rank: 155,
    stripeGrad: 'linear-gradient(135deg,#3d1a0d,#802e10)',
    tagline: "Houston geothermal developer using oil-and-gas drilling techniques to deliver round-the-clock carbon-free power — now publicly traded.",
    stats: [
      { val: '$1.3B+', lbl: 'Funding Raised' },
      { val: '115 MW', lbl: 'Google/NV Energy PPA' },
      { val: '2017', lbl: 'Founded' },
    ],
    shortDesc: "Fervo Energy builds and operates enhanced geothermal power facilities, applying horizontal drilling and hydraulic fracturing techniques borrowed from oil and gas to tap geothermal heat and deliver continuous, round-the-clock carbon-free electricity.",
    body: [
      "Fervo Energy was founded in 2017 by a former oil-and-gas drilling engineer who realized the same horizontal drilling and multistage hydraulic fracturing techniques used to extract oil could instead be used to reach geothermal heat far more efficiently than traditional geothermal methods. Its first commercial pilot, Project Red, demonstrated 3 MW of consistent baseload power in 2023.",
      "In 2021, Fervo signed a 115 MW power purchase agreement with NV Energy to supply round-the-clock carbon-free electricity for Google's Nevada data centers — an early example of the data-center demand now driving major investment into firm clean power. Fervo went public in 2026 and trades on Nasdaq. (Figures pending verification.)",
    ],
    tags: ['🌋 Environment', '🔥 Geothermal', '🇺🇸 USA', 'NASDAQ: FRVO'],
  },
  {
    id: 'commonwealth-fusion', name: 'Commonwealth Fusion Systems', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 156, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "MIT spin-off building SPARC, aiming to be the first fusion machine to produce more energy than it consumes.",
    stats: [
      { val: '$2B+', lbl: 'Funding Raised' },
      { val: '2026', lbl: 'First Plasma (Target)' },
      { val: '2018', lbl: 'Founded' },
    ],
    shortDesc: "Commonwealth Fusion Systems is building SPARC, a compact tokamak fusion device developed with MIT, aiming to be the first machine to demonstrate net energy gain from fusion — a step toward its planned commercial ARC power plant.",
    body: [
      "Commonwealth Fusion Systems spun out of MIT in 2018 to commercialize a compact tokamak fusion reactor design. Its SPARC device, under construction at a purpose-built campus in Devens, Massachusetts, is targeting first plasma in 2026, with the goal of becoming the first fusion machine to produce more energy than it consumes.",
      "The company has raised more than $2 billion from investors including Bill Gates, and has signed a $1 billion power purchase agreement with Eni for electricity from its planned 400 MW ARC fusion plant in Virginia — a commercial commitment well ahead of the technology's proof of net energy gain. CFS is a venture-backed private company; its exact corporate suffix could not be confirmed. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '⚛️ Fusion', '🇺🇸 USA', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // POLAND 🇵🇱, CZECHIA 🇨🇿, SLOVAKIA 🇸🇰 — sixth country-wise batch (user
  // request, three countries together). Legal names verified individually
  // (Warsaw/Prague exchange filings, national commercial registries).
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'pge', name: 'PGE Polska Grupa Energetyczna S.A.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 157,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Poland's largest power producer, targeting climate neutrality by 2050 and up to 6.5 GW of offshore wind by 2040.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '6.5 GW', lbl: 'Offshore Wind Target (2040)' },
      { val: '2050', lbl: 'Climate-Neutral Target' },
    ],
    shortDesc: "PGE is Poland's largest electricity and heat producer, majority owned by the Polish state, now pivoting its investment strategy toward offshore and onshore wind, solar and grid infrastructure as it winds down coal.",
    body: [
      "PGE Polska Grupa Energetyczna is Poland's largest power producer, majority controlled by the Polish State Treasury. Historically built on coal generation, the group's 2030/2050 strategy redirects investment toward offshore and onshore wind, photovoltaics and grid infrastructure, with divestment from coal energy explicitly targeted.",
      "PGE is developing Poland's Baltica offshore wind projects and, in 2024, secured a PLN 2.25 billion European Investment Bank loan funding new solar parks and a 540 MW pumped-storage plant. The company is listed on the Warsaw Stock Exchange and is a WIG30 component. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💨 + Offshore Wind Pivot', '🇵🇱 Poland', 'WSE: PGE'],
  },
  {
    id: 'polenergia', name: 'Polenergia S.A.', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 158,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "Poland's largest independent renewable energy group, developing onshore and offshore wind, solar and green hydrogen.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '2.1 GW', lbl: 'Onshore Wind & Solar' },
      { val: '3 GW', lbl: 'Offshore Wind Pipeline' },
    ],
    shortDesc: "Polenergia is Poland's largest independent, vertically integrated renewable energy group, developing onshore and offshore wind, photovoltaics, green hydrogen and electricity distribution.",
    body: [
      "Polenergia, founded in 1997 and based in Warsaw, is Poland's largest privately held renewable energy group, developing 2.1 GW of onshore wind and solar projects domestically and up to 3 GW of offshore wind in the Baltic Sea in partnership with Equinor.",
      "The company's H2Silesia project aims to produce more than 10,000 tonnes of renewable hydrogen a year to decarbonise hard-to-abate Polish industry and heavy transport. Polenergia has been publicly traded since 2019 and is listed on the Warsaw Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '☀️ + Solar & Hydrogen', '🇵🇱 Poland', 'WSE: PEP'],
  },
  {
    id: 'cez', name: 'ČEZ, a.s.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 159,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Central and Eastern Europe's largest utility and biggest public company, majority owned by the Czech state.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '70%', lbl: 'Czech State Ownership' },
      { val: '6', lbl: 'Countries of Operation' },
    ],
    shortDesc: "ČEZ is the largest utility in Central and Eastern Europe, generating and distributing electricity and heat from nuclear, coal, gas and renewable sources across the Czech Republic, Germany, Hungary, Poland, Romania and Slovakia.",
    body: [
      "ČEZ Group is the largest utility and biggest public company in Central and Eastern Europe, with the Czech government holding a 70% majority stake. Its core business spans electricity and heat generation and distribution, natural gas trading, and coal extraction, with operations reaching across six countries in the region.",
      "The company is listed on both the Prague Stock Exchange and the Warsaw Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '⚡ Largest CEE Utility', '🇨🇿 Czechia', 'PSE: CEZ'],
  },
  {
    id: 'slovenske-elektrarne', name: 'Slovenské elektrárne, a.s.', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 160,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "Slovakia's largest electricity producer, which generated 100% of its 2025 output without direct local CO2 emissions.",
    stats: [
      { val: '100%', lbl: 'CO₂-Free Generation (2025)' },
      { val: '4,129 MWe', lbl: 'Installed Capacity' },
      { val: '2', lbl: 'Nuclear Power Plants' },
    ],
    shortDesc: "Slovenské elektrárne is Slovakia's largest electricity producer, operating two nuclear power plants, 31 hydropower plants and two photovoltaic plants — a mix that generated 100% of its 2025 output without direct local carbon dioxide emissions.",
    body: [
      "Slovenské elektrárne is Slovakia's largest electricity producer and one of the largest in Central Europe, running two nuclear power plants (Mochovce and Bohunice) alongside 31 hydropower plants and two photovoltaic plants. As of December 31, 2025, the company operated 4,128.80 MWe of installed capacity.",
      "Thanks to that low-carbon generation mix, the company reports it produced 100% of its 2025 electricity without direct local CO2 emissions. Slovenské elektrárne is majority owned by Slovak Power Holding B.V. (66%, ultimately controlled by Energetický a průmyslový holding), with the Slovak Republic holding the remaining 34% stake directly. The company is privately held. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '💧 + Hydro', '🇸🇰 Slovakia', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // AUSTRIA 🇦🇹, HUNGARY 🇭🇺, ROMANIA 🇷🇴, BULGARIA 🇧🇬 — seventh country-wise
  // batch (user request, four countries together). Legal names verified
  // individually (exchange filings, LEI records, Wikipedia infoboxes cross-
  // checked). Romania gets two entries reflecting its larger, more
  // developed clean-energy market relative to the other three.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'verbund', name: 'Verbund AG', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 161,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Austria's largest electricity provider, generating roughly 90-95% of its power from hydropower.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '8,300+ MW', lbl: 'Hydropower Capacity' },
      { val: '~90-95%', lbl: 'Renewable Generation' },
    ],
    shortDesc: "Verbund is Austria's largest electricity provider, generating the large majority of its power from hydropower plants, alongside wind, solar and emerging green hydrogen and e-mobility projects.",
    body: [
      "Verbund covers around 40% of Austria's electricity demand, generating roughly 90-95% of it from hydropower — one of the highest hydro shares of any major European utility. The company operates the country's supraregional power grid through subsidiary APG, alongside a growing wind and solar portfolio.",
      "Founded in 1947 as Österreichische Elektrizitätswirtschafts-AG, the company was renamed Verbund AG in 2010. The Republic of Austria holds a 51% majority stake. Verbund is listed on the Vienna Stock Exchange and is a component of the ATX index. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '⚡ + Hydropower', '🇦🇹 Austria', 'WBAG: VER'],
  },
  {
    id: 'mvm', name: 'MVM Zrt.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 162,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Hungary's fully state-owned national energy group, generating around 70% of the country's electricity.",
    stats: [
      { val: '70%', lbl: 'of Hungary\'s Power Generation' },
      { val: '23', lbl: 'Countries of Operation' },
      { val: '100%', lbl: 'State-Owned' },
    ],
    shortDesc: "MVM is Hungary's fully state-owned national energy group, spanning electricity generation via the Paks Nuclear Power Plant, gas supply, district heating and transmission infrastructure across the country and wider region.",
    body: [
      "MVM (Magyar Villamos Művek) is Hungary's second-largest company overall and the sixth-largest in Central Europe, wholly owned by the Hungarian state. The group accounts for roughly 70% of the country's power generation, primarily through the Paks Nuclear Power Plant, and holds close to half the market share in gas supply to industrial consumers.",
      "MVM has an active presence in 23 countries through more than 140 subsidiaries, and plays what it describes as an indispensable role in Hungary's renewable energy generation alongside its nuclear base. It is a privately held state company. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '☢️ + Nuclear Base', '🇭🇺 Hungary', 'Private'],
  },
  {
    id: 'hidroelectrica', name: 'S.P.E.E.H. Hidroelectrica S.A.', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 163,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Romania's largest electricity producer, whose 2023 stock listing was the biggest in the country's capital-markets history.",
    stats: [
      { val: '6.3 GW', lbl: 'Hydropower Capacity' },
      { val: '188', lbl: 'Plants Operated' },
      { val: '2023', lbl: 'Listed on BVB' },
    ],
    shortDesc: "Hidroelectrica is Romania's number one electricity producer, operating 188 hydropower and small hydropower plants alongside a growing wind portfolio, supplying roughly a third of the country's electricity.",
    body: [
      "Hidroelectrica, majority owned by the Romanian state, operates 188 hydropower and small hydropower plants — including five pumping stations — with a combined 6.3 GW of installed capacity, plus 36 wind turbines totalling 108 MW. It provides technological ancillary services critical to Romania's national grid.",
      "The company's 2023 initial public offering on the Bucharest Stock Exchange was the largest listing in Romanian capital-markets history, with the offer oversubscribed 3.6 times by individual investors within a week. Hidroelectrica is listed on the Bucharest Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '💨 + Wind', '🇷🇴 Romania', 'BVB: H2O'],
  },
  {
    id: 'nuclearelectrica', name: 'SN Nuclearelectrica S.A.', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 164,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "Romania's sole nuclear power producer, majority state-owned and publicly listed since 2013.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '82.49%', lbl: 'Romanian State Ownership' },
      { val: '1998', lbl: 'Founded' },
    ],
    shortDesc: "SN Nuclearelectrica is Romania's only nuclear energy producer, manufacturing electricity, thermal energy and nuclear fuel, majority owned by the Romanian state through the Ministry of Energy.",
    body: [
      "SN Nuclearelectrica was incorporated in 1998 through the reorganisation of RENEL, Romania's former state electricity monopoly, and remains the country's sole producer of nuclear energy, generating electricity, thermal energy and nuclear fuel.",
      "The Romanian state holds an 82.49% stake through the Ministry of Energy, with the remaining 17.5% held by other shareholders following the company's listing on the Bucharest Stock Exchange in 2013. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '🇷🇴 Romania', 'BVB: SNN'],
  },
  {
    id: 'beh', name: 'Bulgarian Energy Holding EAD', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 165,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Bulgaria's largest state-owned company, spanning nuclear, coal, gas and grid infrastructure as solar overtakes hydropower nationally.",
    stats: [
      { val: '—', lbl: 'Total Assets' },
      { val: '27%+', lbl: 'Renewables Share (2025)' },
      { val: '100%', lbl: 'State-Owned' },
    ],
    shortDesc: "Bulgarian Energy Holding is Bulgaria's largest state-owned company, owning the country's main electricity generation assets — including the Kozloduy Nuclear Power Plant — plus the national gas transmission network.",
    body: [
      "Bulgarian Energy Holding is a wholly state-owned holding company incorporated in 2008, and is Bulgaria's largest company by total assets. Its subsidiaries include Kozloduy Nuclear Power Plant, the NEK EAD electricity grid, and the Bulgargaz and Bulgartransgaz natural gas businesses, giving BEH a dominant position across Bulgaria's electricity and gas markets.",
      "Bulgaria reached its target of more than 27% renewables by 2030 four years early, hitting the milestone in 2025 — a shift driven substantially by solar power, which surpassed hydropower to become the country's leading renewable source that year. BEH is a privately held state company. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '☢️ + Nuclear', '🇧🇬 Bulgaria', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // GREECE 🇬🇷, TURKEY 🇹🇷, CROATIA 🇭🇷, BOSNIA & HERZEGOVINA 🇧🇦, ALBANIA 🇦🇱 —
  // eighth country-wise batch (user request, five countries together).
  // Legal names verified individually (exchange filings, company charters,
  // national registries). Bosnia's electricity sector is split into three
  // separate utilities along post-war ethnic/geographic lines — the
  // largest, EPBiH, is represented here; that split is itself worth
  // knowing when reading the entry.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'ppc', name: 'Public Power Corporation S.A.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 166,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Greece's largest electric utility, expanding into Romania after acquiring Enel's Romanian business in 2023.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '€1.24B', lbl: 'Enel Romania Acquisition' },
      { val: '1950', lbl: 'Founded' },
    ],
    shortDesc: "Public Power Corporation (PPC/ΔΕΗ) is Greece's largest electric power company, generating and distributing electricity domestically while expanding into Southeast Europe through acquisitions.",
    body: [
      "Public Power Corporation was founded by the Greek government in 1950 to build a national electricity policy and integrate the country's small local grids into a unified national network. It remains Greece's largest electric power company today.",
      "In October 2023, PPC acquired Enel's Romanian business for €1.24 billion, extending its footprint into the broader Southeast European market. The company is listed on the Athens Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '⚡ + Romania Expansion', '🇬🇷 Greece', 'Athex: PPC'],
  },
  {
    id: 'metlen', name: 'Metlen Energy & Metals S.A.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 167,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Greek industrial group that bought a 1.48 GW solar and battery storage portfolio in one deal, and moved its primary stock listing to London in 2025.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '1.48 GW', lbl: 'Solar & Storage Acquired' },
      { val: '2025', lbl: 'Primary Listing Moved to LSE' },
    ],
    shortDesc: "Metlen Energy & Metals, formerly known as Mytilineos, is a Greek industrial group spanning aluminium metallurgy and energy, including a large solar and battery storage portfolio and renewable project development across Southeast Europe.",
    body: [
      "Metlen — renamed from Mytilineos Energy & Metals in June 2024 — traces back to 1990, when founder Evangelos Mytilineos combined his family's metallurgy businesses. The company acquired a 1.48 GW portfolio of solar and 25 battery storage projects from Egnatia Group in 2021, alongside a corporate power purchase agreement, in what it called a first for Greece's energy transition.",
      "In 2025, Metlen moved its primary stock listing from Athens to the London Stock Exchange, joining the FTSE 100 index, while remaining listed on the Athens Exchange as well. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🔋 + Battery Storage', '🇬🇷 Greece', 'LSE: MTLN'],
  },
  {
    id: 'zorlu-enerji', name: 'Zorlu Enerji Elektrik Üretim A.Ş.', sector: 'Environment', cat: 'environment', emoji: '🌋',
    featured: false, rank: 168,
    stripeGrad: 'linear-gradient(135deg,#3d1a0d,#802e10)',
    tagline: "Operator of Turkey's largest geothermal power fleet, alongside wind and hydro plants spanning three countries.",
    stats: [
      { val: '305 MW', lbl: 'Geothermal (Largest in Turkey)' },
      { val: '3', lbl: 'Countries of Operation' },
      { val: '1993', lbl: 'Founded' },
    ],
    shortDesc: "Zorlu Enerji operates Turkey's largest geothermal power fleet alongside wind, hydro and natural gas plants, with additional wind capacity in Pakistan and gas plants in Israel.",
    body: [
      "Zorlu Enerji, founded in 1993, operates a diversified generation portfolio anchored by 305 MW of geothermal capacity — the largest geothermal fleet in Turkey — alongside 135 MW of wind and 119 MW of hydropower domestically. One of its plants integrates a 3.75 MW solar array with a 45 MW geothermal plant in a hybrid configuration.",
      "The company also operates a wind farm in Pakistan and natural gas plants in Israel, and has filed with Turkey's Capital Markets Board to spin off and separately list its renewables subsidiary, Zorlu Yenilenebilir Enerji A.Ş. Zorlu Enerji is listed on Borsa Istanbul. (Figures pending verification.)",
    ],
    tags: ['🌋 Environment', '🔥 Geothermal', '🇹🇷 Turkey', 'BIST: ZOREN'],
  },
  {
    id: 'hep', name: 'Hrvatska elektroprivreda d.d.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 169,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Croatia's national power company, tracing its roots to one of the world's first hydroelectric plants, now building the country's largest solar farm.",
    stats: [
      { val: '—', lbl: 'Revenue' },
      { val: '1895', lbl: 'Founded' },
      { val: '26', lbl: 'Hydroelectric Plants' },
    ],
    shortDesc: "Hrvatska elektroprivreda (HEP) is Croatia's national power company, operating hydroelectric, thermal, cogeneration and a growing solar fleet, alongside gas distribution and district heating.",
    body: [
      "HEP traces its foundation to 1895, when the Jaruga Hydroelectric Power Plant — one of the first hydroelectric plants in Europe, built just days after the Adams Power Plant at Niagara Falls — began operating. The Jaruga plant marked 120 years of continuous operation in 2023, making it one of the oldest active power plants in the world.",
      "HEP is organised as a holding group with subsidiaries spanning generation, transmission, distribution, heating and gas. In 2023 the company signed a contract for the Dugopolje solar plant, its twelfth photovoltaic facility and its largest to date. HEP is a state-owned company. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💧 + Century-Old Hydro', '🇭🇷 Croatia', 'State-Owned'],
  },
  {
    id: 'epbih', name: 'JP Elektroprivreda Bosne i Hercegovine d.d.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 170,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "The largest of Bosnia and Herzegovina's three ethnically divided electric utilities, a structural legacy of the 1990s war.",
    stats: [
      { val: '—', lbl: 'Revenue' },
      { val: '1945', lbl: 'Founded' },
      { val: '90%', lbl: 'Federation Ownership' },
    ],
    shortDesc: "Elektroprivreda BiH (EPBiH) is Bosnia and Herzegovina's largest electric utility, one of three separate power companies the country's grid was split into along geographic and ethnic lines after the 1992-1995 war.",
    body: [
      "Bosnia and Herzegovina's electricity sector is a legacy of its 1990s conflict: rather than one national utility, the country runs three separate, vertically integrated power companies split along geographic and ethnic lines — Elektroprivreda BiH (EPBiH, Sarajevo, Federation-owned), Elektroprivreda Republike Srpske (Trebinje), and Elektroprivreda HZ HB (Mostar). EPBiH is the largest of the three.",
      "Founded in 1945, EPBiH is 90% owned by the Federation of Bosnia and Herzegovina and is listed on the Sarajevo Stock Exchange. Its generation mix remains predominantly thermal, with hydro and a small but growing wind share. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '⚡ Largest of 3 BiH Utilities', '🇧🇦 Bosnia & Herzegovina', 'SASE: JPESR'],
  },
  {
    id: 'kesh', name: 'Korporata Elektroenergjitike Shqiptare Sh.a.', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 171,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Albania's state-owned power corporation, managing the country's main hydroelectric plants on the Drin river cascade.",
    stats: [
      { val: '—', lbl: 'Revenue' },
      { val: '1957', lbl: 'Founded' },
      { val: '100%', lbl: 'State-Owned' },
    ],
    shortDesc: "KESH (the Albanian Power Corporation) is Albania's public electricity producer, managing the country's main hydroelectric power plants and its largest generation assets.",
    body: [
      "KESH — Korporata Elektroenergjitike Shqiptare, or the Albanian Power Corporation — was founded in 1957 and is wholly owned by the Government of Albania. As the country's largest electricity producer, it manages Albania's main hydroelectric plants, which form the backbone of the national grid.",
      "KESH is a privately held state company (not separately listed). (Figures pending verification.)",
    ],
    tags: ['💧 Water', '⚡ Hydropower', '🇦🇱 Albania', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // NETHERLANDS 🇳🇱, BELGIUM 🇧🇪 — ninth country-wise batch (user request).
  // Umicore SA already covers Belgium/Recycling from an earlier batch.
  // Legal names verified individually (LEI records, EC merger filings,
  // exchange data). Iveco Group N.V. is included here rather than in the
  // earlier Italy batch specifically because its holding company is
  // legally domiciled in the Netherlands despite operating from Turin.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'tennet', name: 'TenneT B.V.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 172,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Dutch-government-owned grid operator connecting 43+ million people across the Netherlands and Germany.",
    stats: [
      { val: '25,000+ km', lbl: 'Lines & Cables' },
      { val: '43M+', lbl: 'End Users Connected' },
      { val: '€5.17B', lbl: 'H1 2026 Revenue' },
    ],
    shortDesc: "TenneT is the national high-voltage electricity transmission operator for the Netherlands, with a subsidiary also operating as one of Germany's four transmission system operators.",
    body: [
      "TenneT operates more than 25,000 kilometres of high-voltage lines and cables across the Netherlands and Germany, connecting over 43 million end-users through roughly 485 substations and 28,000 pylons — infrastructure that offshore wind and other renewable generation must reach the grid through.",
      "In February 2026, the German government acquired a further 25.1% stake in TenneT's German operations for €3.3 billion, with TenneT continuing to operate as two separate national organisations under a single holding company. TenneT is wholly owned by the Dutch government. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '⚡ Grid Infrastructure', '🇳🇱 Netherlands', 'State-Owned'],
  },
  {
    id: 'eneco', name: 'Eneco Groep N.V.', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 173,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "Dutch renewable producer that went from 44-municipality public ownership to a Japanese-owned offshore wind developer.",
    stats: [
      { val: '2.5+ GW', lbl: 'Offshore Wind Capacity' },
      { val: '2M+', lbl: 'Customers' },
      { val: '1995', lbl: 'Founded' },
    ],
    shortDesc: "Eneco produces and supplies renewable electricity, gas and heat in the Netherlands, with an active offshore wind development pipeline including projects built in partnership with Shell.",
    body: [
      "Eneco was originally owned collectively by 44 Dutch municipalities before a contested privatisation process concluded in March 2020, when full ownership transferred to a consortium of Japan's Mitsubishi Corporation (80%) and Chubu Electric Power (20%). The sale drew criticism from some Dutch stakeholders concerned about foreign control over a company central to national decarbonisation.",
      "Eneco's offshore wind portfolio now exceeds 2.5 GW, including the 760 MW Hollandse Kust West VI project developed with Shell and expected to begin commercial operation in 2026 — enough to supply roughly 3% of Dutch electricity demand. Eneco is a privately held company. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '🇯🇵 Japanese-Owned', '🇳🇱 Netherlands', 'Private'],
  },
  {
    id: 'iveco', name: 'Iveco Group N.V.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 174,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Commercial vehicle maker legally domiciled in the Netherlands, pursuing zero-emission trucks through its EVCO subsidiary.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '2022', lbl: 'Spun Off from CNH Industrial' },
      { val: '31,000+', lbl: 'Employees' },
    ],
    shortDesc: "Iveco Group designs and manufactures trucks, buses and specialty vehicles, including alternative propulsion systems, and took full ownership of its EVCO zero-emission heavy-duty vehicle venture from Nikola Corporation in 2023.",
    body: [
      "Iveco Group spun off from CNH Industrial on 1 January 2022 and, while its operations and brands are centred on Turin, Italy, the holding company itself is legally incorporated in the Netherlands. The group makes trucks, buses, defence vehicles and powertrains under the IVECO, IVECO BUS, ASTRA and FPT Industrial brands.",
      "In June 2023, Iveco's subsidiary Iveco S.p.A. took full ownership of the former Nikola Iveco Europe joint venture from Nikola Corporation, renaming it EVCO (Electric Vehicles COmpany) to advance zero-emission heavy-duty transport. Iveco Group is listed on Borsa Italiana. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🚛 Zero-Emission Trucks', '🇳🇱 Netherlands', 'MI: IVG'],
  },
  {
    id: 'electrabel', name: 'Electrabel SA', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 175,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "Operator of Belgium's nuclear fleet, which the Belgian government moved to fully nationalize in a 2026 letter of intent.",
    stats: [
      { val: '€15B', lbl: 'Engie-to-State Nuclear Payment' },
      { val: '7', lbl: 'Reactor Units' },
      { val: '2026', lbl: 'Nationalization Letter of Intent' },
    ],
    shortDesc: "Electrabel operates Belgium's nuclear power plants and is the country's largest electricity supplier, and is now at the centre of a government move to fully nationalize Belgium's nuclear sector.",
    body: [
      "Electrabel, a subsidiary of French energy group Engie since 2008, operates Belgium's seven nuclear generation units and remains the country's largest electricity supplier, holding over 70% market share in the Brussels-Capital Region alone. The company was delisted from the stock exchange in 2007 following Engie's predecessor Suez taking full ownership.",
      "In March 2025, Engie agreed to pay the Belgian state €15 billion in exchange for the government taking on future nuclear waste liabilities and equal ownership of two extended reactors. Then, in April 2026, the Belgian federal government signed a letter of intent with Engie and Electrabel to acquire all of their nuclear-related assets, liabilities and obligations outright — effectively nationalizing Belgium's nuclear sector, with terms targeted for October 2026. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '🏛️ Nationalization Underway', '🇧🇪 Belgium', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // DENMARK 🇩🇰, NORWAY 🇳🇴 — tenth country-wise batch (user request).
  // Ørsted A/S and Vestas Wind Systems A/S already cover Denmark/Wind;
  // Nel ASA already covers Norway/Hydrogen — this batch fills other
  // categories. Legal names verified individually (LEI records, exchange
  // filings). Maersk's exact corporate suffix (A/S) inferred from
  // standard Danish public-company convention rather than directly
  // confirmed — flagged in its entry.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'equinor', name: 'Equinor ASA', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 176,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Norway's state oil major, renamed from Statoil in 2018 as it builds out offshore wind and green hydrogen alongside petroleum.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '67%', lbl: 'Norwegian State Ownership' },
      { val: '36', lbl: 'Countries of Operation' },
    ],
    shortDesc: "Equinor is Norway's state-controlled energy major, historically built on North Sea oil and gas, now developing offshore wind, green hydrogen and solar alongside its core petroleum business.",
    body: [
      "Equinor, founded in 1972 as the wholly state-owned Statoil, changed its name in May 2018 to reflect an ambition to become a broader energy company beyond oil. The Norwegian government remains the largest shareholder at 67%. Equinor's Renewables segment develops offshore wind, green hydrogen and solar power, alongside carbon capture and storage projects.",
      "The company operates in 36 countries and holds additional investments in lithium mining. Equinor is listed on the Oslo Stock Exchange and the NYSE. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💨 + Offshore Wind', '🇳🇴 Norway', 'OSE: EQNR'],
  },
  {
    id: 'statkraft', name: 'Statkraft AS', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 177,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Europe's largest generator of renewable energy, built on Norway's hydropower and now expanding across four continents.",
    stats: [
      { val: '—', lbl: 'Revenue' },
      { val: '100%', lbl: 'Norwegian State-Owned' },
      { val: '4', lbl: 'Continents of Operation' },
    ],
    shortDesc: "Statkraft is Europe's largest producer of renewable energy, built on Norway's hydropower resources and expanding internationally into wind, solar and battery storage across Europe, South America and Asia.",
    body: [
      "Statkraft, wholly owned by the Norwegian state, is Europe's largest generator of renewable energy, with roots in Norway's roughly 35 GW of hydropower capacity — the backbone of a sector that traces back to the country's first hydropower plant in 1891.",
      "The company has expanded well beyond Norway, acquiring Spanish renewables company Enerfín in 2024, Swedish wind developers Svevind Nordic and Njordr Offshore Wind in 2023, and commissioning Brazil's largest wind farm outside Europe in 2026, alongside solar and battery projects opened at COP30 in Belém. Statkraft is a privately held state company. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '💨 + Global Wind & Solar', '🇳🇴 Norway', 'Private'],
  },
  {
    id: 'novonesis', name: 'Novonesis A/S', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 178,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Danish biosolutions giant formed by merging Novozymes and Chr. Hansen, replacing synthetic chemistry with engineered microorganisms.",
    stats: [
      { val: '—', lbl: 'Revenue' },
      { val: '2024', lbl: 'Formed via Merger' },
      { val: '45%', lbl: 'of Sales Tagged \"Biosolutions\"' },
    ],
    shortDesc: "Novonesis develops enzymes, microorganisms and biopharmaceutical ingredients that replace synthetic chemistry across agriculture, food, biofuels and industrial processes.",
    body: [
      "Novonesis was formed in January 2024 through the merger of Novozymes and Chr. Hansen, two of Denmark's largest microorganism-technology companies, creating one of the world's largest bioscience innovation firms. The company develops enzymes, cultures, probiotics and postbiotics used across agriculture, food, animal health and industrial biotechnology.",
      "A meaningful share of Novonesis's business supports the ethanol and biodiesel industries, where its enzymes improve yields from first- and second-generation biofuel feedstocks. The company is listed on Nasdaq Copenhagen. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '🧬 Biosolutions', '🇩🇰 Denmark', 'CPH: NZYM B'],
  },
  {
    id: 'maersk', name: 'A.P. Moller - Maersk A/S', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 179,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Global shipping giant that launched the world's first green-methanol-powered container ship, targeting net zero by 2040.",
    stats: [
      { val: '25', lbl: 'Methanol Ships Ordered' },
      { val: '2.75M tonnes', lbl: 'Annual CO₂ Savings (Laura Maersk)' },
      { val: '2040', lbl: 'Net-Zero Target' },
    ],
    shortDesc: "A.P. Moller - Maersk is a Danish shipping and logistics conglomerate that launched the Laura Maersk, the world's first container ship to run entirely on green methanol, as part of an ambition to reach net zero by 2040.",
    body: [
      "Maersk, founded in 1904, christened the Laura Maersk in September 2023 as the world's first container ship to run entirely on green methanol, expected to save 2.75 million tonnes of CO2 a year once its full class of vessels is in service. The company has ordered 25 methanol-powered ships to be delivered by 2030, including the larger Ane Maersk, which entered service in 2024 as the first big vessel of its kind.",
      "Maersk signed a supply agreement with Equinor to secure green methanol for its ships, and has stated an ambition to produce and import 20 million tonnes of green fuels by 2030 to support the wider shift away from fossil bunker fuel. The company's exact corporate suffix is presumed A/S, standard for Danish public companies, though not independently confirmed here. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '🚢 Green Methanol Shipping', '🇩🇰 Denmark', 'CPH: MAERSK B'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // SWEDEN 🇸🇪, FINLAND 🇫🇮 — eleventh country-wise batch (user request).
  // Legal names verified individually (LEI records, company governance
  // pages). Northvolt AB — the obvious Swedish battery pick — was
  // deliberately excluded: it filed for bankruptcy in March 2025 and its
  // Swedish assets were acquired by American company Lyten in Feb 2026.
  // Featuring it as a "champion" without that context would have been
  // misleading. Stegra (Sweden's green steel scale-up) is included but
  // flagged honestly — still active, but with real documented funding
  // and permitting friction, not a clean success story yet.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'vattenfall', name: 'Vattenfall AB', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 180,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Sweden's wholly state-owned energy group, built on hydropower and now spanning nuclear and wind across five European markets.",
    stats: [
      { val: '—', lbl: 'Revenue' },
      { val: '100%', lbl: 'Swedish State-Owned' },
      { val: '1909', lbl: 'Founded' },
    ],
    shortDesc: "Vattenfall is Sweden's second-largest energy company, wholly owned by the Swedish state, producing and retailing electricity and heat from hydropower, nuclear and wind across Sweden, Germany, the Netherlands, Denmark and the UK.",
    body: [
      "Vattenfall was founded in 1909 on hydropower and has since expanded into nuclear and wind generation, operating roughly 139,000 kilometres of power lines and serving about 900,000 customers directly in Sweden, with a further presence in Germany, the Netherlands, Denmark and the UK.",
      "Vattenfall was one of three founding partners, alongside SSAB and LKAB, of the HYBRIT initiative — an early hydrogen-based green steel project that helped inspire the broader wave of Swedish green-steel investment, including Stegra. Vattenfall AB is a Swedish public limited liability company, wholly owned by the Swedish state. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💧 + Hydro & Nuclear', '🇸🇪 Sweden', 'State-Owned'],
  },
  {
    id: 'stegra', name: 'Stegra AB', sector: 'Environment', cat: 'environment', emoji: '🌋',
    featured: false, rank: 181, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#3d1a0d,#802e10)',
    tagline: "Stockholm scale-up building a green steel plant that cuts emissions up to 95% — under construction, but facing real funding and permitting friction.",
    stats: [
      { val: '€6.5B+', lbl: 'Financing Secured' },
      { val: '95%', lbl: 'Target CO₂ Reduction' },
      { val: '2020', lbl: 'Founded' },
    ],
    shortDesc: "Stegra, formerly H2 Green Steel, is building a large-scale green steel plant in Boden, northern Sweden, using green hydrogen instead of coal to cut steelmaking emissions by up to 95% compared to a traditional blast furnace.",
    body: [
      "Stegra was founded in 2020 by the same investor group behind Northvolt, aiming to decarbonise steelmaking — one of the hardest industrial sectors to clean up — by replacing coal-based blast furnaces with green hydrogen and a direct reduced iron process feeding an electric arc furnace. The company has secured more than €6.5 billion in financing, including a €265 million EU Recovery and Resilience Facility grant.",
      "The project has faced real friction: Sweden's Environmental Protection Agency rejected a roughly SEK 1.65 billion state-support application in December 2024, and internal documents later showed the agency had flagged Stegra's expected carbon emissions to the government as early as February 2022 — well before that funding decision, prompting political debate over state support for the project. Stegra is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🌋 Environment', '🔧 Green Steel', '🇸🇪 Sweden', 'Private'],
  },
  {
    id: 'neste', name: 'Neste Oyj', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 182,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "The world's leading producer of sustainable aviation fuel and renewable diesel, refining waste and residues instead of crude oil.",
    stats: [
      { val: '3.3M tonnes', lbl: 'Annual Renewable Capacity' },
      { val: '1948', lbl: 'Founded' },
      { val: '35.9%', lbl: 'Finnish State Ownership' },
    ],
    shortDesc: "Neste is the world's leading producer of sustainable aviation fuel and renewable diesel, refining waste, residues and other renewable raw materials into fuels and feedstock for polymers and chemicals.",
    body: [
      "Neste, founded in 1948 as Finland's state petrol company, has transformed from a conventional oil refiner into the world's leading producer of sustainable aviation fuel (SAF) and renewable diesel, with roughly 3.3 million tonnes of annual renewable production capacity across refineries in Finland, the Netherlands and Singapore — the latter the largest renewable diesel refinery in the world.",
      "Neste's proprietary NEXBTL technology processes waste fats, used cooking oil and other renewable feedstocks rather than crude oil, and the company also operates a joint renewable diesel venture with Marathon Petroleum in the US. Neste is listed on Nasdaq Helsinki, with the Finnish state as its largest shareholder. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '✈️ + Sustainable Aviation Fuel', '🇫🇮 Finland', 'HEL: NESTE'],
  },
  {
    id: 'fortum', name: 'Fortum Oyj', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 183,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "Finland's state-owned energy major, Europe's second-largest producer of nuclear power and third-largest of carbon-free electricity overall.",
    stats: [
      { val: '#2', lbl: 'Europe Nuclear Producer' },
      { val: '#3', lbl: 'Europe Carbon-Free Electricity' },
      { val: '1932', lbl: 'Roots (as Imatran Voima)' },
    ],
    shortDesc: "Fortum is a Finnish state-owned energy company and Europe's second-largest producer of nuclear power, operating hydro, nuclear and cogeneration plants across the Nordic region.",
    body: [
      "Fortum traces its roots to Imatran Voima, founded in 1932 to operate Finland's Imatrankoski hydroelectric plant, and later merged with Neste in 1998 to form Fortum Corporation before the two demerged again in 2005. Fortum is now Europe's second-largest producer of nuclear power and third-largest producer of carbon-free electricity overall.",
      "Fortum's German subsidiary Uniper was nationalised by the German government for €8 billion in 2024 after Uniper had become a Fortum subsidiary in 2020, an unusual case of a state taking over a foreign-owned company's domestic energy subsidiary during Europe's energy crisis. Fortum is listed on Nasdaq Helsinki, majority owned by the Finnish state. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '💧 + Hydro & Cogeneration', '🇫🇮 Finland', 'HEL: FORTUM'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // LITHUANIA 🇱🇹, LATVIA 🇱🇻, ESTONIA 🇪🇪 — twelfth country-wise batch (user
  // request, three countries together). Legal names verified individually
  // (Wikipedia infoboxes cross-checked against company registries). All
  // three are dominant, state-owned national utilities — the Baltic
  // energy market is structured this way, not a gap in research. Enefit
  // Green, Estonia's separately listed renewable arm, was deliberately
  // not featured on its own: it was renationalised and delisted from
  // Nasdaq Tallinn in August 2025, folding back into parent Eesti Energia.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'ignitis', name: 'Ignitis grupė AB', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 184,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Lithuania's state-owned energy holding, running the country's electricity network alongside a dedicated Green Generation Portfolio.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '€1.5B', lbl: 'Company Valuation' },
      { val: '5', lbl: 'Countries Served' },
    ],
    shortDesc: "Ignitis Group is Lithuania's state-owned energy holding company, operating the national electricity distribution network alongside a dedicated Green Generation renewable energy portfolio and customer energy solutions.",
    body: [
      "Ignitis Group, formerly known as Lietuvos Energija, is majority owned by Lithuania's Ministry of Finance and structured around four business lines: the Networks distribution business, a dedicated Green Generation renewable portfolio, strategically important Reserve Capacities, and Customer & Solutions services including solar, e-mobility and energy efficiency offerings.",
      "The company serves customers across Lithuania, Latvia, Estonia, Poland and Finland, and is the fifth-largest company in the Baltic states by revenue. Ignitis Group is publicly listed, majority owned by the Lithuanian state. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💨 + Green Generation', '🇱🇹 Lithuania', 'Public'],
  },
  {
    id: 'latvenergo', name: 'Latvenergo AS', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 185,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "The Baltics' largest power supplier, planning up to 120 wind turbines in a new joint venture with Latvia's state forestry company.",
    stats: [
      { val: '—', lbl: 'Revenue' },
      { val: '800 MW', lbl: 'Planned Wind Capacity' },
      { val: '1939', lbl: 'Founded' },
    ],
    shortDesc: "Latvenergo is Latvia's wholly state-owned electric utility and the largest power supplier in the Baltic states, now building large-scale wind capacity through a joint venture with the state forestry company.",
    body: [
      "Latvenergo, founded in 1939 and wholly owned by the Latvian state through the Ministry of Economics, is the largest power supplier in the Baltic states, generating and trading electricity and heat, and operating Latvia's electricity distribution network through subsidiary Sadales tīkls.",
      "In July 2022, Latvenergo established Latvijas vēja parki with state forestry company Latvijas valsts meži — Latvenergo holding 80% — to build 100 to 120 wind turbines across several large wind parks totalling roughly 800 MW of capacity, expected to generate 2.4 TWh of electricity a year. Latvenergo AS is a Latvian state-owned company. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '⚡ + Baltic\'s Largest Utility', '🇱🇻 Latvia', 'State-Owned'],
  },
  {
    id: 'eesti-energia', name: 'Eesti Energia AS', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 186,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Estonia's state energy company, transitioning from the world's largest oil-shale-to-energy operation toward wind, solar and a circular chemicals business.",
    stats: [
      { val: '45%', lbl: 'Renewable Share (2023)' },
      { val: '419 MW', lbl: 'Wind Capacity (Baltics)' },
      { val: '1939', lbl: 'Founded' },
    ],
    shortDesc: "Eesti Energia, known internationally as Enefit, is Estonia's wholly state-owned energy company, historically the world's largest oil-shale-to-energy operation, now redirecting its generation mix toward wind and solar while developing a circular-economy chemicals business from shale by-products.",
    body: [
      "Eesti Energia was founded in 1939 and remains wholly owned by the Estonian state. Historically built around oil shale — extracted from company-owned mines in eastern Estonia and long the backbone of Estonian electricity generation — the group has redirected its energy mix substantially toward renewables, with wind and solar now accounting for roughly 45% of total production, up from a much smaller share a decade earlier.",
      "Its renewable arm, Enefit Green, operates 419 MW of wind capacity across the Baltics and 75 MW of solar in Estonia and Poland. Enefit Green was listed separately on Nasdaq Tallinn from October 2021 until Eesti Energia completed a full renationalisation and delisting in August 2025, folding it back into the parent group. Eesti Energia AS is wholly owned by the Estonian state. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '☀️ + Wind & Solar Pivot', '🇪🇪 Estonia', 'State-Owned'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // SWITZERLAND 🇨🇭, PORTUGAL 🇵🇹 — thirteenth country-wise batch (user
  // request). Legal names verified individually (LEI records, exchange
  // filings). EDP Renováveis — the obvious Portuguese "renewables" pick —
  // was deliberately excluded: despite being majority-owned by Portugal's
  // EDP and trading on Euronext Lisbon, it is legally domiciled in Madrid,
  // Spain. Used genuine Portuguese parent EDP, S.A. instead.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'axpo', name: 'Axpo Holding AG', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 187,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Switzerland's largest energy company and, by its own account, the country's largest producer of renewable electricity.",
    stats: [
      { val: 'CHF 4.8B', lbl: 'Revenue' },
      { val: '100', lbl: 'Power Plants Operated' },
      { val: '~30', lbl: 'Countries of Operation' },
    ],
    shortDesc: "Axpo is Switzerland's largest energy company, operating more than 100 power plants spanning hydropower, nuclear, biomass and solar domestically, with wind and solar development abroad and international energy trading.",
    body: [
      "Axpo Holding, headquartered in Baden and wholly owned by the cantons of northeastern Switzerland, traces its roots to the early days of Swiss electrification. Domestically its generation mix leans heavily on hydropower and nuclear power, while its international growth focuses on wind and solar, alongside gas and steam combined-cycle plants.",
      "The company operates in roughly 30 countries through energy trading, portfolio management and supply services, including a longstanding Iberian presence supplying electricity and gas services in Spain and Portugal. Axpo Holding AG is a Swiss public limited company. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💧 + Hydro & Nuclear', '🇨🇭 Switzerland', 'State-Owned'],
  },
  {
    id: 'climeworks', name: 'Climeworks AG', sector: 'Environment', cat: 'environment', emoji: '🌋',
    featured: false, rank: 188, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#3d1a0d,#802e10)',
    tagline: "ETH Zurich spin-off pulling CO2 directly from the air at Iceland's Mammoth plant — still the sector's most visible name, despite 2025 layoffs.",
    stats: [
      { val: '$1B+', lbl: 'Total Funding Raised' },
      { val: '36,000 tonnes/yr', lbl: 'Mammoth Plant Capacity' },
      { val: '2009', lbl: 'Founded' },
    ],
    shortDesc: "Climeworks builds and operates direct air capture plants that filter CO2 out of the atmosphere for permanent underground storage, running the two largest such facilities in the world in Iceland.",
    body: [
      "Climeworks was founded in 2009 as a spin-off from ETH Zurich by engineers Jan Wurzbacher and Christoph Gebald, and has operated more than 15 direct air capture plants across Europe. Its Iceland facilities are the sector's flagship projects: Orca, capturing 4,000 tonnes of CO2 a year, and the newer Mammoth, scaled up to 36,000 tonnes annually and powered entirely by clean energy.",
      "Climeworks remains widely described as the most visible name in direct air capture, with customers including Microsoft, UBS and JPMorgan and more than $1 billion raised to date — including $162 million in July 2025. That same year, however, the company also underwent significant layoffs, a signal of real cost pressure in scaling direct air capture even for the sector's clearest leader. Climeworks is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['🌋 Environment', '🌫️ Direct Air Capture', '🇨🇭 Switzerland', 'Private'],
  },
  {
    id: 'edp', name: 'EDP, S.A.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 189,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Portugal's largest electricity generator and distributor, targeting 50 GW of renewable capacity by 2030 through its Spanish-domiciled EDP Renewables arm.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '33 GW', lbl: 'Renewable Target (2026)' },
      { val: '50 GW', lbl: 'Renewable Target (2030)' },
    ],
    shortDesc: "EDP is Portugal's largest generator, supplier and distributor of electricity, operating hydro, wind, solar and gas generation across Portugal, Spain, Brazil and the US.",
    body: [
      "EDP was founded in 1976 as Electricidade de Portugal, formed by merging 14 electricity companies nationalised after the Carnation Revolution, and has since grown into a vertically integrated utility with major operations across Portugal, Spain, Brazil and the United States. The company targets roughly 33 GW of installed renewable capacity by 2026, rising past 50 GW by 2030.",
      "EDP's renewables platform is anchored by its 71% stake in EDP Renewables — legally a separate, Madrid-domiciled company despite the shared branding — while offshore wind is pursued through the Ocean Winds joint venture with Engie. EDP is listed on Euronext Lisbon. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💨 + Renewables Platform', '🇵🇹 Portugal', 'ELI: EDP'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // ISRAEL 🇮🇱 — fourteenth country-wise batch (user request). Legal names
  // verified individually. Note on SolarEdge: headquartered and operated
  // from Herzliya, founded by Israeli entrepreneurs, but legally
  // incorporated in Delaware, USA — standard practice for Nasdaq-listed
  // Israeli tech companies. Included under Israel given genuine
  // operational roots there, with the Delaware incorporation flagged
  // directly in the entry rather than glossed over.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'solaredge', name: 'SolarEdge Technologies, Inc.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 190,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Herzliya-founded DC-optimized inverter pioneer that changed how residential and commercial solar systems harvest and manage power.",
    stats: [
      { val: '—', lbl: 'Market Cap' },
      { val: '2006', lbl: 'Founded' },
      { val: '46%', lbl: 'YoY Revenue Growth (Q1 2026)' },
    ],
    shortDesc: "SolarEdge developed the DC-optimized inverter system that changed how power is harvested and managed in photovoltaic installations, and now offers battery storage, EV charging and home energy management alongside its core inverter business.",
    body: [
      "SolarEdge was founded in 2006 in Herzliya, Israel, by Guy Sella and four co-founders, developing an intelligent inverter architecture that pairs a power optimizer at each solar panel with a central inverter — maximizing energy harvest and enabling panel-level monitoring, a meaningful improvement over older string-inverter designs.",
      "The company's stock fell sharply from its November 2021 peak amid a broader solar-sector downturn, leading to its 2023 removal from the S&P 500, but reported a return toward profitability in early 2026 with 46% year-over-year revenue growth. While headquartered and founded in Israel, SolarEdge Technologies, Inc. is legally incorporated in Delaware, USA, standard practice for Nasdaq-listed Israeli technology companies. It is listed on Nasdaq. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🔌 + Storage & EV Charging', '🇮🇱 Israel', 'NASDAQ: SEDG'],
  },
  {
    id: 'ide-technologies', name: 'IDE Technologies Ltd.', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 191,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Sixty-year-old desalination pioneer that helped turn Israel's water scarcity into a global technology export, delivering water in 40 countries.",
    stats: [
      { val: '~500', lbl: 'Plants Built' },
      { val: '40', lbl: 'Countries' },
      { val: '3M m³/day', lbl: 'Water Delivered' },
    ],
    shortDesc: "IDE Technologies designs, builds and operates seawater desalination and industrial water-treatment plants worldwide, using both thermal and reverse-osmosis membrane technology developed in response to Israel's own water scarcity.",
    body: [
      "IDE Technologies was founded in 1965 by Ukrainian-born engineer Alexander Zarchin, growing out of Israel's early efforts to solve chronic water scarcity through desalination — starting with a small freeze-desalination demonstration plant in Eilat in 1963. The company went on to build some of the world's largest seawater reverse osmosis facilities, including the Ashkelon, Hadera and Sorek plants along Israel's Mediterranean coast.",
      "IDE has since built or operated roughly 500 desalination and water-treatment plants across 40 countries, delivering approximately 3 million cubic metres of water a day, and won the Global Water Award for Desalination Company of the Year in 2022. The company is privately held, currently owned by private equity firm Alpha Partners. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🌊 Desalination', '🇮🇱 Israel', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // JAPAN 🇯🇵 — fifteenth country-wise batch (user request). Per new
  // standing instruction, this batch deliberately spans six different
  // categories rather than clustering in one or two. Legal names verified
  // individually (LEI records, exchange filings, official company sites).
  // JERA's entry states its fossil/renewable generation mix honestly
  // rather than presenting it as a clean-energy company outright.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'jera', name: 'JERA Co., Inc.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 192,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Japan's largest power generator, still overwhelmingly fossil-fuelled, now building a dedicated renewables arm to reach 20 GW by 2035.",
    stats: [
      { val: '~73 GW', lbl: 'Total Capacity' },
      { val: '0.2%', lbl: 'Renewable Share (Japan)' },
      { val: '20 GW', lbl: 'JERA Nex Target (2035)' },
    ],
    shortDesc: "JERA is Japan's largest power generation company, formed from the combined thermal assets of Tokyo Electric and Chubu Electric, now building a dedicated renewables division, JERA Nex, to diversify a generation mix that remains overwhelmingly fossil-fuelled.",
    body: [
      "JERA was formed in 2015 as a 50-50 joint venture between TEPCO Fuel & Power and Chubu Electric Power, an idea that emerged from younger managers within Tokyo Electric seeking to separate thermal generation from the utility's nuclear liabilities after the Fukushima Daiichi disaster. It's worth stating plainly: as of FY2023, fossil fuels made up 97% of JERA's global generation capacity and renewables just 3% globally, only 0.2% within Japan itself.",
      "JERA is now attempting a real pivot, launching JERA Nex in 2024 as a dedicated renewables arm targeting 20 GW of onshore and offshore wind, solar and battery storage capacity by 2035, alongside domestic decarbonisation efforts including a 20% ammonia co-firing demonstration at its Hekinan thermal plant. JERA Co., Inc. is a privately held joint venture. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '🔥 + Renewables Pivot Underway', '🇯🇵 Japan', 'Private'],
  },
  {
    id: 'toyota', name: 'Toyota Motor Corporation', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 193,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "Maker of the Mirai, the world's first mass-produced hydrogen fuel cell sedan, now supplying fuel cell systems for buses, trains and stationary power.",
    stats: [
      { val: '28,000+', lbl: 'Mirai Units Sold' },
      { val: '30+', lbl: 'Countries & Territories' },
      { val: '2,700+', lbl: 'FC Systems Supplied Elsewhere' },
    ],
    shortDesc: "Toyota launched the Mirai in 2014 as the world's first mass-produced hydrogen fuel cell sedan, and now supplies its Toyota Fuel Cell System to buses, railways and stationary power generators worldwide.",
    body: [
      "Toyota launched the Mirai — Japanese for 'future' — in December 2014, the first mass-produced hydrogen fuel cell electric vehicle, converting compressed hydrogen into electricity via an onboard fuel cell and emitting only water vapour. Toyota has since sold more than 28,000 Mirai units across more than 30 countries and territories.",
      "Since 2019, Toyota has extended its fuel cell technology beyond passenger cars, supplying more than 2,700 fuel cell systems to over 100 customers for use in buses, railways and stationary power generators, and made thousands of its hydrogen fuel cell patents available royalty-free to encourage wider industry adoption. Toyota Motor Corporation is listed on the Tokyo Stock Exchange and NYSE. (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '🚗 + Fuel Cell Systems', '🇯🇵 Japan', 'TYO: 7203'],
  },
  {
    id: 'panasonic', name: 'Panasonic Holdings Corporation', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 194,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "Century-old electronics conglomerate and long-standing battery cell supplier to Tesla's gigafactories.",
    stats: [
      { val: '¥8.46T', lbl: 'Revenue (FY2025)' },
      { val: '1918', lbl: 'Founded' },
      { val: '2022', lbl: 'Restructured as Holding Co.' },
    ],
    shortDesc: "Panasonic Holdings is a major Japanese conglomerate whose battery business includes long-standing cell supply agreements with Tesla, alongside rechargeable batteries, automotive systems and a broad consumer and industrial electronics portfolio.",
    body: [
      "Panasonic traces back to 1918, when Kōnosuke Matsushita founded a small workshop making electric lamp sockets. The company operated for most of its history as Matsushita Electric Industrial, rebranded to Panasonic Corporation in 2008, and restructured into its current holding-company form, Panasonic Holdings Corporation, in 2022.",
      "Panasonic's battery business is one of Tesla's principal cell suppliers, manufacturing lithium-ion cells at Tesla's Nevada Gigafactory, and the company has also launched battery-recycling initiatives with Sumitomo Metal Mining to recover nickel from spent cathode materials. Panasonic Holdings is listed on the Tokyo Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🔌 + Tesla Cell Supplier', '🇯🇵 Japan', 'TYO: 6752'],
  },
  {
    id: 'kurita-water', name: 'Kurita Water Industries Ltd.', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 195,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Water treatment specialist built from post-war boiler chemistry, now operating in 14+ countries.",
    stats: [
      { val: '—', lbl: 'Revenue' },
      { val: '1949', lbl: 'Founded' },
      { val: '14+', lbl: 'Overseas Subsidiaries' },
    ],
    shortDesc: "Kurita Water Industries manufactures water-treatment chemicals and facilities, along with process treatment chemicals for the pulp and paper, petrochemical and steel industries, serving clients across more than a dozen countries.",
    body: [
      "Kurita Water Industries was founded in 1949 by former Japanese navy officer Haruo Kurita, who applied navy boiler-water treatment expertise to found a chemical water-treatment business. The company expanded into water-treatment facilities and chemical cleaning services through the 1950s, and into process treatment for heavy industry — pulp and paper, petrochemicals and steel — through the 1960s.",
      "Kurita has built more than a dozen overseas subsidiaries and affiliates since the mid-1970s, and has been listed in the Nature Stock Index since 2003, a recognition reserved for companies with a demonstrated sustainability focus. Kurita Water Industries is listed on the Tokyo Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🏭 Industrial Treatment', '🇯🇵 Japan', 'TYO: 6370'],
  },
  {
    id: 'nissan', name: 'Nissan Motor Co., Ltd.', sector: 'EV', cat: 'ev', emoji: '⚡',
    featured: false, rank: 196,
    stripeGrad: 'linear-gradient(135deg,#1a0d2e,#4a1080)',
    tagline: "Maker of the Leaf, one of the world's first mass-market electric vehicles, with over 650,000 sold and a growing second-life battery business.",
    stats: [
      { val: '650,000+', lbl: 'Leaf Units Sold' },
      { val: '2010', lbl: 'Leaf Launched' },
      { val: '48', lbl: 'Battery Modules per Leaf' },
    ],
    shortDesc: "Nissan produces the Leaf, one of the earliest and best-selling mass-market electric vehicles, and has built out battery reuse and recycling programmes to extend the life of retired EV battery packs.",
    body: [
      "Nissan's Leaf, launched in 2010, became one of the world's earliest and best-selling mass-market electric vehicles, with more than 650,000 units sold. As early Leaf batteries have begun reaching the end of their vehicle life, Nissan has built a second-life battery business, repurposing packs that still hold meaningful charge capacity into portable power sources and stationary storage.",
      "Nissan operates 4R Energy Corporation, a battery-recycling joint venture with Sumitomo Corporation, and has partnered with Stena Recycling in Norway to extend safer, diagnostics-first battery reuse into Europe. Nissan is part of the Renault-Nissan-Mitsubishi Alliance and is listed on the Tokyo Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['⚡ EV', '🔋 + Battery Second-Life', '🇯🇵 Japan', 'TYO: 7201'],
  },
  {
    id: 'sumitomo-metal-mining', name: 'Sumitomo Metal Mining Co., Ltd.', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 197,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "Centuries-old mining and smelting company now recovering nickel and cobalt from spent EV batteries for Panasonic's cathode supply chain.",
    stats: [
      { val: '1590', lbl: 'Founded' },
      { val: '—', lbl: 'Revenue' },
      { val: '3', lbl: 'Core Business Segments' },
    ],
    shortDesc: "Sumitomo Metal Mining processes and refines non-ferrous metals including nickel, cobalt and precious metals, and has developed battery-recycling technology to recover cathode materials from spent lithium-ion cells.",
    body: [
      "Sumitomo Metal Mining traces its roots back to 1590, making it one of the oldest continuously operating businesses referenced in this roster, having taken its current name in 1952. The company operates across Mineral Resources, Smelting & Refining, and Materials segments, supplying copper, nickel, cobalt and precious metals alongside advanced battery materials.",
      "In 2023, Sumitomo Metal Mining partnered with Panasonic Energy to launch a nickel-recovery initiative recycling cathode materials from spent lithium-ion batteries, and has separately developed technology to recover lithium through an integrated soluble-slag process — closing the loop on materials that would otherwise require fresh mining. Sumitomo Metal Mining is listed on the Tokyo Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['♻️ Recycling', '⛏️ + Battery Materials', '🇯🇵 Japan', 'TYO: 5713'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // SOUTH KOREA 🇰🇷 — sixteenth country-wise batch (user request). Per the
  // "across categories" standing instruction, spans three distinct
  // categories. Samsung SDI was researched but deliberately excluded from
  // this batch to avoid redundancy with LG Energy Solution — both are
  // fundamentally battery/storage companies, and doubling up would have
  // undercut the category-diversity goal rather than served it.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'lg-energy-solution', name: 'LG Energy Solution, Ltd.', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 198,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "World's top battery patent holder, supplying EV cells to GM, Stellantis and Hyundai — with a Georgia joint-venture plant caught up in a major 2025 immigration raid.",
    stats: [
      { val: '25,000+', lbl: 'Battery Patents' },
      { val: '30 GWh', lbl: 'Hyundai JV Capacity' },
      { val: '7', lbl: 'US Plants Operating/Building' },
    ],
    shortDesc: "LG Energy Solution is a leading global manufacturer of lithium-ion batteries for electric vehicles, mobility, IT and energy storage systems, split off from LG Chem and the world's top holder of battery-related patents.",
    body: [
      "LG Energy Solution, spun off from LG Chem, holds more than 25,000 battery-related patents — the most of any company globally — and supplies EV battery cells through joint ventures with General Motors, Stellantis and Hyundai Motor Group, including a $4.3 billion, 30 GWh joint-venture plant with Hyundai in Georgia aimed at supporting production of 300,000 EVs a year.",
      "That Georgia facility was disrupted in September 2025 when hundreds of Korean workers were detained in a sweeping US immigration enforcement raid, suspending construction and rattling South Korean industry over the risk to other Korean manufacturing projects in the US. LG Energy Solution is listed on the Korea Exchange. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '🔌 + EV Battery Cells', '🇰🇷 South Korea', 'KRX: 373220'],
  },
  {
    id: 'hyundai-motor', name: 'Hyundai Motor Company', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 199,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "Maker of the Nexo fuel cell SUV, now building a full hydrogen ecosystem under its HTWO brand — including its own gigawatt-scale solar complex to power it.",
    stats: [
      { val: '2018', lbl: 'Nexo Launched' },
      { val: '₩1.3T', lbl: 'Saemangeum Solar Investment' },
      { val: '8 of 10', lbl: 'Top Korean Conglomerates in Hydrogen' },
    ],
    shortDesc: "Hyundai Motor entered the hydrogen business in 2018 with its Nexo fuel cell SUV and has since built out HTWO, a hydrogen ecosystem brand spanning production, storage and transportation, backed by its own planned gigawatt-scale solar complex.",
    body: [
      "Hyundai Motor launched the Nexo hydrogen fuel cell SUV in 2018, at a time when many in the industry considered the automaker's hydrogen bet premature given the lack of refuelling infrastructure. The company has continued investing regardless, updating the Nexo through 2027 model-year versions and building out HTWO, a dedicated hydrogen ecosystem brand covering the full value chain from production through storage and transportation.",
      "Hyundai has signed a hydrogen business memorandum with Korea South-East Power and plans to invest 1.3 trillion won in sites including Saemangeum, North Jeolla Province, to build a gigawatt-scale solar complex generating electricity directly — positioning the company to eventually produce and use its own hydrogen from renewable power. Eight of South Korea's ten largest conglomerates have entered the hydrogen business, and Hyundai was among the earliest. Hyundai Motor Company is listed on the Korea Exchange and the London Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '🚗 + HTWO Ecosystem', '🇰🇷 South Korea', 'KRX: 005380'],
  },
  {
    id: 'hanwha-solutions', name: 'Hanwha Solutions Corporation', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 200,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Parent of Qcells, whose $2.5 billion Georgia solar hub is the largest single solar manufacturing investment in US history.",
    stats: [
      { val: '$2.5B', lbl: 'Georgia Solar Hub Investment' },
      { val: '8.4 GW', lbl: 'Target Annual Capacity' },
      { val: '28.6%', lbl: 'Record Tandem Cell Efficiency' },
    ],
    shortDesc: "Hanwha Solutions, through its Qcells division, manufactures solar cells and modules and develops utility-scale renewable projects, and built the largest single solar manufacturing investment in US history in Cartersville, Georgia.",
    body: [
      "Hanwha Solutions' Qcells division — originally founded in Bitterfeld-Wolfen, Germany in 1999 and acquired out of bankruptcy by Hanwha Group in 2012 — announced a $2.5 billion investment in January 2023 to build a fully integrated solar supply chain in Cartersville, Georgia, the largest single solar manufacturing investment in US history, targeting 8.4 GW of annual production capacity.",
      "In December 2024, Qcells achieved 28.6% efficiency on a full-area, industrial-size perovskite-silicon tandem solar cell, independently verified by the Fraunhofer Institute for Solar Energy Systems in Germany — the first time a commercially relevant full-size tandem cell, rather than a small research sample, received third-party certification at that scale. Hanwha Solutions is listed on the Korea Exchange. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🔬 + Tandem Cell R&D', '🇰🇷 South Korea', 'KRX: 009830'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // CHINA 🇨🇳 (supplemental) — 17 China champions already existed from
  // earlier in this build, spanning Storage, Solar, Wind, EV, Nuclear,
  // Waste, Recycling and Water. This batch fills two genuine gaps:
  // Diversified and Hydrogen. Sinopec's entry states its fossil-fuel core
  // business honestly rather than presenting it as a clean-energy company.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'china-three-gorges', name: 'China Three Gorges Corporation', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 201,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "World's largest clean energy group, operator of the Three Gorges Dam, with a generation mix that reached 96% clean energy in 2024.",
    stats: [
      { val: '96%', lbl: 'Clean Energy Share (2024)' },
      { val: '158M kW', lbl: 'Controllable Capacity (2024)' },
      { val: '22,500 MW', lbl: 'Three Gorges Dam Capacity' },
    ],
    shortDesc: "China Three Gorges Corporation is the world's largest clean energy group, operating the Three Gorges Dam — the world's largest hydroelectric power station — alongside a hydro cascade on the Yangtze River and China's largest offshore wind portfolio.",
    body: [
      "China Three Gorges Corporation, established in 1993 to build the Three Gorges Dam, now operates six cascade hydropower stations on the Yangtze's main stream, including the Baihetan Dam, the world's second-largest hydroelectric plant. The company has expanded well beyond hydro to become China's largest and one of the world's leading offshore wind developers, and by 2024 reached 96% clean energy across its controllable generation capacity.",
      "In December 2024, CTG's Pingtan Offshore Wind Farm set a world record for single-day power generation by a single 16-megawatt offshore turbine — the largest capacity unit of its kind in the world. CTG is a wholly state-owned enterprise supervised by China's State-owned Assets Supervision and Administration Commission. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💧 + World\'s Largest Hydro Dam', '🇨🇳 China', 'State-Owned'],
  },
  {
    id: 'sinopec', name: 'China Petroleum & Chemical Corporation', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 202,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "China's largest oil refiner is also one of its largest hydrogen producers, building toward 500,000 tonnes of green hydrogen capacity by 2025.",
    stats: [
      { val: '3.5M tonnes', lbl: 'Annual Hydrogen Production' },
      { val: '~14%', lbl: 'of China\'s Hydrogen Output' },
      { val: '1,000', lbl: 'Planned Refuelling Stations' },
    ],
    shortDesc: "Sinopec, primarily a petroleum and petrochemical company and one of the world's largest oil refiners, is also one of China's largest hydrogen suppliers, building green hydrogen production and refuelling infrastructure at national scale.",
    body: [
      "Sinopec should be described plainly: it is first and foremost a fossil fuel company, one of the world's largest oil refining conglomerates by revenue. That context matters for understanding its hydrogen business — currently producing more than 3.5 million tonnes of hydrogen a year, about 14% of China's total output, the large majority of it still derived from fossil sources rather than renewable electricity.",
      "Sinopec has set a goal of becoming China's leading hydrogen energy company, planning 1,000 hydrogen refuelling stations and green hydrogen plants in Xinjiang and Inner Mongolia targeting a combined 50,000 tonnes of renewable-sourced hydrogen annually, part of a broader ambition to reach 500,000 tonnes of green hydrogen production capacity. Sinopec is listed in Shanghai, Hong Kong and New York. (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '🛢️ Primarily Fossil Fuel Co.', '🇨🇳 China', 'NYSE: SNP'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // RUSSIA 🇷🇺 — seventeenth country-wise batch (user request). Legal names
  // verified individually. Entries kept strictly to business and
  // technology facts (legal structure, capacity, history, market share),
  // consistent with how every other company in this roster is treated —
  // no editorializing beyond what's directly, materially business-relevant.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'rosatom', name: 'State Atomic Energy Corporation Rosatom', sector: 'Nuclear', cat: 'nuclear', emoji: '☢️',
    featured: false, rank: 203,
    stripeGrad: 'linear-gradient(135deg,#2d2a00,#6b6300)',
    tagline: "World's largest nuclear technology exporter, responsible for roughly three-quarters of nuclear power plants under construction internationally.",
    stats: [
      { val: '76%', lbl: 'of Global NPP Export Construction' },
      { val: '38%', lbl: 'World Uranium Enrichment Share' },
      { val: '35', lbl: 'Reactor Units Abroad (12 Countries)' },
    ],
    shortDesc: "Rosatom is Russia's state nuclear energy corporation, the world's largest generator of electricity in the country and the leading global exporter of nuclear power plant construction, uranium enrichment and nuclear fuel services.",
    body: [
      "Rosatom was established in 2007, consolidating Russia's civilian and military nuclear sectors — including nuclear fuel, uranium enrichment, reactor construction, decommissioning, nuclear medicine and the world's only fleet of nuclear-powered icebreakers — into a single state corporation. It generates roughly a fifth of Russia's total electricity and holds a 38% share of the global uranium enrichment market.",
      "Internationally, Rosatom is responsible for approximately 76% of nuclear power plants currently under construction outside Russia, with 35 reactor units at various stages of development across 12 countries as of recent counts. A 2020 strategy update also directed Rosatom toward wind power and hydrogen as adjacent business lines. Rosatom is a wholly state-owned Russian corporation. (Figures pending verification.)",
    ],
    tags: ['☢️ Nuclear', '🌍 + Global Reactor Exports', '🇷🇺 Russia', 'State-Owned'],
  },
  {
    id: 'rushydro', name: 'RusHydro', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 204,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Russia's largest hydropower operator, running more than 70 plants including Sayano-Shushenskaya, the country's biggest.",
    stats: [
      { val: '36.5 GW', lbl: 'Installed Capacity' },
      { val: '70+', lbl: 'Hydroelectric Facilities' },
      { val: '1993', lbl: 'Founded' },
    ],
    shortDesc: "RusHydro is Russia's largest hydropower company, operating more than 70 hydroelectric plants across Russia and Armenia, alongside geothermal generation in Kamchatka and pumped-storage capacity near Moscow.",
    body: [
      "RusHydro operates more than 70 hydroelectric facilities with a combined 36.5 GW of installed capacity, including Sayano-Shushenskaya in Siberia, Russia's largest hydropower plant. Its portfolio also extends to geothermal power plants in Kamchatka and the Zagorskaya pumped-storage plant in the Moscow region.",
      "Through its controlling stake in RAO Energy System of the East, RusHydro also operates roughly 8.8 GW of heat and power generation assets in Russia's Far East, and co-manages two hydroelectric plants in Nigeria. The Russian Federation holds a majority stake of roughly 67%. RusHydro is listed on the Moscow Exchange. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🌋 + Geothermal & Pumped Storage', '🇷🇺 Russia', 'MCX: HYDR'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // AUSTRALIA 🇦🇺 — eighteenth country-wise batch (user request). Legal
  // names verified individually. Fortescue's entry states its real,
  // documented retreat from green hydrogen honestly — cancelled US and
  // Australian projects, 700 jobs cut in 2024 — rather than presenting
  // it as an unambiguous green hydrogen success story.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'fortescue', name: 'Fortescue Ltd', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 205,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "World's fourth-largest iron ore producer that bet big on green hydrogen, then scaled the bet back significantly in 2024.",
    stats: [
      { val: '#4', lbl: 'Global Iron Ore Producer' },
      { val: '2028', lbl: 'Target: Fossil-Free Mining' },
      { val: '700', lbl: 'Jobs Cut (2024, Hydrogen Slowdown)' },
    ],
    shortDesc: "Fortescue is a major iron ore miner that has invested heavily in green hydrogen, green ammonia and green iron through its energy division, while significantly scaling back several flagship hydrogen projects amid high costs and limited customer demand.",
    body: [
      "Fortescue, renamed from Fortescue Metals Group in November 2023, grew from a startup in 2008 into the world's fourth-largest iron ore producer. In 2020, the company launched ambitious plans to become a green energy pioneer, investing in green hydrogen, ammonia and iron projects across Australia, the US, Brazil, Kenya and Norway, and building out its Pilbara Energy Connect solar, wind and battery infrastructure to decarbonise its own mining operations, targeting fossil-fuel-free mining by 2028.",
      "In 2024, however, Fortescue cut roughly 700 jobs and significantly scaled back its green hydrogen ambitions, cancelling major projects in the US and Australia and citing high costs and a lack of committed customers — though founder Andrew Forrest has stated the company remains committed to the sector longer-term. Fortescue is listed on the ASX. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '⚛️ Hydrogen Bet Scaled Back', '🇦🇺 Australia', 'ASX: FMG'],
  },
  {
    id: 'pilbara-minerals', name: 'Pilbara Minerals Limited', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 206,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "World's largest independent hard-rock lithium operation, supplying the raw material behind the global battery supply chain.",
    stats: [
      { val: '#1', lbl: 'Independent Hard-Rock Lithium Op' },
      { val: '$1.9B', lbl: 'Revenue (2024)' },
      { val: '6+', lbl: 'Global Battery Partners' },
    ],
    shortDesc: "Pilbara Minerals owns and operates the Pilgangoora Project in Western Australia, the world's largest independent hard-rock lithium operation, supplying spodumene concentrate that feeds directly into the global lithium-ion battery supply chain.",
    body: [
      "Pilbara Minerals owns 100% of the Pilgangoora Project near Port Hedland in Western Australia's resource-rich Pilbara region, producing spodumene and tantalite concentrate across two processing plants. Western Australia is the world's largest exporter of hard-rock lithium, and Pilbara Minerals is the leading pure-play lithium company listed on the ASX.",
      "The scale and quality of the Pilgangoora operation has attracted a consortium of major global battery and automotive partners, including Ganfeng Lithium, CATL, POSCO and Great Wall Motor Company. The Australian government has backed the project's expansion with up to $250 million in loans through the Northern Australia Infrastructure Facility and Export Finance Australia. Pilbara Minerals is listed on the ASX. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '⛏️ + Lithium Supply Chain', '🇦🇺 Australia', 'ASX: PLS'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // SOUTH AFRICA 🇿🇦 — nineteenth country-wise batch (user request). Legal
  // names verified individually. Sasol's entry states its fossil-fuel core
  // business honestly — it is South Africa's single largest greenhouse gas
  // emitter — rather than presenting it as a clean-energy company by
  // virtue of its hydrogen ambitions alone. Eskom, the obvious state
  // utility pick, was deliberately excluded: it is overwhelmingly coal-
  // fired and best known domestically for rolling blackouts, without a
  // clean-energy story substantial enough to include on this roster's
  // terms.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'sasol', name: 'Sasol Limited', sector: 'Hydrogen', cat: 'hydrogen', emoji: '⚛️',
    featured: false, rank: 207,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a4a80)',
    tagline: "South Africa's largest single greenhouse gas emitter is also leading the country's green hydrogen export ambitions.",
    stats: [
      { val: '1,200 MW', lbl: 'Renewable Target (2030)' },
      { val: '100,000 tonnes', lbl: 'Planned Green H₂ Exports' },
      { val: '1950', lbl: 'Founded' },
    ],
    shortDesc: "Sasol is an integrated South African energy and chemicals company, built on coal-to-liquid fuel technology developed during apartheid, now leading government-backed feasibility studies for green hydrogen and ammonia export at national scale.",
    body: [
      "Sasol should be understood plainly first: it is South Africa's largest single emitter of greenhouse gases and one of roughly 100 companies worldwide identified as contributing to more than 70% of global emissions, built on Fischer-Tropsch coal-to-liquid fuel technology developed during the apartheid era. That context is essential to understanding what its hydrogen pivot actually represents.",
      "Sasol has signed renewable power purchase agreements totalling hundreds of megawatts to support green hydrogen production at its Sasolburg site, targets 1,200 MW of renewable capacity by 2030, and is leading a government-backed feasibility study for the Boegoebaai Green Hydrogen Project — a proposed export hub for green hydrogen and ammonia on South Africa's northwest coast, in partnership with the Northern Cape Development Agency and the Industrial Development Corporation. Sasol is listed on the Johannesburg Stock Exchange and NYSE. (Figures pending verification.)",
    ],
    tags: ['⚛️ Hydrogen', '🛢️ Primarily Fossil Fuel Co.', '🇿🇦 South Africa', 'JSE: SOL'],
  },
  {
    id: 'sibanye-stillwater', name: 'Sibanye Stillwater Limited', sector: 'Recycling', cat: 'recycling', emoji: '♻️',
    featured: false, rank: 208,
    stripeGrad: 'linear-gradient(135deg,#1a3d1a,#2d6b2d)',
    tagline: "One of the world's largest platinum group metal recyclers, supplying the catalyst materials that make hydrogen fuel cells work.",
    stats: [
      { val: '#1-3', lbl: 'Global Platinum/Palladium/Rhodium Producer' },
      { val: '75%', lbl: 'of World\'s Known PGM Reserves (SA)' },
      { val: '2013', lbl: 'Founded' },
    ],
    shortDesc: "Sibanye-Stillwater mines and recycles platinum group metals — the essential catalyst materials in hydrogen fuel cells and catalytic converters — while diversifying into battery metals including lithium.",
    body: [
      "Sibanye-Stillwater began in 2013 as Sibanye Gold, unbundled from Gold Fields, before acquiring Aquarius Platinum and Anglo American Platinum's Rustenburg operations in 2016 and the US-based Stillwater Mining Company in 2017, transforming into a diversified precious metals producer. South Africa holds roughly 75% of the world's known platinum group metal reserves — metals that serve as the essential catalyst material in most hydrogen fuel cells.",
      "The company is one of the foremost global recyclers of platinum group metals, reprocessing spent automotive catalytic converters and mine tailings to recover platinum, palladium, rhodium, iridium and ruthenium, and has more recently begun diversifying into battery metals through a lithium hydroxide project in Finland. Sibanye Stillwater is listed on the Johannesburg Stock Exchange and NYSE. (Figures pending verification.)",
    ],
    tags: ['♻️ Recycling', '⚛️ + Fuel Cell Catalysts', '🇿🇦 South Africa', 'JSE: SSW'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // NIGERIA 🇳🇬 — twentieth country-wise batch (user request). Only one
  // entry this round — a deliberate quality-over-quantity call. Husk
  // Power, prominent in Nigerian mini-grid solar, was excluded: it's a
  // US-founded company (2008) with only a Nigerian subsidiary, not a
  // genuinely Nigerian company. NNPC (state oil/gas) was researched but
  // excluded: unlike Sasol or JERA, it lacks a genuine renewable-energy
  // pivot substantial enough to include even with heavy caveats.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'arnergy', name: 'Arnergy Solar Limited', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 209, isStartup: true,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Lagos solar startup that Bill Gates personally visited, deploying systems across 35 Nigerian states as diesel prices soared.",
    stats: [
      { val: '$31M', lbl: 'Total Funding Raised' },
      { val: '1,800+', lbl: 'Systems Installed' },
      { val: '35', lbl: 'Nigerian States Served' },
    ],
    shortDesc: "Arnergy designs and deploys solar power and battery storage systems for homes, businesses and telecom base stations across Nigeria, addressing chronic grid unreliability and, since 2023, sharply rising diesel generator costs.",
    body: [
      "Arnergy was founded in 2013 by Femi Adeyemo and Kunle Odebunmi, funded initially from personal savings, to bring reliable solar power to a country where grid electricity access remains a persistent challenge. The company's Series A round in 2019 raised $9 million led by Bill Gates' Breakthrough Energy Ventures, who later visited Arnergy's Lagos office in person and praised its strategy and execution.",
      "Demand accelerated sharply after Nigeria removed its decades-old fuel subsidy in May 2023, pushing diesel prices up roughly 500% and making solar dramatically more competitive for businesses running generators. Arnergy closed an $18 million Series B round in April 2025 led by Nigerian private equity firm CardinalStone Capital Advisers, and has deployed over 1,800 systems totalling 9 MW of solar and 23 MWh of battery storage across 35 states, with a target of more than 12,000 systems by 2029. Arnergy is a venture-backed private company. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '🔋 + Battery Storage', '🇳🇬 Nigeria', 'Private'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // FREE-CHOICE BATCH — Claude-selected companies (user gave discretion),
  // spanning six new countries: Canada, Chile, UAE, Saudi Arabia, Ireland,
  // Morocco. Legal names verified individually. ACWA Power's entry notes
  // its January 2026 rebrand to "Acwa." Skipped weaker candidates in
  // Taiwan (TSEC — modest scale) and Mexico (only a Spanish Iberdrola
  // subsidiary found, not a genuinely Mexican company) rather than
  // include them at lower confidence. ESB is genuinely Irish-founded,
  // unlike Linde plc, which is only tax-domiciled in Ireland.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'brookfield-renewable', name: 'Brookfield Renewable Partners L.P.', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 210,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "One of the world's largest publicly traded renewable power platforms, with three-quarters of its generation built on hydropower.",
    stats: [
      { val: '16,000+ MW', lbl: 'Installed Capacity' },
      { val: '75%+', lbl: 'from Hydropower' },
      { val: '81', lbl: 'River Systems' },
    ],
    shortDesc: "Brookfield Renewable operates one of the world's largest publicly traded, pure-play renewable power platforms, spanning hydroelectric, wind, solar and storage facilities across North America, South America, Europe and Asia.",
    body: [
      "Brookfield Renewable, founded in 1999 and headquartered in Toronto, built its foundation on hydropower — more than 75% of its total generation still comes from hydroelectric facilities spread across 81 river systems in Canada, the United States, Brazil and Colombia. The platform has since expanded into wind, solar, distributed generation, storage, renewable natural gas and carbon capture.",
      "The company operates through a dual structure — Brookfield Renewable Partners L.P. and Brookfield Renewable Corporation — giving investors a choice between a limited partnership and a standard corporation, both tracking the same underlying business. Brookfield Renewable is listed on the NYSE and Toronto Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💧 + Hydropower Core', '🇨🇦 Canada', 'NYSE: BEP'],
  },
  {
    id: 'sqm', name: 'Sociedad Química y Minera de Chile S.A.', sector: 'Storage', cat: 'storage', emoji: '🔋',
    featured: false, rank: 211,
    stripeGrad: 'linear-gradient(135deg,#0d2a1a,#1a5c3a)',
    tagline: "One of the world's largest lithium producers, extracting brine from the Atacama salt flats that feeds the global battery supply chain.",
    stats: [
      { val: '$20.55B', lbl: 'Market Cap' },
      { val: '1968', lbl: 'Founded' },
      { val: '20+', lbl: 'Countries Served' },
    ],
    shortDesc: "SQM extracts lithium from brine at the Salar de Atacama in northern Chile, processing it into lithium carbonate and hydroxide used in battery cathode material, alongside its long-standing iodine and specialty fertilizer businesses.",
    body: [
      "SQM was constituted in 1968 in Santiago, growing from Chile's historic nitrate mining industry — dating back to the 1830s exploitation of caliche ore deposits — into a diversified producer of lithium, iodine, potassium and specialty plant nutrients. Its lithium operations draw on the Salar de Atacama, one of the world's richest lithium brine deposits, using an evaporation process that concentrates lithium-rich water over many months before chemical processing.",
      "SQM has continued expanding its global lithium footprint, incorporating new subsidiaries in India, China and North America through 2024, alongside its established Chilean operations. SQM is listed on the New York Stock Exchange and the Santiago Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🔋 Storage', '⛏️ + Lithium Supply Chain', '🇨🇱 Chile', 'NYSE: SQM'],
  },
  {
    id: 'masdar', name: 'Abu Dhabi Future Energy Company PJSC', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 212,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "UAE state clean-energy investor targeting a 100 GW global renewable portfolio by 2030, jointly owned by the country's three biggest energy players.",
    stats: [
      { val: '100 GW', lbl: 'Portfolio Target (2030)' },
      { val: '2006', lbl: 'Founded' },
      { val: '3', lbl: 'State Energy Company Owners' },
    ],
    shortDesc: "Masdar is a UAE state-owned clean energy investor, developer and operator, advancing solar, wind, storage, waste-to-energy and green hydrogen projects across dozens of countries worldwide.",
    body: [
      "Masdar (formally the Abu Dhabi Future Energy Company) was founded in 2006 as a subsidiary of Mubadala Investment Company, since restructured in December 2022 to be jointly owned by three UAE energy champions: Mubadala, ADNOC and TAQA. That ownership structure gives Masdar a notably low cost of capital for renewable development compared with many Western developers.",
      "Masdar's international portfolio spans offshore wind acquisitions in the UK, solar development in Central Asia, and battery storage in the US, alongside projects closer to home including the Loeriesfontein and Khobab wind farms in South Africa and the Dumat Al Jandal wind farm in Saudi Arabia. Masdar is a wholly state-owned UAE company. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '🌍 + Global Portfolio', '🇦🇪 UAE', 'State-Owned'],
  },
  {
    id: 'acwa-power', name: 'ACWA Power Company', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 213,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Saudi power and desalination developer building the world's largest green hydrogen plant at NEOM, now rebranding to simply 'Acwa.'",
    stats: [
      { val: '53.7 GW', lbl: 'Power Capacity (Portfolio)' },
      { val: '7.6M m³/day', lbl: 'Desalinated Water' },
      { val: '$8.4B', lbl: 'NEOM Green H₂ Investment' },
    ],
    shortDesc: "ACWA Power develops, invests in and operates power generation, water desalination and green hydrogen plants across the Middle East, Africa and Asia, and is the lead developer of the world's largest utility-scale green hydrogen facility at NEOM.",
    body: [
      "ACWA Power grew out of a 2004 venture responding to Saudi Arabia's 2002 decision to open its electricity and desalination sectors to private investment, reorganising into its current legal form in 2008 and listing on the Saudi Exchange (Tadawul) in October 2021. Its portfolio spans 77 stations across roughly a dozen countries, with an investment value of some $82.8 billion.",
      "The company leads the NEOM Green Hydrogen Project, an equal joint venture with NEOM and Air Products representing a $8.4 billion investment — the world's largest utility-scale, commercially based green hydrogen facility, powered entirely by 3.9 GW of onshore solar, wind and storage. In January 2026, ACWA Power officially rebranded its trading name to 'Acwa' as part of a broader shift from regional developer to global infrastructure platform. ACWA Power Company is listed on the Saudi Exchange. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '⚛️ + NEOM Green Hydrogen', '🇸🇦 Saudi Arabia', 'Tadawul: 2082'],
  },
  {
    id: 'esb', name: 'Electricity Supply Board', sector: 'Wind', cat: 'wind', emoji: '💨',
    featured: false, rank: 214,
    stripeGrad: 'linear-gradient(135deg,#0d2a3d,#1a5c80)',
    tagline: "Ireland's century-old state utility, whose grid now draws roughly 40% of its power from wind — described nationally as the renewable backbone.",
    stats: [
      { val: '1927', lbl: 'Founded (Statutory Corporation)' },
      { val: '~41%', lbl: 'of Ireland\'s Electricity (Wind)' },
      { val: '95%', lbl: 'Irish State Ownership' },
    ],
    shortDesc: "ESB is Ireland's state-owned electricity utility, operating generation, transmission, distribution and supply since 1927, with wind power now serving as the backbone of Ireland's renewable electricity mix.",
    body: [
      "ESB was established in 1927 as a statutory corporation under the Electricity (Supply) Act, initially built around the Shannon hydroelectric scheme at Ardnacrusha — Ireland's first large-scale power plant, which at the time supplied 80% of the country's total energy demand. Almost a century later, ESB remains a vertically integrated utility spanning generation, transmission, distribution and retail supply through its Electric Ireland brand.",
      "Wind now serves as the backbone of Ireland's renewable generation, contributing roughly 41% of the country's electricity in early 2026 as the grid surpassed 8 GW of cumulative renewable capacity — with solar, still a smaller contributor, recently becoming the third-largest source of indigenous generation. ESB is majority owned by the Government of Ireland (95%), with the remainder held by an employee share ownership trust. (Figures pending verification.)",
    ],
    tags: ['💨 Wind', '⚡ + Ardnacrusha Hydro Legacy', '🇮🇪 Ireland', 'State-Owned'],
  },
  {
    id: 'masen', name: 'Moroccan Agency for Sustainable Energy S.A.', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 215,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "Operator of Noor Ouarzazate, one of the world's largest concentrated solar complexes, built to end Morocco's near-total dependence on imported fuel.",
    stats: [
      { val: '52%', lbl: 'Renewable Target (2030)' },
      { val: '2.5M tonnes', lbl: 'Oil Displaced Annually' },
      { val: '97%', lbl: 'Prior Fossil Fuel Import Dependence' },
    ],
    shortDesc: "Masen is Morocco's state-owned renewable energy agency, leading development of the Noor Ouarzazate solar complex and the country's broader solar, wind and hydro programme aimed at ending its historic dependence on imported fossil fuels.",
    body: [
      "Masen was created in 2010 to lead Morocco's national solar strategy at a time when the country imported more than 97% of its energy, making it one of the region's most fossil-fuel-dependent economies. Its flagship project, the Noor Ouarzazate solar complex, began with the 160 MW Noor I concentrated solar power plant and expanded through Noor II, III and IV, becoming one of the largest solar installations of its kind in the world and displacing an estimated 2.5 million tonnes of oil-equivalent fossil fuel imports a year.",
      "Masen's mandate has since broadened to wind and hydropower alongside solar, and the agency now oversees Morocco's roadmap for green hydrogen, working toward a national target of 52% renewable electricity capacity by 2030. Masen received the UN Environment Programme's Champions of the Earth award in 2016. It is a Moroccan state-owned limited company. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '⚛️ + Green Hydrogen Roadmap', '🇲🇦 Morocco', 'State-Owned'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // FREE-CHOICE BATCH #2 — Claude-selected companies spanning three new
  // countries: Kenya, Iceland, Qatar. Legal names verified individually.
  // Several researched candidates were deliberately excluded this round:
  // Lithium Argentina AG (legally Swiss-domiciled in Zug since Jan 2025,
  // despite operating in Argentina), VinEnergo of Vietnam (founded only
  // March 2025, with its flagship project actually a large gas-fired
  // plant), and Egypt's NREA (a regulatory/land-allocation authority
  // rather than an operating company with its own generation assets).
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'kengen', name: 'Kenya Electricity Generating Company PLC', sector: 'Environment', cat: 'environment', emoji: '🌋',
    featured: false, rank: 216,
    stripeGrad: 'linear-gradient(135deg,#3d1a0d,#802e10)',
    tagline: "Africa's geothermal leader, tapping the Rift Valley for baseload clean power and now expanding its renewable pipeline more than three-fold.",
    stats: [
      { val: '754 MW', lbl: 'Geothermal Capacity' },
      { val: '5,500 MW', lbl: 'New Pipeline Target' },
      { val: '~60%', lbl: 'of Kenya\'s Electricity' },
    ],
    shortDesc: "KenGen is East Africa's leading power producer, supplying roughly 60% of Kenya's electricity from a generation mix anchored by hydro and Africa-leading geothermal capacity harnessed from the Rift Valley.",
    body: [
      "KenGen, founded in 1954, generates the large majority of Kenya's electricity through a mix led by hydropower (826 MW) and geothermal (754 MW), drawing on the geologically active Rift Valley to position itself as Africa's geothermal leader, with a smaller wind and thermal contribution rounding out its 1,786 MW installed base.",
      "In 2026, KenGen significantly recalibrated its ambitions, expanding its renewable development pipeline from a prior 1,500 MW target to 5,500 MW, and has separately explored nuclear power as part of Kenya's longer-term energy strategy. Kenya Electricity Generating Company is listed on the Nairobi Securities Exchange. (Figures pending verification.)",
    ],
    tags: ['🌋 Environment', '🌍 Africa\'s Geothermal Leader', '🇰🇪 Kenya', 'NSE: KEGN'],
  },
  {
    id: 'landsvirkjun', name: 'Landsvirkjun', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 217,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Iceland's national power company, generating roughly 70% of the country's electricity — itself already nearly 100% renewable.",
    stats: [
      { val: '~70%', lbl: 'of Iceland\'s Electricity' },
      { val: '96%+', lbl: 'of National Hydro Generation' },
      { val: '21', lbl: 'Power Plants Operated' },
    ],
    shortDesc: "Landsvirkjun, the National Power Company of Iceland, operates 21 hydroelectric, geothermal and wind power stations, generating the large majority of a national grid that already draws close to 100% of its electricity from renewable sources.",
    body: [
      "Landsvirkjun was founded in 1965 by the Icelandic state and the city of Reykjavík, initially built around hydropower stations on the Sog River before expanding across the country with major projects including Búrfell, Sigalda and Hrauneyjafoss. The company is now wholly owned by the state of Iceland and generates roughly 70% of the nation's electricity, drawing more than 96% of that from hydropower alone.",
      "Iceland's electricity sector already runs almost entirely on renewable sources — the highest share of any national energy budget in the world — and Landsvirkjun has continued diversifying into geothermal and, more recently, wind, while supplying power to energy-intensive industries and Iceland's growing data centre sector, drawn by the country's natural cooling climate and abundant clean power. Landsvirkjun is a state-owned public partnership. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🌋 + Geothermal & Wind', '🇮🇸 Iceland', 'State-Owned'],
  },
  {
    id: 'kahramaa', name: 'Qatar General Electricity & Water Corporation', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 218,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Qatar's sole electricity and water utility, whose Al Kharsaah plant was the country's first large-scale solar facility.",
    stats: [
      { val: '800 MWdc', lbl: 'Al Kharsaah Solar Plant' },
      { val: '4 GW', lbl: 'Renewable Target (2030)' },
      { val: '18%', lbl: 'Renewable Electricity Share Target' },
    ],
    shortDesc: "Kahramaa is Qatar's sole transmission and distribution utility for both electricity and water, leading the country's shift toward solar power through the Qatar National Renewable Energy Strategy.",
    body: [
      "Kahramaa (the Qatar General Electricity & Water Corporation) built the country's first large-scale solar facility, the 800 MWdc Al Kharsaah Solar Power Plant, developed under a build-own-operate-transfer model with power sold back to Kahramaa under a 25-year agreement before ownership transfers to the utility.",
      "Under the Qatar National Renewable Energy Strategy, launched in April 2024, Kahramaa is targeting roughly 4 GW of utility-scale renewable capacity and an 18% renewable electricity share by 2030, alongside a distributed solar programme (BeSolar) that lets households and businesses sell surplus rooftop solar power back to the grid. Kahramaa is Qatar's state utility corporation. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '☀️ + Solar Buildout', '🇶🇦 Qatar', 'State-Owned'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // FREE-CHOICE BATCH #3 — Claude-selected companies spanning four new
  // countries: Malaysia, Thailand, Philippines, Colombia. Legal names
  // verified individually. Gulf Development's entry notes both its Jan
  // 2024 rename (from Gulf Energy Development) and its genuinely mixed
  // gas/renewables business, rather than presenting it as clean-only.
  // Peru's Inkia Energy was researched but skipped — it's controlled by
  // a global infrastructure investor (I Squared Capital) rather than
  // being a clearly Peruvian-domiciled company; Celsia's own expansion
  // into Peru is noted within the Colombia entry instead.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'tenaga-nasional', name: 'Tenaga Nasional Berhad', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 219,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Peninsular Malaysia's sole electric utility, running biomass, biogas and hydro-floating-solar joint ventures at home while operating renewables abroad.",
    stats: [
      { val: '11M', lbl: 'Customers Served' },
      { val: '1949', lbl: 'Founded' },
      { val: '5', lbl: 'Countries of Renewable Operations' },
    ],
    shortDesc: "Tenaga Nasional (TNB) is the sole electric utility in Peninsular Malaysia, serving roughly 11 million customers, with a growing portfolio of domestic biomass, biogas and solar joint ventures alongside renewable energy operations in the UK, Australia, Turkey, Kuwait and Ireland.",
    body: [
      "Tenaga Nasional, founded in 1949 and listed since 1992, is a state-linked national utility serving nearly 11 million customers across Peninsular Malaysia. Domestically, TNB has formed joint ventures for biomass power stations with Felda, biogas plants with Sime Darby and Worldwide Holdings, and developed the country's first large-scale solar project, a 50 MW facility in Kuala Langat, Selangor.",
      "The company has also built an international renewable energy presence, holding generation assets in the United Kingdom, Australia, Turkey, Kuwait and Ireland. TNB is listed on Bursa Malaysia. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '☀️ + Biomass, Biogas & Solar', '🇲🇾 Malaysia', 'MYX: 5347'],
  },
  {
    id: 'gulf-development', name: 'Gulf Development Public Company Limited', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 220,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Thai energy and infrastructure conglomerate securing $1.9 billion to build 27 renewable projects, though still substantially anchored in gas-fired power.",
    stats: [
      { val: '$1.9B', lbl: 'Renewable Financing Secured' },
      { val: '939 MW', lbl: 'Contracted Renewable Capacity' },
      { val: '2011', lbl: 'Founded' },
    ],
    shortDesc: "Gulf Development is a Thai holding company spanning gas-fired power generation, a growing renewable energy business, telecommunications and digital infrastructure — worth noting plainly that gas-fired generation remains a substantial part of its core business alongside its renewables expansion.",
    body: [
      "Gulf Development, founded in 2011 by Sarath Ratanavadi and renamed from Gulf Energy Development in 2024, built its foundation on gas-fired power generation and gas infrastructure, which remains a substantial part of the business — the company signed a new long-term LNG supply agreement with Eni as recently as December 2025.",
      "Alongside that, its renewable arm Gulf Renewable Energy Company Limited secured a THB 60 billion (roughly $1.9 billion) loan facility in February 2026 to develop 27 renewable projects totalling 939 MW of contracted capacity, following an earlier $820 million Asian Development Bank loan for a 12-project solar and storage portfolio. Gulf Development is listed on the Stock Exchange of Thailand. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '🔥 + Gas-Fired Core Business', '🇹🇭 Thailand', 'SET: GULF'],
  },
  {
    id: 'acen', name: 'ACEN Corporation', sector: 'Solar', cat: 'solar', emoji: '☀️',
    featured: false, rank: 221,
    stripeGrad: 'linear-gradient(135deg,#2a1200,#6b3a00)',
    tagline: "The energy arm of the Philippines' Ayala Group, with roughly 7,000 MW of attributable renewable capacity across Southeast Asia and Australia.",
    stats: [
      { val: '~7,000 MW', lbl: 'Attributable Renewable Capacity' },
      { val: '2011', lbl: 'Founded (as AC Energy)' },
      { val: '5+', lbl: 'Countries of Operation' },
    ],
    shortDesc: "ACEN, formerly AC Energy, is the renewable energy arm of the Philippines' Ayala Group, developing solar and wind projects across the Philippines, Vietnam, Indonesia, India and Australia.",
    body: [
      "ACEN was founded in 2011 as AC Energy under Ayala Corporation, one of the Philippines' oldest and largest conglomerates, and has grown into a pure-play renewable energy developer with roughly 7,000 MW of attributable solar and wind capacity across the Philippines and expanding markets including Vietnam, Indonesia, India and Australia, the latter through its ACEN Australia subsidiary.",
      "ACEN is listed on the Philippine Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['☀️ Solar', '💨 + Wind', '🇵🇭 Philippines', 'PSE: ACEN'],
  },
  {
    id: 'celsia', name: 'Celsia S.A. E.S.P.', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 222,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Colombian power company built on hydro, now investing $1.2 billion to become a leading renewable developer in neighboring Peru.",
    stats: [
      { val: '1,756 MW', lbl: 'Operational Capacity' },
      { val: '$1.2B', lbl: 'Peru Investment Plan' },
      { val: '2001', lbl: 'Founded (as Celsia)' },
    ],
    shortDesc: "Celsia generates, transmits and distributes electricity in Colombia and, increasingly, Peru, anchored by major hydroelectric plants and a growing solar and wind portfolio, controlled by Colombian conglomerate Grupo Argos.",
    body: [
      "Celsia, controlled by Grupo Argos and tracing back to 2001 (as Colinversiones), operates a 1,756 MW portfolio anchored by hydroelectric plants including the 429 MW Alban project and the 315 MW Salvajina plant — reflecting Colombia's own grid, which draws roughly 74% of its generation from hydropower. The company has also added meaningful solar capacity, and commissioned a 210 MW gas-fired plant in 2023, worth noting alongside its clean-energy growth.",
      "In 2023, Celsia entered the Peruvian market by acquiring the 218 MW Caraveli wind project for around $240 million, and has since launched an investment platform targeting more than $1.2 billion in Peruvian renewable projects. Celsia is listed on the Colombia Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '💨 + Peru Expansion', '🇨🇴 Colombia', 'BVC: CELSIA'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // POLICY CATEGORY LAUNCH — user-requested category, previously completely
  // empty despite being a built-in site category. These are institutions
  // that implement, fund or shape renewable energy policy rather than
  // generate power or manufacture technology themselves — government
  // agencies, treaty organizations and public financing bodies. Legal
  // names and institutional structures verified individually.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'seci', name: 'Solar Energy Corporation of India Limited', sector: 'Policy', cat: 'policy', emoji: '📋',
    featured: false, rank: 223,
    stripeGrad: 'linear-gradient(135deg,#3d2a0d,#805c1a)',
    tagline: "India's foremost renewable energy implementing agency, having awarded nearly 70 GW of generation capacity through competitive tenders.",
    stats: [
      { val: '69.25 GW', lbl: 'Cumulative Capacity Awarded' },
      { val: '42B+ Units', lbl: 'Annual Power Trading Volume' },
      { val: '2011', lbl: 'Founded' },
    ],
    shortDesc: "SECI is India's foremost Renewable Energy Implementing Agency, running competitive tenders that select developers for solar, wind and hybrid projects nationwide and acting as an intermediary power trader between developers and state utilities.",
    body: [
      "SECI was incorporated in 2011 as a not-for-profit entity to implement India's National Solar Mission, converting to a commercial public sector company in 2015 as its mandate broadened across the full renewable energy domain. Rather than primarily building and owning power plants itself, SECI's core role is running tenders that select private developers for solar, wind and hybrid projects, then acting as the intermediary buyer that signs long-term power purchase agreements with developers and power sale agreements with state electricity distribution companies.",
      "SECI pioneered several project structures that reshaped India's renewable market, including solar-wind hybrid tenders and round-the-clock renewable power supply models. In 2024, on completing 13 years of operation, SECI was elevated to Navratna status — the highest autonomy tier available to India's central public sector enterprises. SECI operates under India's Ministry of New and Renewable Energy. (Figures pending verification.)",
    ],
    tags: ['📋 Policy', '☀️ + Tender & Trading Agency', '🇮🇳 India', 'CPSE'],
  },
  {
    id: 'irena', name: 'International Renewable Energy Agency', sector: 'Policy', cat: 'policy', emoji: '📋',
    featured: false, rank: 224,
    stripeGrad: 'linear-gradient(135deg,#3d2a0d,#805c1a)',
    tagline: "The first intergovernmental organization dedicated exclusively to renewable energy, with 169 member states plus the EU.",
    stats: [
      { val: '169', lbl: 'Member States + EU' },
      { val: '2009', lbl: 'Founded' },
      { val: '$55M', lbl: 'Annual Budget (2022)' },
    ],
    shortDesc: "IRENA is an intergovernmental treaty organization mandated to facilitate cooperation, advance knowledge and promote the global adoption of renewable energy, serving as an official United Nations observer and the world's central forum for renewable energy policy.",
    body: [
      "IRENA was founded in 2009, with its founding statute entering into force in July 2010, becoming the first international organization to focus exclusively on renewable energy across both industrialized and developing countries. The idea traces back conceptually to the 1980 Brandt Report, though it took nearly three decades to become reality.",
      "Headquartered in Masdar City, Abu Dhabi, IRENA now counts 169 member states plus the European Union, publishing widely cited data and analysis on renewable capacity, costs and employment, and coordinating international policy dialogue. In 2023, the UN General Assembly declared January 26 the International Day of Clean Energy, marking IRENA's founding anniversary. IRENA is a treaty organization and UN observer. (Figures pending verification.)",
    ],
    tags: ['📋 Policy', '🌍 Global Renewable Energy Body', '🇦🇪 International (UAE HQ)', 'Treaty Org'],
  },
  {
    id: 'dena', name: 'Deutsche Energie-Agentur GmbH', sector: 'Policy', cat: 'policy', emoji: '📋',
    featured: false, rank: 225,
    stripeGrad: 'linear-gradient(135deg,#3d2a0d,#805c1a)',
    tagline: "Germany's energy transition think tank, jointly owned by the federal government and major private financial institutions.",
    stats: [
      { val: '2000', lbl: 'Founded' },
      { val: '30+', lbl: 'Nationalities on Staff' },
      { val: '50%', lbl: 'Federal Government Stake' },
    ],
    shortDesc: "dena (the German Energy Agency) is Germany's centre of expertise for energy efficiency, renewable energy and intelligent energy systems, advising government, industry and consumers on implementing the country's energy transition.",
    body: [
      "dena was established in September 2000 by the Federal Ministry of Economics to implement measures under Germany's Climate Protection Programme. Rather than being a subordinate government agency, dena was deliberately structured as a GmbH (private limited company) with mixed public and private ownership: the Federal Republic of Germany holds 50%, with the remainder split among KfW development bank (26%), Deutsche Bank, DZ Bank and Allianz SE (8% each).",
      "dena runs pilot projects, advises policymakers and industry, operates a public energy advice hotline, and coordinates international cooperation — including leading preparation for the 2026 North Sea Summit on offshore wind expansion and cross-border grid interconnectors, commissioned by the Federal Ministry for Economic Affairs and Climate Action. dena is a German public-private limited company. (Figures pending verification.)",
    ],
    tags: ['📋 Policy', '💨 + Offshore Wind Coordination', '🇩🇪 Germany', 'Public-Private GmbH'],
  },
  {
    id: 'nea-china', name: 'National Energy Administration', sector: 'Policy', cat: 'policy', emoji: '📋',
    featured: false, rank: 226,
    stripeGrad: 'linear-gradient(135deg,#3d2a0d,#805c1a)',
    tagline: "China's national energy regulator, shaping the policies behind the world's largest renewable energy buildout.",
    stats: [
      { val: '2008', lbl: 'Founded' },
      { val: '9', lbl: 'Internal Policy Departments' },
      { val: '1', lbl: 'of 2 Bodies Regulating China\'s Power Sector' },
    ],
    shortDesc: "The National Energy Administration is China's national energy bureau, forming energy strategy, drafting regulations and administering the policy framework behind China's solar, wind and broader power sectors.",
    body: [
      "The National Energy Administration was formally established in August 2008 under China's National Development and Reform Commission (NDRC), consolidating a National Energy Leading Group Office that had operated since 2005. Uniquely among agencies managed by Chinese ministries and commissions, the NEA was granted its own separate party group, giving it greater autonomy over organization and personnel than is typical for a national bureau.",
      "Structured across nine internal departments including a dedicated New Energy and Renewable Energy Department, the NEA sets energy strategy, proposes reform measures and administers sector regulation across coal, oil and gas, and electricity — including the policy framework underpinning China's position as the world's largest builder of solar and wind capacity. The NEA is a Chinese government bureau under the NDRC. (Figures pending verification.)",
    ],
    tags: ['📋 Policy', '⚡ + National Energy Strategy', '🇨🇳 China', 'Government Bureau'],
  },
  {
    id: 'doe-lpo', name: 'U.S. Department of Energy Loan Programs Office', sector: 'Policy', cat: 'policy', emoji: '📋',
    featured: false, rank: 227,
    stripeGrad: 'linear-gradient(135deg,#3d2a0d,#805c1a)',
    tagline: "The federal financing arm that helped fund Tesla's earliest factory loans, now central to the debate over America's clean energy competitiveness.",
    stats: [
      { val: '2007', lbl: 'Loan Guarantee Program Founded' },
      { val: '2', lbl: 'Statutory Programs (1703 & 1705)' },
      { val: '2025', lbl: 'Congressional Fight Over Obligations' },
    ],
    shortDesc: "The DOE Loan Programs Office provides loan guarantees and direct loans for large-scale clean energy, energy infrastructure and advanced vehicle manufacturing projects that private capital markets often consider too novel or capital-intensive to finance alone.",
    body: [
      "The Loan Programs Office administers federal loan guarantee authority established in 2005, financing large-scale clean energy and advanced transportation manufacturing projects under statutory Section 1703 and 1705 programs. Its early loan guarantees, made in the years following the 2008 financial crisis when private lending for unproven clean-energy manufacturing was scarce, included support that helped Tesla build out its first US factory capacity.",
      "In February 2025, 25 members of the US Congress wrote to the Department of Energy warning that cancelling LPO loan obligations would be both illegal and damaging to American competitiveness, explicitly citing China's dominance in new energy technology as the stakes of the office's continued operation — reflecting how contested US clean-energy financing policy has become. The LPO is a component of the US Department of Energy. (Figures pending verification.)",
    ],
    tags: ['📋 Policy', '💰 + Clean Energy Financing', '🇺🇸 USA', 'Federal Office'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // POLICY CATEGORY, ROUND 2 — continuing the user-requested build-out with
  // Australia, Japan, France and Brazil. Legal names and institutional
  // structures verified individually. ADEME's entry notes a genuinely
  // live French political controversy over its possible abolition,
  // rather than presenting it as an uncontested settled institution.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'arena-australia', name: 'Australian Renewable Energy Agency', sector: 'Policy', cat: 'policy', emoji: '📋',
    featured: false, rank: 228,
    stripeGrad: 'linear-gradient(135deg,#3d2a0d,#805c1a)',
    tagline: "Australia's dedicated renewable energy funding agency, with roughly $3 billion to invest across early research through to commercial-scale demonstration.",
    stats: [
      { val: '~$3B', lbl: 'Investment Capacity' },
      { val: '2012', lbl: 'Founded' },
      { val: '90', lbl: 'Staff (approx.)' },
    ],
    shortDesc: "ARENA is an independent Australian government agency that funds renewable energy projects from early-stage laboratory research through to later-stage commercial demonstration, aiming to improve the competitiveness and supply of renewable energy nationally.",
    body: [
      "ARENA was established under the Australian Renewable Energy Agency Act 2012 and began operating on 1 July 2012, consolidating programmes previously run by the Australian Centre for Renewable Energy, the Australian Solar Institute and the Department of Resources, Energy and Tourism. It operates as a corporate Commonwealth entity and specialist direct investment vehicle, governed by its own board, with roughly $3 billion available to invest in renewable energy projects.",
      "ARENA was created alongside the separate Clean Energy Finance Corporation as part of Australia's 'Clean Energy Future' policy package, and supports the government's target of reducing emissions 62 to 70% below 2005 levels by 2035. The Minister for Climate Change and Energy holds ministerial responsibility for the agency. ARENA is an Australian government statutory authority. (Figures pending verification.)",
    ],
    tags: ['📋 Policy', '💰 + Direct Investment Vehicle', '🇦🇺 Australia', 'Statutory Authority'],
  },
  {
    id: 'nedo-japan', name: 'New Energy and Industrial Technology Development Organization', sector: 'Policy', cat: 'policy', emoji: '📋',
    featured: false, rank: 229,
    stripeGrad: 'linear-gradient(135deg,#3d2a0d,#805c1a)',
    tagline: "Japan's largest public R&D funding body, running international offices from Silicon Valley to New Delhi and a multibillion-dollar Green Innovation Fund.",
    stats: [
      { val: '~1,000', lbl: 'Staff' },
      { val: '7', lbl: 'International Offices' },
      { val: '1980', lbl: 'Founded' },
    ],
    shortDesc: "NEDO is Japan's largest public organization funding and coordinating research, development and deployment of industrial, energy and environmental technologies, run mainly through Japan's Ministry of Economy, Trade and Industry.",
    body: [
      "NEDO was established in 1980 and reorganized in 2003 as an Independent Administrative Institution, funded predominantly by Japan's Ministry of Economy, Trade and Industry (METI). Headquartered in Kawasaki, near Tokyo, the organization maintains international offices in Washington D.C., Silicon Valley, Paris, Beijing, Bangkok, Jakarta and New Delhi, and has funded projects abroad, including a smart-grid research facility at Los Alamos National Laboratory in New Mexico.",
      "NEDO now administers Japan's Green Innovation Fund, a multi-year programme directing substantial public capital toward technologies needed to reach carbon neutrality, spanning areas from offshore wind and hydrogen to next-generation batteries and industrial decarbonisation. NEDO is a Japanese Independent Administrative Institution. (Figures pending verification.)",
    ],
    tags: ['📋 Policy', '🔬 + Green Innovation Fund', '🇯🇵 Japan', 'Independent Admin. Institution'],
  },
  {
    id: 'ademe', name: 'Agence de la transition écologique', sector: 'Policy', cat: 'policy', emoji: '📋',
    featured: false, rank: 230,
    stripeGrad: 'linear-gradient(135deg,#3d2a0d,#805c1a)',
    tagline: "France's ecological transition agency, funding renewables and efficiency projects nationwide — while facing a live 2025 political push for its abolition.",
    stats: [
      { val: '€4B', lbl: '2024 Operating Budget' },
      { val: '26', lbl: 'Regional Agencies' },
      { val: '30+', lbl: 'Years in Operation' },
    ],
    shortDesc: "ADEME is a French public agency that funds and advises on projects spanning renewable energy, energy efficiency, waste management, air quality and soil preservation, operating under the joint authority of France's ecological transition and research ministries.",
    body: [
      "ADEME operates as an établissement public à caractère industriel et commercial (EPIC) — a French public body with commercial-style operations — providing grants, subsidies and expert advisory services to businesses, local governments and the public across renewable energy, energy efficiency and broader ecological transition projects, with a 2024 operating budget of roughly €4 billion spread across 26 regional agencies covering France's 13 administrative regions.",
      "Worth noting plainly: ADEME's future is currently a live political question in France. A July 2025 French Senate report criticized the agency's EPIC status, operating costs and structural overlap with regional environmental directorates (DREAL), and a September 2025 parliamentary question formally asked the government whether it intends to abolish ADEME and fold its functions elsewhere. As of this writing, ADEME continues to operate. ADEME is a French public establishment. (Figures pending verification.)",
    ],
    tags: ['📋 Policy', '⚠️ Abolition Debate Underway', '🇫🇷 France', 'Public EPIC'],
  },
  {
    id: 'epe-brazil', name: 'Empresa de Pesquisa Energética', sector: 'Policy', cat: 'policy', emoji: '📋',
    featured: false, rank: 231,
    stripeGrad: 'linear-gradient(135deg,#3d2a0d,#805c1a)',
    tagline: "Brazil's national energy planning body, coordinating studies across five other agencies to shape the country's long-term energy supply strategy.",
    stats: [
      { val: '2004', lbl: 'Founded' },
      { val: '5', lbl: 'Partner Regulatory Agencies' },
      { val: 'Rio de Janeiro', lbl: 'Headquarters' },
    ],
    shortDesc: "EPE is Brazil's national energy research and planning company, conducting the studies that underpin the country's long-term energy supply policy, working in close coordination with Brazil's electricity, oil and gas, and water regulators.",
    body: [
      "EPE conducts research and planning for Brazil's national energy sector, producing the studies and analysis that inform the country's long-term energy supply strategy and procedures. Rather than regulating or generating power itself, EPE's role is coordination and planning, working closely with Brazil's Ministry of Mines and Energy, the National Agency of Electric Energy (ANEEL), the National Agency of Oil, Gas and Biofuels (ANP), the National Water Agency (ANA), the National Electric System Operator (ONS) and the Electric Energy Trading Chamber (CCEE).",
      "EPE is headquartered in Rio de Janeiro and has played an active role in major discussions shaping Brazil's energy sector since its founding. EPE is a Brazilian state-linked public company. (Figures pending verification.)",
    ],
    tags: ['📋 Policy', '📊 + National Energy Planning', '🇧🇷 Brazil', 'State-Linked'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // INDIA AGRIBUSINESS BATCH — user-supplied list of 34 Indian agri
  // companies across 7 segments. 4 were already in the roster (Kaveri
  // Seed, UPL, Godrej Agrovet, Balrampur Chini Mills) and are skipped
  // here. "Bombay Super Hybrid Seeds" could not be verified through any
  // source — no CIN, ticker, or corporate registry match found — and is
  // excluded rather than guessed. All 29 entries below had their legal
  // names verified individually (CIN/registry records, exchange filings).
  // Categorized as Agri except sugar/ethanol producers, filed as Bio
  // given their fuel-ethanol output.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'nath-bio-genes', name: 'Nath Bio-Genes (India) Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 232,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Flagship seed company of the Nath Group, developing hybrid and BT cotton varieties farmers have grown for over two decades.",
    stats: [ { val: '1993', lbl: 'Founded' }, { val: '16', lbl: 'Business Centres' }, { val: '2,000+', lbl: 'Distributors' } ],
    shortDesc: "Nath Bio-Genes produces, processes and markets hybrid and GM seeds for field crops, vegetables and plant nutrient supplements, a flagship business of the diversified Nath Group.",
    body: [
      "Nath Bio-Genes was originally incorporated as Shivnath Farms Private Limited, converting to a public company and adopting its current name in 2001. The company's cotton hybrids, including its longstanding Somnath and Jagannath varieties, remain household names among Indian farmers more than two decades after launch.",
      "Nath Bio-Genes is listed on the Bombay Stock Exchange (CIN: L01110MH1993PLC072842). (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧬 Seeds & Genetics', '🇮🇳 India', 'BSE: 512573'],
  },
  {
    id: 'mangalam-seeds', name: 'Mangalam Seeds Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 233,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Gujarat seed breeder with 46 hybrid and improved varieties spanning grains, oilseeds, pulses and spices.",
    stats: [ { val: '2011', lbl: 'Founded' }, { val: '46', lbl: 'Varieties Developed' }, { val: '3', lbl: 'Research Farms' } ],
    shortDesc: "Mangalam Seeds breeds and markets hybrid and improved seed varieties across grain, oilseed, pulse, spice, fibre and vegetable crops, serving farmers across Gujarat, Rajasthan and Andhra Pradesh.",
    body: [
      "Mangalam Seeds was founded in 2011 by M.J. Patel, with its breeding programme led by agricultural scientist Dr. I.D. Patel, who has developed 46 improved and hybrid varieties over the company's history, including castor, sesame, cotton, guar and cumin varieties adapted to Gujarat's growing conditions.",
      "Mangalam Seeds is listed on Indian stock exchanges (CIN: L01112GJ2011PLC067128). (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧬 Seeds & Genetics', '🇮🇳 India', 'NSE: MANGALAM'],
  },
  {
    id: 'pi-industries', name: 'PI Industries Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 234,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Udaipur-based agrochemical and custom synthesis manufacturer, a major exporter of crop protection molecules to global agrochemical majors.",
    stats: [ { val: '—', lbl: 'Market Cap' }, { val: '1946', lbl: 'Founded' }, { val: '30+', lbl: 'Countries Exported To' } ],
    shortDesc: "PI Industries manufactures agrochemicals, custom synthesis and specialty chemicals, developing and exporting crop protection molecules for global agrochemical companies alongside its domestic branded product portfolio.",
    body: [
      "PI Industries has built a distinctive position in Indian agrochemicals through custom synthesis and manufacturing (CSM) work for multinational agrochemical companies, alongside its own branded insecticide, fungicide and herbicide products sold domestically.",
      "PI Industries is listed on the Bombay and National Stock Exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 + Custom Synthesis Exports', '🇮🇳 India', 'NSE: PIIND'],
  },
  {
    id: 'dhanuka-agritech', name: 'Dhanuka Agritech Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 235,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Crop protection company renamed from Dhanuka Pesticides in 2007, spanning herbicides, insecticides, fungicides and plant growth regulators.",
    stats: [ { val: '1985', lbl: 'Founded (as Dhanuka Pesticides)' }, { val: '2007', lbl: 'Renamed Dhanuka Agritech' } ],
    shortDesc: "Dhanuka Agritech manufactures and markets agrochemical solutions across herbicide, insecticide, fungicide and plant growth regulator categories for Indian farmers.",
    body: [
      "Dhanuka Agritech was incorporated in February 1985 as Dhanuka Pesticides Limited, adopting its current name in 2007 as its product range broadened beyond pesticides into a fuller crop protection portfolio.",
      "Dhanuka Agritech is listed on the Bombay and National Stock Exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 Crop Protection', '🇮🇳 India', 'NSE: DHANUKA'],
  },
  {
    id: 'rallis-india', name: 'Rallis India Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 236,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Tata Group crop protection and seeds company with a legacy spanning more than seven decades, subsidiary of Tata Chemicals.",
    stats: [ { val: '1948', lbl: 'Founded' }, { val: '76+', lbl: 'Years in Operation' } ],
    shortDesc: "Rallis India, a Tata Group company and subsidiary of Tata Chemicals, manufactures crop protection chemicals, seeds and speciality fertilizers, backed by an extensive rural distribution network.",
    body: [
      "Rallis India traces back to 1948 and has been part of the Tata Group ever since, building a strong position in crop care and seeds through decades of rural network development across India.",
      "Rallis India is listed on the Bombay and National Stock Exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 + Tata Group', '🇮🇳 India', 'NSE: RALLIS'],
  },
  {
    id: 'bayer-cropscience-india', name: 'Bayer CropScience Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 237,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "India's Bayer agrochemical subsidiary, in operation since 1958, manufacturing crop protection products and trading corn seeds.",
    stats: [ { val: '1958', lbl: 'India Operations Launched' }, { val: '68.58%', lbl: 'Bayer Group Stake' } ],
    shortDesc: "Bayer CropScience India manufactures and markets insecticides, fungicides, herbicides and other agrochemical products, and trades corn seeds on behalf of an affiliated Bayer seeds business.",
    body: [
      "Bayer launched its Indian agrochemical operations in 1958, converting to a public limited company in December 1996 and consolidating with Bayer CropScience India Ltd in 2003. The Bayer group retains a majority 68.58% stake in the Indian entity.",
      "Bayer CropScience is listed on the Bombay and National Stock Exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 Crop Protection', '🇮🇳 India', 'NSE: BAYERCROP'],
  },
  {
    id: 'bharat-rasayan', name: 'Bharat Rasayan Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 238,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Technical-grade pesticide and intermediate manufacturer incorporated in 1989.",
    stats: [ { val: '1989', lbl: 'Founded' } ],
    shortDesc: "Bharat Rasayan manufactures technical-grade pesticides and pesticide intermediates, supplying formulators across India's agrochemical industry.",
    body: [
      "Bharat Rasayan was incorporated as a public limited company in May 1989 for the business of manufacturing pesticides, and has grown into a recognised technical-grade pesticide and intermediate producer.",
      "Bharat Rasayan is listed on the National Stock Exchange. Its exact incorporation details beyond founding year could not be independently confirmed beyond exchange and directory listings. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 Technical Pesticides', '🇮🇳 India', 'NSE: BHARATRAS'],
  },
  {
    id: 'insecticides-india', name: 'Insecticides (India) Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 239,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "New Delhi-based agrochemical manufacturer producing insecticides, fungicides, herbicides and plant nutrients.",
    stats: [ { val: '—', lbl: 'Market Cap' } ],
    shortDesc: "Insecticides (India) manufactures and markets a range of crop protection chemicals and plant nutrient products for Indian farmers.",
    body: [
      "Insecticides (India) Limited operates as a crop protection formulator and manufacturer, part of India's broader agrochemical sector serving domestic farm input demand.",
      "Insecticides (India) is listed on the National Stock Exchange. Detailed corporate history could not be independently verified beyond exchange listings. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 Crop Protection', '🇮🇳 India', 'NSE: INSECTICID'],
  },
  {
    id: 'best-agrolife', name: 'Best Agrolife Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 240,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "New Delhi agrochemical manufacturer renamed from Sahyog Multibase in 2019, exporting technical and formulated crop protection products.",
    stats: [ { val: '1992', lbl: 'Founded (as Sahyog Multibase)' }, { val: '2019', lbl: 'Renamed Best Agrolife' } ],
    shortDesc: "Best Agrolife manufactures and sells agrochemical products in India and internationally, offering insecticides, herbicides, fungicides and plant growth regulators as technicals, intermediates and novel formulations.",
    body: [
      "Best Agrolife was incorporated in 1992 as Sahyog Multibase Limited, changing its name to Best Agrolife in October 2019 as it expanded into novel agrochemical formulations for both domestic and export markets.",
      "Best Agrolife is listed on the National Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 + Export Formulations', '🇮🇳 India', 'NSE: BESTAGRO'],
  },
  {
    id: 'astec-lifesciences', name: 'Astec LifeSciences Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 241,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Agrochemical and pharmaceutical intermediate manufacturer, part of the Godrej group of companies.",
    stats: [ { val: '—', lbl: 'Market Cap' } ],
    shortDesc: "Astec LifeSciences manufactures agrochemical technicals and pharmaceutical intermediates, serving both crop protection and pharma supply chains.",
    body: [
      "Astec LifeSciences operates as a specialty manufacturer bridging agrochemical and pharmaceutical intermediate production, part of the broader Godrej group of companies in India.",
      "Astec LifeSciences is listed on the National Stock Exchange. Detailed corporate history could not be independently verified beyond exchange listings. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 + Pharma Intermediates', '🇮🇳 India', 'NSE: ASTEC'],
  },
  {
    id: 'coromandel-international', name: 'Coromandel International Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 242,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "India's second-largest phosphatic fertilizer producer and the world's largest manufacturer of neem-based biopesticides.",
    stats: [ { val: '20M+', lbl: 'Farmers Served' }, { val: '80+', lbl: 'Countries' }, { val: '1906', lbl: 'Roots Trace To' } ],
    shortDesc: "Coromandel International, part of the Murugappa Group and a subsidiary of EID Parry, manufactures fertilizers, crop protection products and specialty nutrients, serving over 20 million farmers across more than 80 countries.",
    body: [
      "Coromandel International traces its origins to 1906, when the first fertilizer plant in India was established at Ranipet under E.I.D. Parry, and was originally incorporated as Coromandel Fertilisers. The company entered crop protection in 2006 through a stake in Ficom Organics, and is now the world's largest manufacturer of neem-based biopesticides.",
      "Coromandel International is listed on the Bombay and National Stock Exchanges, majority owned by EID Parry (62.82%) within the Murugappa Group. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🌱 + Neem Biopesticides', '🇮🇳 India', 'NSE: COROMANDEL'],
  },
  {
    id: 'paradeep-phosphates', name: 'Paradeep Phosphates Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 243,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Odisha-based phosphatic fertilizer manufacturer, one of India's largest producers of DAP and NPK complex fertilizers.",
    stats: [ { val: '—', lbl: 'Market Cap' } ],
    shortDesc: "Paradeep Phosphates manufactures phosphatic and complex fertilizers including DAP and NPK grades from its Odisha production base, supplying Indian farmers nationwide.",
    body: [
      "Paradeep Phosphates operates one of India's major phosphatic fertilizer production complexes at Paradeep, Odisha, supplying diammonium phosphate and NPK fertilizer blends to the domestic agricultural market.",
      "Paradeep Phosphates is listed on the National Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 Phosphatic Fertilizers', '🇮🇳 India', 'NSE: PARADEEP'],
  },
  {
    id: 'chambal-fertilisers', name: 'Chambal Fertilisers and Chemicals Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 244,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "New Delhi fertilizer producer manufacturing urea and complex fertilizers alongside crop protection chemicals under its Uttam brand.",
    stats: [ { val: '1985', lbl: 'Incorporated' } ],
    shortDesc: "Chambal Fertilisers and Chemicals produces and sells urea, DAP, muriate of potash and NPK fertilizers, alongside technical-grade agrochemicals and formulated crop protection products marketed under its Uttam brand.",
    body: [
      "Chambal Fertilisers and Chemicals operates across own-manufactured fertilizers, complex fertilizers, and crop protection chemical segments, supplying agri-inputs to farmers nationwide from its New Delhi headquarters.",
      "Chambal Fertilisers and Chemicals is listed on the National Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 + Uttam Crop Protection', '🇮🇳 India', 'NSE: CHAMBLFERT'],
  },
  {
    id: 'gsfc', name: 'Gujarat State Fertilizers & Chemicals Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 245,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Gujarat state-linked fertilizer and industrial chemicals manufacturer, a joint venture partner in Tunisia's phosphate industry.",
    stats: [ { val: '—', lbl: 'Market Cap' } ],
    shortDesc: "Gujarat State Fertilizers & Chemicals (GSFC) manufactures fertilizers and industrial chemicals, and holds an international joint-venture stake in Tunisian phosphoric acid production alongside Coromandel International.",
    body: [
      "GSFC is a joint venture partner, alongside Coromandel International, in Tunisian Indian Fertilisers (TIFERT), a phosphoric acid plant established with Tunisia's state-owned phosphate companies, illustrating GSFC's international raw-material sourcing strategy for its domestic fertilizer production.",
      "GSFC is listed on the National Stock Exchange. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🌍 + Tunisia JV', '🇮🇳 India', 'NSE: GSFC'],
  },
  {
    id: 'deepak-fertilisers', name: 'Deepak Fertilisers and Petrochemicals Corporation Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 246,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "India's first domestic ammonia producer, now a multi-product fertilizer, chemicals and real estate conglomerate.",
    stats: [ { val: '1979', lbl: 'Founded' }, { val: '4', lbl: 'Manufacturing Sites' } ],
    shortDesc: "Deepak Fertilisers and Petrochemicals Corporation manufactures ammonia, nitric acid and other bulk chemicals alongside bulk fertilizers including nitrophosphate under its Mahadan brand, from facilities across Maharashtra, Andhra Pradesh, Haryana and Gujarat.",
    body: [
      "DFPCL was incorporated on 31 May 1979 by Chimanlal Mehta and was, at the time, the only Indian company producing ammonia domestically. The company has since diversified into industrial chemicals, specialty fertilizers and real estate.",
      "DFPCL is listed on the Bombay and National Stock Exchanges (CIN: L24121MH1979PLC021360). (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🧪 + India\'s First Ammonia Producer', '🇮🇳 India', 'NSE: DEEPAKFERT'],
  },
  {
    id: 'madras-fertilizers', name: 'Madras Fertilizers Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 247,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Chennai-area public sector fertilizer producer, originally a joint venture between the Indian government, Amoco and Iran's national oil company.",
    stats: [ { val: '1966', lbl: 'Incorporated' }, { val: '59.5%', lbl: 'Indian Government Stake' } ],
    shortDesc: "Madras Fertilizers manufactures ammonia, urea and complex fertilizers at Manali, Chennai, as a central public sector undertaking majority owned by the Government of India.",
    body: [
      "Madras Fertilizers was incorporated in December 1966 as a joint venture between the Government of India and American oil company Amoco, with Iran's national oil company later becoming a shareholder through Naftiran Intertrade — a genuinely unusual cross-border ownership history for an Indian fertilizer producer. It was the first fertilizer-sector public sector undertaking to receive ISO 9002 certification.",
      "Madras Fertilizers is listed on the Bombay and National Stock Exchanges, majority owned by the Government of India (59.5%). (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🏛️ + Government/Amoco/Iran JV', '🇮🇳 India', 'NSE: MADRASFERT'],
  },
  {
    id: 'patanjali-foods', name: 'Patanjali Foods Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 248,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Edible oil and FMCG company that survived insolvency in 2017 before being acquired and rebuilt by the Patanjali Ayurved group.",
    stats: [ { val: '1986', lbl: 'Founded (as Ruchi Soya)' }, { val: '2017', lbl: 'Entered Insolvency' }, { val: '2022', lbl: 'Renamed Patanjali Foods' } ],
    shortDesc: "Patanjali Foods, formerly Ruchi Soya Industries, produces edible oils and packaged foods across India, having been rebuilt from a 2017 insolvency into a listed FMCG company under Patanjali Ayurved ownership.",
    body: [
      "Ruchi Soya Industries was founded in 1986 to manufacture soybean edible oil, but entered insolvency proceedings in December 2017 carrying roughly ₹12,000 crore in debt. Patanjali Ayurved acquired the company in December 2019, later transferring its own food business — spanning ghee, honey, spices and more — into the entity, which was renamed Patanjali Foods in June 2022.",
      "Patanjali Foods is listed on the Bombay and National Stock Exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🔄 + Insolvency Turnaround', '🇮🇳 India', 'NSE: PATANJALI'],
  },
  {
    id: 'bombay-burmah', name: 'The Bombay Burmah Trading Corporation Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 249,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "India's oldest publicly traded company, founded in 1863, still operating tea and coffee plantations across South India.",
    stats: [ { val: '1863', lbl: 'Founded' }, { val: '#1', lbl: 'Oldest Listed Indian Company' }, { val: '65.93%', lbl: 'Wadia Group Stake' } ],
    shortDesc: "Bombay Burmah Trading Corporation is a diversified Indian conglomerate with plantation interests in tea and coffee alongside auto-electric components and healthcare, and holds the distinction of being India's oldest publicly traded company.",
    body: [
      "Bombay Burmah Trading Corporation was formed in 1863 by the Wallace Brothers of Scotland, originally to take over the Burmese trading assets of William Wallace. More than 160 years later, it remains listed and operating, now chaired by Nusli Wadia and majority owned by the Wadia Group (65.93%), with its largest tea plantation in South India's Anamallai district.",
      "Bombay Burmah Trading Corporation is listed on the Bombay and National Stock Exchanges (CIN: L99999MH1863PLC000002). (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '☕ + Tea & Coffee Plantations', '🇮🇳 India', 'NSE: BBTC'],
  },
  {
    id: 'triveni-engineering', name: 'Triveni Engineering & Industries Limited', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 250,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Sugar and engineering conglomerate that has changed its name three times since 1932, now running multiple ethanol distilleries.",
    stats: [ { val: '1932', lbl: 'Founded (as Ganga Sugar Corp.)' }, { val: '2000', lbl: 'Renamed Triveni Engineering' } ],
    shortDesc: "Triveni Engineering & Industries produces sugar and ethanol, operating multiple distilleries alongside its engineering and power transmission businesses.",
    body: [
      "The company was founded in 1932 as The Ganga Sugar Corporation Limited, renamed Gangeshwar Limited in 1973, and adopted its current name, Triveni Engineering & Industries Limited, in 2000. It entered the ethanol business in 2007 with its first distillery in Muzaffarpur, expanding capacity with a second distillery in 2019.",
      "Triveni Engineering & Industries is listed on the Bombay and National Stock Exchanges. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '🍬 + Sugar & Ethanol', '🇮🇳 India', 'NSE: TRIVENI'],
  },
  {
    id: 'eid-parry', name: 'E.I.D. - Parry (India) Limited', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 251,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "India's oldest surviving mercantile name, founded in 1788, now a Murugappa Group leader in sugar, ethanol and organic nutraceuticals.",
    stats: [ { val: '1788', lbl: 'Founded' }, { val: '1906', lbl: 'First Indian Fertilizer Maker' }, { val: '6', lbl: 'Sugar Factories' } ],
    shortDesc: "E.I.D. Parry manufactures sugar, ethanol and nutraceutical products including organic spirulina, and holds a significant stake in fertilizer subsidiary Coromandel International, tracing back over 235 years to its founding by Welsh merchant Thomas Parry.",
    body: [
      "E.I.D. Parry, founded in 1788, is the oldest surviving mercantile name in Chennai, and became the first company to manufacture fertilizers in the Indian subcontinent in 1906. The Murugappa Group took ownership in 1981. Today the company operates six sugar factories with 140 MW of cogeneration capacity and five distilleries, alongside a world-leading position in organic spirulina production through its nutraceuticals division.",
      "E.I.D. Parry is listed on the Bombay and National Stock Exchanges. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '🍬 + Nutraceuticals & Sugar', '🇮🇳 India', 'NSE: EIDPARRY'],
  },
  {
    id: 'dalmia-bharat-sugar', name: 'Dalmia Bharat Sugar and Industries Limited', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 252,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Sugar and cogeneration producer of the Dalmia Group, running an 80 KLPD ethanol distillery alongside its milling operations.",
    stats: [ { val: '1960', lbl: 'Dalmia Group Founded' }, { val: '79 MW', lbl: 'Cogeneration Capacity' } ],
    shortDesc: "Dalmia Bharat Sugar and Industries operates as a fully integrated sugar producer with cogeneration power capacity and an ethanol distillery, part of the wider Dalmia Group.",
    body: [
      "Dalmia Bharat Sugar and Industries operates with 79 MW of cogeneration capacity and an 80 KLPD ethanol distillery, part of a Dalmia Group that has grown since 1960 from a single business into a diversified industrial conglomerate.",
      "Dalmia Bharat Sugar and Industries is listed on Indian stock exchanges. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '🍬 + Sugar Cogeneration', '🇮🇳 India', 'Public'],
  },
  {
    id: 'dhampur-bio-organics', name: 'Dhampur Bio Organics Limited', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 253,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Sugar and bio-organics producer generating power from bagasse alongside its ethanol operations.",
    stats: [ { val: '—', lbl: 'Market Cap' } ],
    shortDesc: "Dhampur Bio Organics produces sugar, ethanol and bagasse-based power, part of India's broader sugar-to-bioenergy industry cluster.",
    body: [
      "Dhampur Bio Organics operates within India's sugar and bioenergy sector, converting sugarcane by-products into ethanol and power. Its precise incorporation history could not be independently verified beyond exchange and directory listings.",
      "Dhampur Bio Organics is listed on Indian stock exchanges. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '🍬 + Sugar & Bagasse Power', '🇮🇳 India', 'Public'],
  },
  {
    id: 'shree-renuka-sugars', name: 'Shree Renuka Sugars Limited', sector: 'Bio', cat: 'bio', emoji: '🌱',
    featured: false, rank: 254,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "India's largest sugar refiner and ethanol producer by exports, now owned by Singapore's Wilmar Sugar.",
    stats: [ { val: '20%', lbl: 'of India\'s Sugar Exports' }, { val: '4,000', lbl: 'Tonnes/Day Refining Capacity' }, { val: '1995', lbl: 'Founded' } ],
    shortDesc: "Shree Renuka Sugars manufactures and refines sugar and produces ethyl alcohol and ethanol, operating some of India's largest sugar refineries and accounting for roughly a fifth of the country's sugar exports.",
    body: [
      "Shree Renuka Sugars was incorporated on 25 October 1995 by Narendra and Vidya Murkumbi, growing into India's largest sugar refiner and biggest single exporter, with refining capacity of 4,000 tonnes a day and distillery capacity of up to 930 KLPD across mills in Karnataka, Maharashtra and West Bengal. The company launched its retail Madhur sugar brand in 2007.",
      "Shree Renuka Sugars is listed on the Bombay and National Stock Exchanges, majority owned by Singapore-based Wilmar Sugar Holdings Pte. Ltd. (Figures pending verification.)",
    ],
    tags: ['🌱 Bio', '🍬 + Largest India Sugar Exporter', '🇮🇳 India', 'NSE: RENUKA'],
  },
  {
    id: 'avanti-feeds', name: 'Avanti Feeds Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 255,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "One of India's largest integrated shrimp and fish businesses, run as a joint venture with Thailand's Thai Union Group.",
    stats: [ { val: '1993', lbl: 'Founded' }, { val: '5,000+', lbl: 'Employees' }, { val: '$500M+', lbl: 'Annual Revenue' } ],
    shortDesc: "Avanti Feeds operates hatcheries, shrimp and fish farms, aqua feed production and processing, forming one of India's largest integrated aquaculture businesses through a joint venture with Thailand's Thai Union Group.",
    body: [
      "Avanti Feeds was established in 1993 and has grown into one of India's largest integrated fisheries companies, spanning hatcheries, farms, aqua feed manufacturing and seafood processing, in partnership with Thai Union Group Public Company Limited.",
      "Avanti Feeds is listed on the Bombay and National Stock Exchanges (CIN: L16001AP1993PLC095778). (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🦐 Aquaculture', '🇮🇳 India', 'NSE: AVANTIFEED'],
  },
  {
    id: 'venkys-india', name: "Venky's (India) Limited", sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 256,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Major Indian poultry group spanning breeding, hatcheries, feed and processed chicken, formerly known as Western Hatcheries.",
    stats: [ { val: '1976', lbl: 'Founded (as Western Hatcheries)' }, { val: '2000', lbl: 'Renamed Venky\'s' }, { val: '5,138', lbl: 'Employees (2024)' } ],
    shortDesc: "Venky's (India) operates across poultry breeding, hatcheries, animal feed, specific-pathogen-free eggs, processed chicken and animal health products, part of the wider V H Group founded in 1971.",
    body: [
      "Venky's traces its incorporation to 1976 as Western Hatcheries Limited, adopting its current name in June 2000. The company is part of the V H Group, founded in 1971 by Banda Vasudev Rao, and has since expanded into oilseed processing alongside its core poultry business.",
      "Venky's (India) is listed on the Bombay and National Stock Exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🐔 Poultry', '🇮🇳 India', 'NSE: VENKEYS'],
  },
  {
    id: 'skm-egg-products', name: 'SKM Egg Products Export (India) Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 257,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Egg products exporter processing eggs into powder and liquid form for international food manufacturers.",
    stats: [ { val: '—', lbl: 'Market Cap' } ],
    shortDesc: "SKM Egg Products Export processes shell eggs into powdered and liquid egg products for export, supplying food manufacturers internationally.",
    body: [
      "SKM Egg Products Export operates as a processor and exporter of value-added egg products, part of India's broader poultry and egg-processing export sector. Its precise incorporation history could not be independently verified beyond exchange listings.",
      "SKM Egg Products Export is listed on Indian stock exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🥚 Egg Processing & Export', '🇮🇳 India', 'Public'],
  },
  {
    id: 'goodricke-group', name: 'Goodricke Group Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 258,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Producer of premium Darjeeling teas including the Castleton and Margaret's Hope estates, part of UK-based Camellia Plc.",
    stats: [ { val: '1977', lbl: 'Founded' }, { val: '30', lbl: 'Tea Gardens' }, { val: '27', lbl: 'Tea Factories' } ],
    shortDesc: "Goodricke Group cultivates, processes and sells tea across 30 gardens in Darjeeling, Dooars, Assam and Cachar, owning some of Darjeeling's most renowned estates and brands.",
    body: [
      "Goodricke Group was incorporated in West Bengal in June 1977, and is part of Camellia Plc, a major UK-based private-sector tea producer. Its Darjeeling brands, including Castleton, Margaret's Hope and Thurbo, are among the most recognised names in premium Indian tea, alongside its Khaass and Zabardast black CTC teas.",
      "Goodricke Group is listed on the Bombay Stock Exchange (CIN: L01132WB1977PLC031054). (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🍵 Darjeeling Tea', '🇮🇳 India', 'BSE: 500166'],
  },
  {
    id: 'harrisons-malayalam', name: 'Harrisons Malayalam Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 259,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "Leading South Indian tea and rubber plantation company, part of the RPG Group, producing orthodox and CTC teas from Kerala and Tamil Nadu.",
    stats: [ { val: '2012', lbl: 'Split into Two Entities' } ],
    shortDesc: "Harrisons Malayalam operates tea and rubber plantations across Kerala and Tamil Nadu, producing orthodox and CTC teas under brands including Upasi Tea, Harrison Estate and Odyssey, as part of the RPG Group.",
    body: [
      "Harrisons Malayalam is one of South India's leading tea and rubber producers, part of the RP-Sanjiv Goenka (RPG) Group. The company underwent a corporate split into two separate entities in 2012 as part of a broader restructuring of its plantation and other business interests.",
      "Harrisons Malayalam is listed on Indian stock exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🍵 + Tea & Rubber', '🇮🇳 India', 'Public'],
  },
  {
    id: 'mcleod-russel', name: 'McLeod Russel India Limited', sector: 'Agri', cat: 'agri', emoji: '🌾',
    featured: false, rank: 260,
    stripeGrad: 'linear-gradient(135deg,#1a2d00,#3d6b1a)',
    tagline: "One of India's oldest tea companies, with over 150 years of history and plantations spanning Assam, West Bengal and Vietnam.",
    stats: [ { val: '150+', lbl: 'Years in Operation' }, { val: '70+', lbl: 'Export Countries' } ],
    shortDesc: "McLeod Russel India cultivates and processes tea across extensive plantations in Assam, West Bengal and Vietnam, exporting CTC and orthodox teas to more than 70 countries.",
    body: [
      "McLeod Russel India traces its history back more than 150 years, making it among the oldest tea companies in India. The company has faced financial difficulties in recent years, including selling estate assets — including to competitor Goodricke Group in 2018 — as part of debt restructuring efforts.",
      "McLeod Russel India is listed on Indian stock exchanges. (Figures pending verification.)",
    ],
    tags: ['🌾 Agri', '🍵 + 150-Year Heritage', '🇮🇳 India', 'Public'],
  },

  // ══════════════════════════════════════════════════════════════════════
  // FREE-CHOICE BATCH #4 — three new countries: Ethiopia, Uruguay, Ghana.
  // Legal names and institutional structures verified individually.
  // Ethiopian Electric Power's entry covers the Grand Ethiopian
  // Renaissance Dam, inaugurated September 2025 — genuinely current and
  // notable, but also a real point of regional tension with Egypt and
  // Sudan over downstream Nile water flow, noted factually rather than
  // as an uncontested success story.
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'ethiopian-electric-power', name: 'Ethiopian Electric Power', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 261,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Operator of the Grand Ethiopian Renaissance Dam, Africa's largest hydropower plant, inaugurated in September 2025 after 14 years of construction.",
    stats: [
      { val: '5.15 GW', lbl: 'GERD Installed Capacity' },
      { val: '2025', lbl: 'GERD Inaugurated' },
      { val: '54%→78%', lbl: 'Ethiopia Power Access Target (10-yr)' },
    ],
    shortDesc: "Ethiopian Electric Power is Ethiopia's state-owned electricity generator and transmission operator, having just completed the Grand Ethiopian Renaissance Dam, Africa's largest hydropower project and among the 20 largest in the world.",
    body: [
      "Ethiopian Electric Power, founded in 1956, owns and operates Ethiopia's national high-voltage power grid and nearly all power plants within it. Its flagship project, the Grand Ethiopian Renaissance Dam (GERD) on the Blue Nile, began construction in 2011 and was formally inaugurated in September 2025 — a $4-5 billion undertaking financed overwhelmingly through domestic bond sales and tax revenue rather than foreign investment, a point of considerable national pride. At 5.15 GW, it is Africa's largest hydropower plant.",
      "The dam is also a source of real regional tension: Egypt and Sudan, downstream on the Nile, have raised longstanding concerns about the GERD's impact on their own water supply, and negotiations over its operation have been contentious for over a decade. Ethiopia's government projects the dam could raise national electricity access from 54% to 78% within ten years, while also enabling power exports to neighbouring countries. Ethiopian Electric Power is a wholly state-owned enterprise. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🌍 + Africa\'s Largest Hydro Plant', '🇪🇹 Ethiopia', 'State-Owned'],
  },
  {
    id: 'ute-uruguay', name: 'Administración Nacional de Usinas y Trasmisiones Eléctricas', sector: 'Diversified', cat: 'diversified', emoji: '🌐',
    featured: false, rank: 262,
    stripeGrad: 'linear-gradient(135deg,#0a2e2a,#1a5c54)',
    tagline: "Uruguay's national power monopoly, a foundation of one of the most renewable-heavy electricity grids in the world.",
    stats: [
      { val: '1912', lbl: 'Founded' },
      { val: '100+', lbl: 'Years as State Monopoly' },
      { val: '~98%', lbl: 'Uruguay Renewable Electricity (approx.)' },
    ],
    shortDesc: "UTE (the National Administration of Power Plants and Electrical Transmissions) is Uruguay's state-owned power monopoly, operating thermoelectric, hydropower and wind generation assets that together make Uruguay's grid one of the most renewable-heavy in the world.",
    body: [
      "UTE was established in 1912 by President José Batlle y Ordóñez and formalised as a state monopoly under Law 4273, making it one of the oldest continuously operating national power utilities anywhere. Over more than a century, UTE built out a generation mix spanning hydropower, thermal, and — starting in the 2010s — an unusually rapid buildout of wind capacity that helped push Uruguay's electricity supply to among the highest renewable shares of any country in the world.",
      "UTE's portfolio today spans hydro, wind, biomass, and thermal generation, along with the national transmission and distribution network. UTE is Uruguay's state-owned power monopoly. (Figures pending verification.)",
    ],
    tags: ['🌐 Diversified', '💨 + Rapid Wind Buildout', '🇺🇾 Uruguay', 'State Monopoly'],
  },
  {
    id: 'volta-river-authority', name: 'Volta River Authority', sector: 'Water', cat: 'water', emoji: '💧',
    featured: false, rank: 263,
    stripeGrad: 'linear-gradient(135deg,#0d1f3d,#1a5c80)',
    tagline: "Operator of the Akosombo Dam, whose reservoir, Lake Volta, is the largest artificial lake in the world by surface area.",
    stats: [
      { val: '1,020 MW', lbl: 'Akosombo Installed Capacity' },
      { val: '8,502 km²', lbl: 'Lake Volta Surface Area' },
      { val: '1961', lbl: 'Founded' },
    ],
    shortDesc: "The Volta River Authority is Ghana's main electricity generator, operating the Akosombo and Kpong hydroelectric dams and exporting power to neighbouring Togo, Benin and Burkina Faso.",
    body: [
      "The Volta River Authority was established in April 1961 under Ghana's Volta River Development Act to build and operate the Akosombo Dam, jointly financed by the Ghanaian government, the World Bank, the United States and the United Kingdom. Completed in 1965, the dam created Lake Volta, the largest artificial lake in the world by surface area, displacing an estimated 80,000 people in the process — a real human cost alongside the electrification it enabled.",
      "VRA later added the downstream Kpong hydroelectric plant in 1982, and now supplies power not only within Ghana but to neighbouring Togo, Benin and Burkina Faso, playing a coordinating role in the West Africa Power Pool. The Volta River Authority is a Ghanaian state agency. (Figures pending verification.)",
    ],
    tags: ['💧 Water', '🌍 + Regional Power Exports', '🇬🇭 Ghana', 'State Agency'],
  },
];

/** Get all champions (ordered by rank ascending, featured first). Seeds on first read. */
export async function getChampions() {
  const store = getDataStore();
  try {
    const data = await store.get('content/champions', { type: 'json' });
    if (Array.isArray(data) && data.length) return data;
  } catch {}
  // First-time seeding
  try { await store.setJSON('content/champions', CHAMPION_SEED); } catch {}
  return CHAMPION_SEED;
}

/** Write the champion list back to the store. */
export async function setChampions(champions) {
  const store = getDataStore();
  const cleaned = Array.isArray(champions) ? champions : [];
  await store.setJSON('content/champions', cleaned);
  return cleaned;
}

/** Move one champion to a new position among ranks 2..N (rank 1 is reserved
 *  for the "Champion of the Year" hero slot and is never touched here — use
 *  setChampionOfYear for that). Whoever currently occupies the target rank,
 *  and everyone between the old and new position, shifts by one to make
 *  room; ranks stay contiguous and unique. newRank is clamped into the
 *  valid [2, poolSize+2] range rather than rejected, so a UI typo (e.g. 500)
 *  just lands the champion at the end instead of erroring.
 *  Throws if targetId is the current rank-1 champion. */
export function reorderChampions(list, targetId, newRank) {
  const championOfYear = list.find(c => c.rank === 1);
  let pool = list.filter(c => c.rank !== 1);
  pool.sort((a, b) => (a.rank || 999) - (b.rank || 999));

  const idx = pool.findIndex(c => c.id === targetId);
  if (idx === -1) {
    throw new Error(championOfYear && championOfYear.id === targetId
      ? 'This champion is the current Champion of the Year — use "Set as Champion of the Year" on another champion to replace them first.'
      : 'Champion not found');
  }

  const [target] = pool.splice(idx, 1);
  const minRank = 2;
  const maxRank = pool.length + 2;
  const clamped = Math.max(minRank, Math.min(Math.round(newRank) || minRank, maxRank));
  pool.splice(clamped - 2, 0, target);
  pool.forEach((c, i) => { c.rank = i + 2; });

  return championOfYear ? [championOfYear, ...pool] : pool;
}

/** Promote a champion to rank 1 ("Champion of the Year"). The previous
 *  rank-1 champion (if any) re-enters the ordered pool at rank 2, and
 *  everyone else shifts down by one to stay contiguous. */
export function setChampionOfYear(list, targetId) {
  const target = list.find(c => c.id === targetId);
  if (!target) throw new Error('Champion not found');
  const oldCoY = list.find(c => c.rank === 1);

  let pool = list.filter(c => c.id !== targetId && c.rank !== 1);
  pool.sort((a, b) => (a.rank || 999) - (b.rank || 999));
  if (oldCoY && oldCoY.id !== targetId) pool.unshift(oldCoY);

  pool.forEach((c, i) => { c.rank = i + 2; });
  target.rank = 1;
  return [target, ...pool];
}

/** Mark (or unmark) a champion as the "Focus Champion" for its sector.
 *  Enforces at most one focus champion per category — setting a new one
 *  automatically unsets any other champion in the same `cat`. */
export function setFocusChampion(list, targetId, focus) {
  const target = list.find(c => c.id === targetId);
  if (!target) throw new Error('Champion not found');
  if (focus) {
    list.forEach(c => { if (c.id !== targetId && c.cat === target.cat && c.isFocus) c.isFocus = false; });
    target.isFocus = true;
  } else {
    target.isFocus = false;
  }
  return list;
}

/** Add any champions from the seed defaults that aren't already in the store.
 *  Existing champions are NEVER overwritten — only missing-by-id ones are added.
 *  Returns { added, skipped, total } summary so the admin endpoint can report back. */
export async function mergeChampionDefaults() {
  const current = await getChampions();
  const existingIds = new Set(current.map(c => c.id));
  const toAdd = CHAMPION_SEED.filter(seed => !existingIds.has(seed.id));
  if (!toAdd.length) {
    return { added: 0, skipped: CHAMPION_SEED.length, total: current.length };
  }
  const merged = [...current, ...toAdd];
  await setChampions(merged);
  return { added: toAdd.length, skipped: CHAMPION_SEED.length - toAdd.length, total: merged.length };
}

// ── IMPACT BLOG POSTS ─────────────────────────────────────────────────────────
// Admin-authored blog posts that appear on the Impact page, between the live
// statistics cards and the Energy Transition Progress section. Each post has
// its own URL (e.g. /impact.html?post=slug) so "Read more" can open a full page.

/** Get all impact blog posts, published ones only when publicOnly=true. Sorted newest first. */
export async function getImpactPosts(publicOnly = false) {
  const store = getDataStore();
  try {
    const data = await store.get('content/impact-posts', { type: 'json' });
    let list = Array.isArray(data) ? data : [];
    if (publicOnly) list = list.filter(p => p.published !== false);
    // Featured first, then by pubDate desc
    list.sort((a, b) => {
      const fa = a.featured ? 1 : 0, fb = b.featured ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return new Date(b.pubDate || 0) - new Date(a.pubDate || 0);
    });
    return list;
  } catch {
    return [];
  }
}

/** Look up a single post by its slug. Returns null when not found or unpublished. */
export async function getImpactPostBySlug(slug, includeDrafts = false) {
  const all  = await getImpactPosts(false);
  const post = all.find(p => p.slug === (slug || '').toLowerCase());
  if (!post) return null;
  if (!includeDrafts && post.published === false) return null;
  return post;
}

/** Write the full post list. */
export async function setImpactPosts(posts) {
  const store = getDataStore();
  const cleaned = Array.isArray(posts) ? posts : [];
  await store.setJSON('content/impact-posts', cleaned);
  return cleaned;
}

// ── PRODUCTS (affiliate directory) ────────────────────────────────────────────
// Manually curated affiliate products, grouped by the site's energy categories.
// Stored at content/products. No seed — admin adds items. Each product:
//   {
//     id, slug, name, brand, category, summary,
//     image,            // product image URL
//     priceBand,        // "$" | "$$" | "$$$" — NOT an exact price (prices drift)
//     co2Note,          // optional honest impact note, e.g. "Powers a 2-bed home"
//     affiliateUrl,     // outbound link WITH the tracking param baked in
//     network,          // "Amazon" | "EnergySage" | "ShareASale" | "Direct" | ...
//     ctaLabel,         // button text, e.g. "Shop on Amazon" / "Get free quotes"
//     featured,         // boolean — pin to top of its category
//     published,        // boolean — false = draft, hidden from public page
//     clicks,           // outbound click counter (best-effort)
//     addedAt, updatedAt
//   }
// Affiliate disclosure is rendered on the public page, not stored per-item.

/** Get all products. publicOnly=true returns only published items. Sorted
 *  featured-first then newest. */
export async function getProducts(publicOnly = false) {
  const store = getDataStore();
  try {
    const data = await store.get('content/products', { type: 'json' });
    let list = Array.isArray(data) ? data : [];
    if (publicOnly) list = list.filter(p => p.published !== false);
    list.sort((a, b) => {
      const fa = a.featured ? 1 : 0, fb = b.featured ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return new Date(b.addedAt || 0) - new Date(a.addedAt || 0);
    });
    return list;
  } catch {
    return [];
  }
}

/** Write the full product list back to the store. */
export async function setProducts(products) {
  const store = getDataStore();
  const cleaned = Array.isArray(products) ? products : [];
  await store.setJSON('content/products', cleaned);
  return cleaned;
}

/** Increment the outbound-click counter for a product. Best-effort — a failed
 *  read or write is swallowed so a tracking hiccup never blocks the redirect. */
export async function incrementProductClick(productId) {
  const store = getDataStore();
  try {
    const data = await store.get('content/products', { type: 'json' });
    const list = Array.isArray(data) ? data : [];
    const idx  = list.findIndex(p => p.id === productId);
    if (idx === -1) return false;
    list[idx].clicks = (list[idx].clicks || 0) + 1;
    await store.setJSON('content/products', list);
    return true;
  } catch {
    return false;
  }
}

// ── JOBS ──────────────────────────────────────────────────────────────────────
// Curated job listings, stored under content/jobs. Mirrors the products model:
// featured-first + newest sort, draft support via `published`, and an outbound
// click counter. Additionally, jobs auto-hide once expired — this is a READ-TIME
// filter (no cron): an expired job stops appearing to the public but stays in
// the blob so it can be reposted from the admin.

/** Read the job list. When publicOnly, hides drafts AND expired listings. */
export async function getJobs(publicOnly = false) {
  const store = getDataStore();
  try {
    const data = await store.get('content/jobs', { type: 'json' });
    let list = Array.isArray(data) ? data : [];
    if (publicOnly) {
      const now = Date.now();
      list = list.filter(j =>
        j.published !== false &&
        (!j.expiresAt || new Date(j.expiresAt).getTime() > now)
      );
    }
    list.sort((a, b) => {
      const fa = a.featured ? 1 : 0, fb = b.featured ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return new Date(b.postedAt || 0) - new Date(a.postedAt || 0);
    });
    return list;
  } catch {
    return [];
  }
}

/** Write the full job list back to the store. */
export async function setJobs(jobs) {
  const store = getDataStore();
  const cleaned = Array.isArray(jobs) ? jobs : [];
  await store.setJSON('content/jobs', cleaned);
  return cleaned;
}

/** Increment the apply-click counter for a job. Best-effort — a failed read or
 *  write is swallowed so a tracking hiccup never blocks the redirect. */
export async function incrementJobClick(jobId) {
  const store = getDataStore();
  try {
    const data = await store.get('content/jobs', { type: 'json' });
    const list = Array.isArray(data) ? data : [];
    const idx  = list.findIndex(j => j.id === jobId);
    if (idx === -1) return false;
    list[idx].clicks = (list[idx].clicks || 0) + 1;
    await store.setJSON('content/jobs', list);
    return true;
  } catch {
    return false;
  }
}

// ── USERS & SESSIONS (Google OAuth) ───────────────────────────────────────────
// Users are stored under users/<userId>; sessions under sessions/<sessionToken>.
// The userId is derived from the Google "sub" claim (a stable per-account ID).

import { createHash, randomBytes } from 'crypto';

/** Stable user ID derived from a Google sub claim. */
export function userIdFromGoogleSub(sub) {
  return 'g_' + createHash('sha256').update('google:' + sub).digest('hex').slice(0, 24);
}

export async function getUser(userId) {
  if (!userId) return null;
  const store = getDataStore();
  try {
    return await store.get('users/' + userId, { type: 'json' }) || null;
  } catch {
    return null;
  }
}

export async function upsertUser(user) {
  if (!user || !user.id) throw new Error('user.id required');
  const store = getDataStore();
  const now = new Date().toISOString();
  const existing = await getUser(user.id);
  const merged = {
    ...existing,
    ...user,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await store.setJSON('users/' + user.id, merged);
  return merged;
}

/** Generate a fresh session token (256 bits of entropy). */
export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

/** Sessions live in their own Blobs store with a 30-day expiry. */
export async function createSession(userId) {
  const store = getDataStore();
  const token = newSessionToken();
  const session = {
    token,
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
  await store.setJSON('sessions/' + token, session);
  return session;
}

export async function getSession(token) {
  if (!token) return null;
  const store = getDataStore();
  try {
    const s = await store.get('sessions/' + token, { type: 'json' });
    if (!s) return null;
    if (new Date(s.expiresAt) < new Date()) {
      // Expired — clean it up
      try { await store.delete('sessions/' + token); } catch {}
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export async function deleteSession(token) {
  if (!token) return;
  const store = getDataStore();
  try { await store.delete('sessions/' + token); } catch {}
}

// ── USER STATS (server-side read + liked tracking) ────────────────────────────
// Per-user blob storing arrays of unique article IDs for the Profile-page counters.
// Each list is capped to keep blobs small — we only ever need the count + recent IDs
// for dedup, not unbounded history.
const STATS_LIST_CAP = 5000;

/** Read raw stats blob for a user. Returns { read:[], liked:[], updatedAt:'' }. */
export async function getUserStats(userId) {
  if (!userId) return { read: [], liked: [], updatedAt: '' };
  const store = getDataStore();
  try {
    const data = await store.get('userstats/' + userId, { type: 'json' });
    return {
      read:      Array.isArray(data?.read)  ? data.read  : [],
      liked:     Array.isArray(data?.liked) ? data.liked : [],
      updatedAt: data?.updatedAt || '',
    };
  } catch {
    return { read: [], liked: [], updatedAt: '' };
  }
}

/** Write stats blob (overwrite). Caller is responsible for dedup + cap. */
export async function setUserStats(userId, stats) {
  if (!userId) throw new Error('userId required');
  const store = getDataStore();
  const cleaned = {
    read:      Array.from(new Set(stats?.read  || [])).slice(0, STATS_LIST_CAP),
    liked:     Array.from(new Set(stats?.liked || [])).slice(0, STATS_LIST_CAP),
    updatedAt: new Date().toISOString(),
  };
  await store.setJSON('userstats/' + userId, cleaned);
  return cleaned;
}

/** Add a single ID to one of the user's stat lists. Idempotent. */
export async function trackUserStat(userId, action, id) {
  if (!userId || !id) return null;
  if (action !== 'read' && action !== 'liked') {
    throw new Error('action must be "read" or "liked"');
  }
  const current = await getUserStats(userId);
  if (current[action].includes(id)) {
    // Already tracked — no-op (still return current state for the client)
    return current;
  }
  // Prepend new ID and cap (keeps the most recent activity if cap is ever hit)
  current[action] = [id, ...current[action]].slice(0, STATS_LIST_CAP);
  return await setUserStats(userId, current);
}

/** Bulk-merge a batch of IDs (used for one-time localStorage → server migration). */
export async function syncUserStats(userId, payload) {
  if (!userId) throw new Error('userId required');
  const current = await getUserStats(userId);
  const mergedRead  = Array.from(new Set([...(payload?.read  || []), ...current.read]));
  const mergedLiked = Array.from(new Set([...(payload?.liked || []), ...current.liked]));
  return await setUserStats(userId, { read: mergedRead, liked: mergedLiked });
}

// ── MARKET WAITLIST ───────────────────────────────────────────────────────────
// Email signups for the upcoming Market launch. Stored as one blob per email
// (keyed by SHA-256 hash of the lowercased email so listing is fast and
// emails are slightly obfuscated at rest).

import { createHash as _waitlistHash } from 'crypto';

function _waitlistKey(email) {
  const norm = (email || '').toLowerCase().trim();
  return 'waitlist/' + _waitlistHash('sha256').update(norm).digest('hex').slice(0, 32);
}

/** Add an email to the waitlist. Returns { added: true } if new,
 *  { added: false } if already on the list. */
export async function addToWaitlist(email, meta = {}) {
  const norm = (email || '').toLowerCase().trim();
  if (!norm) throw new Error('email is required');
  const store = getDataStore();
  const key   = _waitlistKey(norm);
  // Check if already exists
  try {
    const existing = await store.get(key, { type: 'json' });
    if (existing) return { added: false, entry: existing };
  } catch {}
  const entry = {
    email:     norm,
    signedUpAt: new Date().toISOString(),
    source:    meta.source    || 'market',
    userAgent: meta.userAgent || '',
    referrer:  meta.referrer  || '',
  };
  await store.setJSON(key, entry);
  return { added: true, entry };
}

/** Remove an email from the waitlist (e.g. for unsubscribe). */
export async function removeFromWaitlist(email) {
  const norm = (email || '').toLowerCase().trim();
  if (!norm) throw new Error('email is required');
  const store = getDataStore();
  try { await store.delete(_waitlistKey(norm)); } catch {}
  return { removed: true };
}

/** List all waitlist entries, newest first. Used by admin panel. */
export async function listWaitlist() {
  const store = getDataStore();
  try {
    const list  = await store.list({ prefix: 'waitlist/' });
    const blobs = list?.blobs || [];
    const records = await Promise.all(blobs.map(async meta => {
      try { return await store.get(meta.key, { type: 'json' }); }
      catch { return null; }
    }));
    return records
      .filter(Boolean)
      .sort((a, b) => new Date(b.signedUpAt || 0) - new Date(a.signedUpAt || 0));
  } catch {
    return [];
  }
}

/** Quick check: is this email on the waitlist? */
export async function isOnWaitlist(email) {
  const norm = (email || '').toLowerCase().trim();
  if (!norm) return false;
  const store = getDataStore();
  try {
    const e = await store.get(_waitlistKey(norm), { type: 'json' });
    return !!e;
  } catch {
    return false;
  }
}

// ── NEWSLETTER ───────────────────────────────────────────────────────────────
// Distinct from the Market waitlist — newsletter subscribers have explicitly
// opted in to receive a weekly digest. They confirm via a one-time link sent
// after signup (double opt-in) so the list stays clean and we don't get
// flagged by spam filters. Each subscriber record has:
//   { email, status: 'pending'|'confirmed'|'unsubscribed', confirmToken,
//     unsubToken, source, signedUpAt, confirmedAt?, unsubscribedAt? }
// Stored at newsletter/<sha256(email).slice(0,32)>.

function _newsletterKey(email) {
  const norm = (email || '').toLowerCase().trim();
  return 'newsletter/' + _waitlistHash('sha256').update(norm).digest('hex').slice(0, 32);
}

function _randomToken() {
  // 16 random bytes hex → 32 char token. Used for confirm + unsub links so
  // they can't be guessed by scrapers iterating addresses.
  const bytes = new Uint8Array(16);
  // Node 18+ has globalThis.crypto; fall back to require if needed
  (globalThis.crypto || _waitlistHash).getRandomValues
    ? globalThis.crypto.getRandomValues(bytes)
    : bytes.set(Buffer.from(_waitlistHash('sha256').update(String(Date.now() + Math.random())).digest()).slice(0, 16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Add a subscriber as 'pending' (awaiting double opt-in confirmation).
 *  Returns the entry including the confirm token so the caller can send the
 *  confirmation email. If the email is already 'confirmed', no-ops. If it's
 *  'pending' or 'unsubscribed', regenerates a fresh confirm token. */
export async function addNewsletterSubscriber(email, meta = {}) {
  const norm = (email || '').toLowerCase().trim();
  if (!norm || !/.+@.+\..+/.test(norm)) throw new Error('valid email required');
  const store = getDataStore();
  const key   = _newsletterKey(norm);

  let existing = null;
  try { existing = await store.get(key, { type: 'json' }); } catch {}
  if (existing && existing.status === 'confirmed') {
    return { status: 'already-confirmed', entry: existing };
  }

  const confirmToken = _randomToken();
  const unsubToken   = existing?.unsubToken || _randomToken();
  const entry = {
    email:        norm,
    status:       'pending',
    confirmToken,
    unsubToken,
    source:       meta.source     || 'website',
    userAgent:    meta.userAgent  || '',
    referrer:     meta.referrer   || '',
    signedUpAt:   existing?.signedUpAt || new Date().toISOString(),
    pendingSince: new Date().toISOString(),
  };
  await store.setJSON(key, entry);
  return { status: existing ? 'reconfirm-needed' : 'pending', entry };
}

/** Confirm a subscription via the token from the email link. */
export async function confirmNewsletterSubscriber(email, token) {
  const norm = (email || '').toLowerCase().trim();
  if (!norm || !token) return { ok: false, reason: 'missing-params' };
  const store = getDataStore();
  const key   = _newsletterKey(norm);
  let existing = null;
  try { existing = await store.get(key, { type: 'json' }); } catch {}
  if (!existing) return { ok: false, reason: 'not-found' };
  if (existing.status === 'confirmed') return { ok: true, alreadyConfirmed: true };
  if (existing.confirmToken !== token) return { ok: false, reason: 'bad-token' };
  const updated = {
    ...existing,
    status: 'confirmed',
    confirmedAt: new Date().toISOString(),
    confirmToken: null,  // single-use
  };
  await store.setJSON(key, updated);
  return { ok: true, entry: updated };
}

/** Unsubscribe via the unsub token in every email's footer. */
export async function unsubscribeNewsletter(email, token) {
  const norm = (email || '').toLowerCase().trim();
  if (!norm) return { ok: false, reason: 'missing-email' };
  const store = getDataStore();
  const key   = _newsletterKey(norm);
  let existing = null;
  try { existing = await store.get(key, { type: 'json' }); } catch {}
  if (!existing) return { ok: false, reason: 'not-found' };
  // If a token was provided, it must match. Admin-side unsubs may pass no token.
  if (token && existing.unsubToken !== token) return { ok: false, reason: 'bad-token' };
  const updated = {
    ...existing,
    status: 'unsubscribed',
    unsubscribedAt: new Date().toISOString(),
  };
  await store.setJSON(key, updated);
  return { ok: true };
}

/** List all newsletter subscribers, newest first. Optionally filter by status. */
export async function listNewsletterSubscribers(statusFilter = null) {
  const store = getDataStore();
  try {
    const list  = await store.list({ prefix: 'newsletter/' });
    const blobs = list?.blobs || [];
    const records = await Promise.all(blobs.map(async meta => {
      try { return await store.get(meta.key, { type: 'json' }); }
      catch { return null; }
    }));
    return records
      .filter(Boolean)
      .filter(r => !statusFilter || r.status === statusFilter)
      .sort((a, b) => new Date(b.signedUpAt || 0) - new Date(a.signedUpAt || 0));
  } catch {
    return [];
  }
}

/** Get all confirmed subscribers — used by the broadcast send. */
export async function listConfirmedSubscribers() {
  return listNewsletterSubscribers('confirmed');
}

/** Look up a single subscriber by email, returning null if not found.
 *  Used by the profile page to render the right newsletter widget state
 *  (subscribed / pending / unsubscribed / not signed up). */
export async function getNewsletterSubscriber(email) {
  const norm = (email || '').toLowerCase().trim();
  if (!norm) return null;
  const store = getDataStore();
  try {
    return await store.get(_newsletterKey(norm), { type: 'json' });
  } catch {
    return null;
  }
}

// ── NEWSLETTER ISSUES ────────────────────────────────────────────────────────
// Each sent issue is recorded so admin can see history and re-send-protection
// is possible. Stored at newsletterissues/<id>.

export async function recordNewsletterIssue(issue) {
  const store = getDataStore();
  const id = issue.id || ('iss_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  const record = {
    id,
    subject:       issue.subject || '',
    sentAt:        new Date().toISOString(),
    sentBy:        issue.sentBy || 'admin',
    recipientCount: issue.recipientCount || 0,
    successCount:  issue.successCount || 0,
    failureCount:  issue.failureCount || 0,
    htmlPreview:   (issue.html || '').slice(0, 2000),  // truncated preview
    notes:         issue.notes || '',
  };
  await store.setJSON('newsletterissues/' + id, record);
  return record;
}

export async function listNewsletterIssues(limit = 50) {
  const store = getDataStore();
  try {
    const list  = await store.list({ prefix: 'newsletterissues/' });
    const blobs = list?.blobs || [];
    const records = await Promise.all(blobs.map(async meta => {
      try { return await store.get(meta.key, { type: 'json' }); }
      catch { return null; }
    }));
    return records
      .filter(Boolean)
      .sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
      .slice(0, limit);
  } catch {
    return [];
  }
}

// ── USER LISTING (admin) ─────────────────────────────────────────────────────
// For the admin User Management page. Lists are bounded — Netlify Blobs `list()`
// returns up to 1000 keys per call which is more than enough for our scale.
// If usage ever exceeds this, we'll add pagination via the cursor token.

/** List all registered users with their stat counts.
 *  Returns array of { id, email, name, picture, role, createdAt, updatedAt,
 *  welcomeSentAt, readCount, likedCount }. */
export async function listAllUsers() {
  const store = getDataStore();
  let users = [];
  try {
    const list = await store.list({ prefix: 'users/' });
    const blobs = list?.blobs || [];
    users = await Promise.all(blobs.map(async meta => {
      try { return await store.get(meta.key, { type: 'json' }); }
      catch { return null; }
    }));
    users = users.filter(Boolean);
  } catch {
    return [];
  }
  // Decorate with stats — one extra blob fetch per user.
  // For now this is fine (admin section, low traffic). If user count ever
  // exceeds ~500 this should get a separate paginated stats endpoint.
  const withStats = await Promise.all(users.map(async u => {
    let readCount = 0, likedCount = 0;
    try {
      const stats = await store.get('userstats/' + u.id, { type: 'json' });
      readCount  = Array.isArray(stats?.read)  ? stats.read.length  : 0;
      likedCount = Array.isArray(stats?.liked) ? stats.liked.length : 0;
    } catch {}
    return { ...u, readCount, likedCount };
  }));
  // Newest signups first by default
  return withStats.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

/** Update only the role on a user record. Used by admin role-management UI. */
export async function setUserRole(userId, role) {
  if (!userId) throw new Error('userId required');
  if (role !== 'admin' && role !== 'user') throw new Error('role must be "admin" or "user"');
  const existing = await getUser(userId);
  if (!existing) throw new Error('user not found');
  return await upsertUser({ id: userId, role });
}

/** Delete a user record (and their stats). Sessions for this user become
 *  orphaned but expire naturally. Note: this doesn't remove their footprint
 *  from comment fields, etc. — only the auth record + stats. */
export async function deleteUser(userId) {
  if (!userId) throw new Error('userId required');
  const store = getDataStore();
  try { await store.delete('users/' + userId); } catch {}
  try { await store.delete('userstats/' + userId); } catch {}
  return { deleted: userId };
}

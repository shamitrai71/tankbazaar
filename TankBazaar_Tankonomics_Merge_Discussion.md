# TankBazaar, TWI & Tankonomics — Architecture, Merge Implications, and Launch Strategy

*Internal working document — captures the discussion following TWI reaching ~5,000 companies and the SAMREF AML data-quality pass.*

---

## 1. The Three Apps, As They Stand Today

| App | Role | Status | Domain |
|---|---|---|---|
| **Tankonomics** | The "mothership" — described as global, more like a **LinkedIn for a niche industry** than a directory | Live Firestore app, in active development | Internal only, but has a registered domain |
| **TWI (TankWorldIndia)** | Feeder project — supplier/equipment/service company research | Static HTML file, ~5,000 companies, actively growing | Internal only, registered domain |
| **TankBazaar** | Feeder project — industrial *asset* research (facilities, not suppliers) | In active data-field build-out, scope currently expanding | Internal only, registered domain |

All three currently exist only internally, but each has a proper registered domain — worth treating as a real (if soft) form of external commitment even pre-launch, not a purely internal codename.

---

## 2. Firestore Scale — What Was Actually Checked, Not Assumed

Before any merge conversation, the underlying infrastructure question was checked directly against Tankonomics' real code (not assumed from general Firestore knowledge).

**Confirmed Firestore limits (current, verified):**
- Max document size: 1 MiB
- Free tier: 1 GiB storage, 50,000 reads/day, 20,000 writes/day, 20,000 deletes/day
- Collection size: effectively unlimited (Firestore scales to millions of documents per collection with no practical ceiling)

**Against the actual dataset** (today's ~5,000 TWI companies, a further ~5,000 anticipated from TankBazaar): document count, document size, and total storage are all trivial — none of these are real constraints.

**The real finding — the Companies.tsx fetch pattern:**

Tankonomics' company directory page currently loads via:
```js
const { data: companies } = useCollection<any>("companies", [orderBy("createdAt", "desc")]);
```
`useCollection` implements this as an `onSnapshot` **live listener** with **no `limit()`, no pagination** — every visit to the Companies page reads the *entire* collection. Category/search filtering happens client-side, after the full fetch, not as query constraints.

**The consequence at scale:** once ~10,000 companies are in that collection (5,000 TWI + 5,000 TankBazaar), a single page view = ~10,000 reads. At the 50,000/day free quota, that's roughly **5 page views total, across all users, before the free tier is exhausted** — on day one of real traffic, not eventually.

**What would need to change** (not yet built, flagged for planning):
- Cursor-based pagination (`limit()` + `startAfter()`) instead of loading the full collection
- Server-side `where()` filtering by category/sector instead of client-side post-filtering (requires composite indexes)
- Reconsider whether the directory page needs a live `onSnapshot` listener at all, versus a one-time `getDocs` fetch
- Full-text search is a separate, currently-unaddressed problem — Firestore has no native search; a "load everything into memory and filter" pattern silently provided this today, and pagination removes that side-effect. A dedicated search layer (Algolia, Typesense, or similar) will likely be needed once pagination is in place.

**Recommendation discussed:** this fix is worth treating as independent of merge timing — cheaper to build correctly before 10,000+ documents are flowing through it than to retrofit after.

---

## 3. Decision: Hold on Merging TWI and TankBazaar Into Tankonomics

**No company data from TWI or TankBazaar moves into Tankonomics yet.** This was an explicit, deliberate hold, for two independent reasons:

1. **Data needs revalidation first** — both feeder projects' data quality needs to meet Tankonomics' bar before seeding (see Section 6).
2. **Compatibility hasn't been checked yet** — particularly category-taxonomy compatibility, which needs the same rigorous, slug-by-slug verification already applied between TWI and Tankonomics this session (not just eyeballing similar-looking names).

**Access note:** full TankBazaar access (repo, data export, or direct database access — form not yet decided) will be required before real compatibility work can begin. This is a known prerequisite, not yet actioned.

---

## 4. TWI vs. TankBazaar — Why They Need to Be Treated Differently

This distinction became the central architectural finding of the discussion.

### TWI: one relatively uniform schema
TWI's companies — valve manufacturers, drilling contractors, EPC contractors, cable manufacturers — all share a fundamentally similar shape: a **supplier or service provider**, describable by categories, products, certifications, and capacity. One schema extension can serve this whole population reasonably well.

### TankBazaar: several genuinely different schemas wearing one label
TankBazaar's scope — Refineries, Terminals, Petrochemical, Fertilizer, Floating Structures, Gas Processing, and now expanding into **Oil Rigs and Pipelines** — is not one data shape with a few extra optional fields. Each is meaningfully different:

- **Refineries**: throughput/capacity, Nelson complexity, crude slate, ownership structure
- **Floating Structures**: vessel specs, mooring type, storage capacity, water depth rating
- **Fertilizer plants**: feedstock, ammonia/urea capacity, offtake agreements
- **Oil Rigs**: upstream extraction infrastructure — a different category of asset entirely from storage
- **Pipelines**: midstream transport infrastructure — again, a different category

TankBazaar's field-definition, data-population, and verification work is therefore **parallel work roughly the size of what TWI already required, multiplied across each asset category**, with far less shared structure between them than TWI's internal consistency provides.

### The operator vs. supplier boundary still holds across both
This is the same discipline already established and repeatedly applied to TWI all session: **TankBazaar owns the asset; TWI supplies the equipment/service to it.** An Oil Rig is a TankBazaar asset. A drilling contractor that operates rigs for someone else, or a company supplying equipment to rigs, is a TWI supplier (already covered — `drilling-contractors`, the `UP` section, the `OS` section). This boundary is what already correctly routed FPSO/LNG terminal *ownership* to TankBazaar while keeping FPSO *service providers* (SBM Offshore, Saipem, McDermott) in TWI. It continues to hold cleanly even as TankBazaar's asset-type scope grows — the two projects describe different sides of the same industry, not competing claims on the same companies.

---

## 5. Decision: Decouple the Sync Tracks

**Only TWI ↔ Tankonomics sync work proceeds for now.** TankBazaar's sync readiness is fully decoupled from TWI's — TankBazaar continues its own field-definition and enrichment work on its own timeline, entirely independent of when or how TWI eventually merges in.

This was a direct response to TankBazaar's scope now including Oil Rigs and Pipelines — a moving target that made simultaneous alignment work premature.

---

## 6. Tankonomics' Actual Data Model — Evidence-Based, Not Assumed

Pulled directly from the live Tankonomics codebase rather than inferred.

### Company schema (from Admin.tsx's `newCompany` state)
```
name, description, aboutUs, address, logo, heroImage, website,
socialLinks (linkedin/twitter/facebook/instagram),
categoryIds (multi-tier, up to 3 levels), isFeatured,
products: [{ name, description, image }],
locations: [...]
```
Plus, from earlier access-gate work: `ownerUid`, `plan`, `status`.

### Person ("Blueprint") schema
```
displayName, photoURL, bio, industrySegment, company, companyId, jobTitle,
skills, profileLabels, socialLinks, savedJobs, badges,
isVerifiedByCompany, verifiedByCompanyId, verifiedByCompanyName, verifiedAt
```

### Assessment
- **Person side is already genuinely LinkedIn-shaped.** The `isVerifiedByCompany` chain — an employee-claims-employer-confirms verification loop — is a real, non-trivial feature that already exists. This is not the gap.
- **Company side has a reasonable foundation** (products, locations, socials, hero image) **but is missing the industry-specific trust signals that matter most for this vertical**, and matter more given active competition in the space:
  - **Certifications** (API, ISO, ASME, PED) — arguably the single biggest trust signal in industrial procurement; no field exists for this today.
  - **Manufacturing/service capacity** — no structured field.
  - **Structured project references / case studies** — only free-text `aboutUs` exists.
  - **Company size / founded year** — absent.
  - **RFQ or lead-capture flow** — no evidence found in the codebase. Without this, a company profile functions as a brochure rather than a transaction surface, which is the actual differentiator against pure-directory competitors (IndiaMART, GlobalSpec, etc.).
  - **Review/rating system** — no evidence found.
  - The `products` array is a good foundation but thin — no structured spec fields, no per-product certification tags.

---

## 7. Proposed Schema Shape: Common Core + Type-Specific Extensions

Discussed as the structural answer to Section 4's finding — not yet decided on implementation details, but the direction that emerged from the conversation:

- **Common core** (every entity gets this, regardless of source — TWI or any TankBazaar sub-type): name, category/classification, location, logo, description, website, socialLinks. This is what makes any profile page renderable and searchable.
- **Type-specific extensions**, populated only when relevant:
  - A **Supplier Profile** block (certifications, products, capacity, RFQ) — populated for TWI-sourced entities.
  - An **Asset Profile** block per TankBazaar sub-type (Refinery fields, Floating Structure fields, Oil Rig fields, Pipeline fields, etc.) — populated only for the relevant asset type.

**Why this matters:** forcing every entity into one flat shape either bloats every profile with irrelevant empty fields (a refinery record carrying an empty `products` array, a valve manufacturer record carrying empty Nelson-complexity fields) or quietly discards the type-specific richness that's the actual point of distinguishing six-plus asset categories in the first place.

**Open question, not yet resolved:** whether TankBazaar's asset categories should ultimately be modeled as fully separate Firestore collections, or as one collection with a `type`/`facility_type` discriminator field. Leans toward the latter for query flexibility, but this hasn't been decided.

---

## 8. The Naming Question, and Its Resolution

**The concern raised:** "TankBazaar" encodes a storage/bulk-liquid identity. Oil Rigs (upstream extraction) and Pipelines (midstream transport) are not storage assets — a genuine scope mismatch with the name, not a stretch of it. Because all three apps have registered domains (a soft external commitment even while unlaunched), this wasn't dismissed as purely cosmetic.

**The resolution reached:** much later, restructure into three named modules within a single app — **"TankBazaar" + "Other Facilities" + "Pipeline Tracker"** — rather than either renaming TankBazaar to something broader, or stretching the existing name to awkwardly cover assets it was never meant to describe. This preserves TankBazaar's identity scoped to what it was actually named for, while giving new asset categories their own clearly-named homes under the same umbrella.

**Forward-looking recommendation arising from this** (not yet built, but cheap to do now and expensive to retrofit later): give every TankBazaar entity a **type discriminator field** from day one during current data-building work (e.g., `facility_type: "storage_tank_terminal" | "oil_rig" | "pipeline" | ...`). If Oil Rig and Pipeline data goes in today without this, splitting it into a future "Pipeline Tracker" module means retroactively classifying everything already there — the same category of cleanup the SAMREF batch required at the data-quality level, but this time at the schema level. Tagging correctly from day one turns the eventual module split into a filter query instead of a migration project.

---

## 9. Launch Strategy Context

### Target: India Energy Week 2027
- **Dates confirmed via direct search:** January 27–30, 2027, Goa (ONGC Advanced Training Institute)
- Organized under the Ministry of Petroleum & Natural Gas / FIPI framework
- As of this discussion (September 2026), this gives roughly **4.5 months of runway** to get the revalidation, sync, and data-quality work into shape

### Existing asset: a pre-built list of 500 members
A concrete, de-risking asset for launch — removes the "will anyone show up" uncertainty that a cold launch would carry. **Open question, not yet answered:** the composition of this list — upstream vs. downstream, supplier-side vs. buyer-side, India-only vs. global — which would sharpen exactly who the next wave of targeted outreach should focus on.

### Samudra Manthan — verified, and genuinely relevant, not just a tailwind
Checked directly rather than assumed, since this postdates general familiarity with the space:

- **What it is:** India's National Offshore Exploration Scheme, approved by the Union Cabinet on **July 31, 2026**, with an outlay of **₹84,084 crore (~$10 billion)**, under the Ministry of Petroleum & Natural Gas.
- **Stated components:** large-scale seismic data acquisition/processing/interpretation; accelerated deepwater and ultra-deepwater exploratory drilling; scientific drilling in frontier basins; development of common offshore production and evacuation infrastructure; establishment of an **integrated Oil & Gas Manufacturing and Services Zone**; opening nearly all Indian offshore acreage to exploration; targeting increased domestic output by FY2030-31.
- **Why it matters concretely, not just directionally:** this maps almost line-for-line onto taxonomy work already built this session —
  - Seismic/drilling components → the `UP` section (Drilling Contractors, Seismic & Geophysical Services) — where Arabian Drilling, ARO Drilling, TAQA already sit
  - Offshore production/evacuation infrastructure → the `OS` section — Floating Production Systems, FPSO Lifecycle Management, Offshore Installation & EPCIC, Offshore Support Vessels
  - The "integrated Oil & Gas Manufacturing and Services Zone" language reads as a deliberate policy push to draw exactly the kind of company TWI catalogs (fabricators, EPC contractors, equipment manufacturers) into setting up in India — a potential **sourcing opportunity** (new companies to research and add), not just a demand-side signal for who might use the platform.
- **Timing:** approved roughly six months before the IEW 2027 launch window — a real, not coincidental, strategic alignment worth building the pre-launch push around.

### Tankonomics' positioning: global, two-sided
Restated explicitly in this discussion: Tankonomics is **global**, not India-first — "more like a LinkedIn for a niche industry." This implies a two-sided model already partially reflected in the existing schema:
- **Supply side** (companies): monetization via the existing claim/plan mechanism — free listing for visibility, paid/verified claim for enhanced profile, analytics, and priority placement.
- **Demand side** (individual professionals): should stay free or low-cost — their value isn't direct subscription revenue, it's the traffic, engagement, and credibility that makes the supply side worth paying for.

TWI and TankBazaar's global data (SAMREF's Saudi-approved vendors, WPC's Chinese/Saudi/international exhibitors, HVDC cable manufacturers worldwide, etc.) is explicitly *not* being treated as India-only inventory — it's global depth feeding a global platform, with India (via IEW 2027) as the launch beachhead rather than the platform's ultimate scope.

---

## 10. Open Questions Carried Forward

1. **TankBazaar access** — form not yet decided (GitHub repo, Firestore export, direct DB access). Required before real category-compatibility checking can start.
2. **TankBazaar's internal structure** — fully separate collections per asset type, or one collection with a type discriminator field? Leaned toward the latter in discussion, not decided. **Now a hard blocker for Section 11's search-engine schema design too — see below.**
3. **500-member list composition** — upstream/downstream split, supplier/buyer-side split, India-only vs. global — needed to sharpen near-term subscriber targeting.
4. ~~**Companies.tsx pagination fix sequencing**~~ — **Resolved, see Section 11.** Built independently of merge timing, as recommended. Confirmed live in the codebase.
5. **TWI-side "Supplier Profile" extension** — the common-core-plus-extension shape was proposed directionally; the actual field list for the Supplier Profile block, and a full category-compatibility validation pass between TWI and Tankonomics' existing `categoryIds` structure, have not yet been done in detail.
6. **Search engine architecture** — see Section 11. Tankonomics and TankBazaar both lean toward a hosted search engine (Typesense discussed); TWI toward client-side. One shared Typesense instance across apps, or separate ones per app? Not decided — Tankonomics and TankBazaar aren't currently syncing into each other, which argues for separate instances today, but a future TWI→Tankonomics merge (and possibly TankBazaar) could make a shared instance the better long-term call.

---

## 11. Search Architecture — Confirmed the Pagination Fix Landed, Found What It Broke

*Follow-up discussion, dated after Section 2's original finding. Checked directly against the current codebase rather than assumed the doc's earlier description still held.*

### The pagination fix: built, and built well
Confirmed directly in `Companies.tsx`: the old unlimited `useCollection("companies", ...)` call (Section 2's finding) has been replaced with cursor-based pagination — `getDocs` with `limit(48)` and `startAfter(cursor)`, a one-time fetch rather than a live `onSnapshot` listener. This resolves the quota-exhaustion risk Section 2 flagged.

It goes a step further than pagination alone: server-side category narrowing is also implemented, via `where("allCategoryIds", "array-contains-any", categoryFilter)`, bounding *which* page of documents gets read rather than fetching broadly and filtering client-side. The code correctly documents and handles Firestore's real 10-value cap on `array-contains-any`, falling back to client-side-only filtering for the rare case of more than 10 categories selected. This was Section 2's second flagged gap ("server-side `where()` filtering... instead of client-side post-filtering"), and it's handled too.

### What the fix quietly broke: free-text search
Section 2 predicted this exact outcome: *"a 'load everything into memory and filter' pattern silently provided \[full-text search\] today... pagination removes that side-effect."* Confirmed live: the search box's `filteredCompanies` logic still runs, but only over the `companies` React state array — which now only holds whatever page(s) have been fetched through pagination, not the full collection. A company not yet loaded onto the current page is invisible to search, regardless of how exact the typed match would be.

This means the search-layer need Section 2 called *"likely... once pagination is in place"* is no longer a forward-looking prediction — pagination is in place, live, today, and the search box is quietly non-functional for anything outside the currently-loaded page.

### Decision direction: different engines for different schemas, not one blanket choice
Discussed and reasoned through, not yet built:

- **Tankonomics → a hosted search engine (Typesense proposed).** Directly resolves the gap above. Also the natural fit architecturally — Tankonomics is the one T3 app built as a React/Vite SPA with a build pipeline, so it can consume a proper search API and use InstantSearch-style components natively, unlike TWI and TankBazaar's static single-file HTML.
- **TankBazaar → also leans toward a hosted engine, despite being static HTML like TWI.** The deciding factor isn't build-step architecture — it's schema shape. Section 4 already established TankBazaar as "several genuinely different schemas wearing one label" (Refineries, Floating Structures, Oil Rigs, Pipelines, etc.), each with different meaningful fields (Nelson complexity, water depth rating, ammonia capacity...). That's a faceted-search-across-heterogeneous-types problem, which client-side text-matching libraries (Fuse.js, MiniSearch) handle poorly and real search engines handle natively.
- **TWI → client-side search remains the better fit.** Its schema is comparatively uniform (suppliers describable by category/products/certifications — Section 4's own characterization), its browsing pattern is mostly category-tree navigation rather than heavy free-text search, and at ~10,800 companies it's well within range for an in-browser library with no sync pipeline, no new server dependency, and no build-step conflict with its existing single-file architecture.

### Why Open Question #2 is now a hard blocker, not just a nice-to-have
A TankBazaar search index's schema — what's indexed, what's facetable, whether one search box can span asset types at all — depends entirely on whether TankBazaar ends up as separate Firestore collections per asset type or one collection with a `facility_type` discriminator. Designing the search schema before that's decided risks building it against the wrong shape and redoing it. This should be settled first.

### Not yet decided
- One shared Typesense instance for Tankonomics + TankBazaar, or two separate ones (see Open Question #6 above).
- Firebase's official Algolia/Typesense sync Extensions exist and would handle the Firestore→search-index sync automatically — worth using instead of hand-building that pipeline, but not yet evaluated in detail against this project's specific needs.
- Whether TWI's search need ever outgrows client-side (e.g., if it eventually gains TankBazaar-style schema heterogeneity) — no evidence of that today, flagged only as a "revisit if" rather than a current concern.

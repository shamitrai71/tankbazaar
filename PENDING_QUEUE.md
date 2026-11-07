# TankBazaar pending queue

Last updated: 7 Nov 2026. This file holds plans and status only, no data (the repo is kept data-free).
Order matters: section 1 must finish before the Big Merge (TankBazaar and TankWorldIndia into Tankonomics); sections 2 and 3 are built after it.

## 1. Before the Big Merge

### 1.1 Company register
- Seeders to run, in order: terminals V492, then companies V495 (V495 includes V488 to V494). Both run from the local server on port 8000.
- Phase 1 review sheet: decisions still open on held parents (Brookfield Infrastructure Partners, Canada Development Investment Corporation), Plains Canada Liquid Pipelines parent conflict, 24 records whose name no longer matches their LEI, 8 held legal names, 17 GEM LEI checks, Dart Oil & Gas check.
- Phase 0 leftovers: 20 garbled parent values, 5 possible duplicates, 135 companies whose GLEIF parent has no LEI.
- Phase 2 (US, from GEM): 285 companies still need a state registry search; 52 held (40 banks, funds and managers that stay out, 12 GEM LEI mismatches).
- Phases 3 to 7: local operators, other countries, facility linking (to be scheduled).
- Open entities: Star Energy Resources parent, Jurong Port parent, Advario Singapore remaining 55%, Tepsa Netherlands direct holder (Tepsa Infra SAS or RT NL B.V.), "Stolt-Nielsen" record CO01019 (Brazilian terminal company, needs rename or retirement), Antwerp terminals 11, 612 and 2266 (possible duplicates).
- Rules in force: banks, funds and insurers stay out; the register states legal owners, not operators, for process plants; public sources only.

### 1.2 Facilities
- Verification and missing-field rounds: companies, facilities, unlinked facilities.
- Terminal `cap` check for the roughly 7,900 terminals with no readable m³ (source by source).
- Existing-row corrections and held candidates (see the research notes).

## 2. Post-merge build-out (under review)

### 2.1 Pages to redesign or audit
- Benchmark, Market and Flow: audit each for genuine, regularly updated content before deciding whether it is a premium Tankonomics feature.
- Other pages to review with them: Prices, Tracking, Listings (confirm scope).
- Open decision: which of these stay in TankBazaar and which move to Tankonomics.

### 2.2 Company status marks (new, 7 Nov 2026)
Four marks replace the "Matched to an official company register" text, which must not be visible to non-admins.
- **R** Registered
- **C** Claim successful and the page is company-owned
- **V** All details verified by the owner of the page
- **P** Premium member (can post listings)

Status: R is built (company page, company list, terminal popups; patch_marks.py applied to index.html). C, V and P wait for:
- the claim flow and the premium flow setting `claimed`, `ownerVerified` and `premium` on the company record;
- the companies seeder carrying those fields so the list view can show them;
- a decision on where the marks appear on terminal popups.

### 2.3 Map and globe
One map and one globe, driven by filters, instead of a map per tab. Deferred until after the merge and the premium-feature decision (Mapbox free-tier map loads are the billed unit).

### 2.4 Data model
- Capacity model and operator-facility relationship.
- Value-chain tags (Upstream, Midstream, Downstream) on facilities and companies; open: whether chemical storage counts as Downstream.
- Move pipeline, rig, field and basin data out of index.html into Firestore, after the Tankonomics Firestore structure is checked. Reads for approved users only; signed-out visitors see a blurred view; terminal bundles later.

### 2.5 Access and sign-in with Tankonomics
- Tier granted per user by the super admin (or by payment); users link to a company as owner (Claim your Company, admin approved) or as a user approved by the owner.
- TankWorldIndia joins the same sign-in; bridge endpoint on Tankonomics' Cloud Run.
- Approval flow for the tier still to be discussed.

## 3. Operations
- VesselAPI key (ship tracking): rotate in Netlify before it lapses. It was last set 31 Oct 2026 and expires every 90 days (due about late Jan 2027).
- Firestore rules: the hardened version (blocks self-approval) is written but not applied.
- The terminal dataset must never be publicly downloadable; admins only until the app is validated.

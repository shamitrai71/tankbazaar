# T3 Decisions — Tankonomics, TankBazaar, TankWorldIndia

The single record of cross-app decisions for the three T3 apps. The same file
sits at the root of all three repos; when it changes, copy it to all three.

- **Last updated:** 27 Nov 2026.
- **Status words:**
  - **Decided** means Shamit decided it.
  - **Proposed** means a design waiting for review.
  - **Open** means not yet decided.
- **Based on** Tankonomics at commit `7f26806` (15 Nov 2026), TankBazaar at
  `c338c9a`, and the TankWorldIndia roster `TWI_companies_2026-11-15g_8826`
  with the 429-node category tree of the `TWI_Deploy_2026-11-14b_CCTV` build.
- **Fuller working versions:** `docs/TB_DATA_MOVE_PLAN.md` in the TankBazaar
  repo (data move, 17 Oct); `docs/TWI_Relationships_and_Brands_Spec.md` in the
  Tankonomics repo (corporate links and brands); the TWI working folder's
  `Rules_And_Decisions/Standing_Rules_and_Open_Items.md` (day-to-day TWI
  clean-up rules); `T3_Schema_Field_Check_2026-11-15.xlsx` (field mapping for
  the Big Merge).

Where this file disagrees with an older doc in any repo, this file wins. The
older docs carry a note pointing here.

---

## 1. The three apps

| | Tankonomics | TankBazaar | TankWorldIndia |
|---|---|---|---|
| Role | Hub ("mother ship"): members, companies, feeds, jobs, events, groups | Asset data: terminals, refineries, plants, floating facilities, pipelines, rigs, fields, basins | Supplier and service-company directory |
| Firebase project | `tankonomics` (+ `tankonomics-staging` for seed rehearsals) | `tankbazaar` | `tankworldindia-t5` |
| Firestore database | `(default)` | named `tankbazaar` | `(default)` |
| Hosting | Firebase Hosting + Cloud Run `tankonomics` (asia-south1) | Netlify (auto-deploy from `main`) | Firebase Hosting (Blaze), moving to Cloud Run |
| Approved status in `users` | `approved` (or no status field) | `active` | `approved` (or no status field) |
| Admin check | `admins/{uid}`, esraigroup@, petrodeksystems@ | esraigroup@ (by email) | esraigroup@, petrodeksystems@ (by email) |
| Size (15 Nov) | Company data to be emptied and fresh-seeded (§13) | about 8,000 facilities | 8,826 companies, 429 categories |

- ASTSPARES and TankProtocol are not part of T3 and are not linked to
  Tankonomics. AstSpares is a captive Petrodek Systems project (its own and
  its partners' products), not a directory category.
- **Users — Decided.** None of the three apps has users or claimants, and
  they stay that way until after the Big Merge. Launch target: India Energy
  Week, 27–30 Jan 2027 (Goa). Every sign-up needs admin approval before the
  public launch.
- **Later naming — Decided.** Much later, TankBazaar is split into three
  modules in one app: "TankBazaar", "Other Facilities" and "Pipeline
  Tracker". TankBazaar itself is not renamed.

## 2. Data placement — Decided (17 Oct)

- **TankBazaar keeps its own project and database, and stays the master copy
  of facility data.** It does not switch to an unnamed database: the data will
  later also be copied into the `tankonomics` project, so a new database inside
  `tankbazaar` would be wasted work.
- **The copy into `tankonomics` is one way only** (TankBazaar to Tankonomics),
  made by a scheduled job. Nothing is edited in the copy.
- **TankBazaar's pipeline, rig, field and basin data moves out of `index.html`
  into Firestore** as versioned bundles (a manifest plus parts of about 0.8 MB),
  readable by approved users only.
- **Phase 1 is done (17 Oct):** the built-in copy of about 6,400 terminals was
  removed from TankBazaar's `index.html`.
- **Signed-out visitors** see a blurred view with a sign-in prompt.
- **Later:** terminal bundles, and GEM gas routes as their own dataset after
  the move.
- **The TankBazaar terminal dataset must never be publicly downloadable.**
  Until the apps are validated, only admins use TankBazaar.

## 3. One sign-in through Tankonomics — Decided (17 Oct)

- **One account for all three apps.** Tankonomics accounts are the only
  accounts; TankBazaar and TankWorldIndia both use the Tankonomics sign-in.
- **TankBazaar access is a per-user permission in Tankonomics**, not a company
  setting, because companies are only pages. It is granted by one of:
  - the super admin;
  - admins approved by the super admin;
  - a completed payment.
- **The user must also be linked to a company**, in one of two ways:
  - as its owner, approved by an admin through Claim your Company;
  - approved by the company's owner.
- **Location ownership carries over to TankBazaar.** A company owner owns the
  company's locations, or approves other users as owners of single locations.
  That ownership makes them the approved claimant of the matching TankBazaar
  facility.
- **Tankonomics company locations link to TankBazaar** by
  `tankbazaar.com/#terminal-N`. Only users with TankBazaar access can open
  them; everyone else is blocked by TankBazaar itself.
- **The sign-in bridge runs on Tankonomics' Cloud Run service.**
- **TankWorldIndia** joins the same sign-in, and its hosting moves to Cloud
  Run. Its Firestore database stays where it is.

## 4. How the sign-in bridge works — Proposed

Each Firebase project has its own sign-in system, so the apps need a bridge.

1. **Grant.** Tankonomics `users/{uid}.tbAccess = { granted, source: 'admin' |
   'payment', grantedBy, grantedAt, expiresAt | null }`. Only the super admin,
   approved admins or the payment webhook may write it. It must stay out of the
   owner-editable field list in the `users` rule.
2. **Approving admins.** `admins/{uid}` is created and removed only by the
   super admin (`isSuperAdmin()`).
3. **Locations.** Each `companies/{slug}/locations/{id}` gets a number field
   `tbTerminalId`. The location's effective owner is its own `ownerUid`, else
   the company's `ownerUid` (the fallback in `docs/LOCATION_CLAIMING_DRAFT.md`).
4. **Endpoint.** `POST /api/bridge/token`, body `{ app: 'tb' | 'twi' }`, header
   `Authorization: Bearer <Tankonomics ID token>`. It:
   - verifies the token with `firebase-admin`, checking for revocation;
   - checks a valid `tbAccess` and a company link, and refuses otherwise with a
     reason the page can show;
   - collects the user's facilities: locations where `ownerUid == uid`, plus
     locations with no `ownerUid` under companies the user owns (needs a
     collection-group index on `locations.ownerUid`);
   - for TankBazaar, opens the **named database `tankbazaar`**
     (`getFirestore(app, 'tankbazaar')`; a wrong database id returns empty
     results, not an error), sets `ownerId: 'tk_<uid>'`, `claimStatus:
     'owned'` and `ownerSource: 'tankonomics'` on the facilities the user
     effectively owns, and clears the ones they no longer own;
   - for TankWorldIndia, does the same check with the TankWorldIndia service
     account (default database);
   - limits CORS to the TankBazaar and TankWorldIndia domains;
   - returns a custom token for user `tk_<uid>`, with claims
     `{ tk: true, tkUid, email }`.
5. **The other apps.** TankBazaar and TankWorldIndia sign in with
   `signInWithCustomToken`. Their rules let Tankonomics users read; for
   TankBazaar that is `request.auth.token.tk == true`, read only.
6. **Clean-up.** A nightly reconcile, run by Cloud Scheduler, clears claims of
   users who lost access. Removing the permission stops new sign-ins at once,
   and an open session ends within about an hour.
7. **Secrets.** The TankBazaar and TankWorldIndia service-account keys are kept
   in Secret Manager, mounted into Cloud Run.
8. **Auth settings.** Add the TankBazaar and TankWorldIndia domains to the
   Tankonomics project's Authorized domains, or the sign-in popup fails there.
   LinkedIn sign-in runs through `server.ts`, so the first version of the
   button offers Google and email only.
9. **Do not rely on the grandfather clause.** Tankonomics `isApprovedUser()`
   treats an account with no `status` field as approved; the bridge checks
   `tbAccess`, not that clause.

**Open:**

- payment provider and price;
- whether petrodeksystems@ is also super admin;
- what a Tankonomics owner may change on a TankBazaar facility: direct edits,
  or proposals an admin approves;
- whether Tankonomics approval also approves the user in TankWorldIndia, or
  TankWorldIndia needs its own flag (`twiAccess`);
- who holds the Cloud Run secrets (the TankBazaar and TankWorldIndia
  service-account keys).

## 5. Company identity across the apps — Decided principle, mapping to build

- **The Tankonomics slug is the shared company key.** Once a company is seeded
  into Tankonomics its slug never changes.
- **Before the Big Merge, TankWorldIndia slugs follow the name — Decided
  (replaces the 18 Oct rule "slugs never change").** When a company is renamed
  in the clean-up (to its registered or corrected name), it gets a new slug
  matching the new name, and the old slug is recorded in `TWI_RETIRED_SLUGS.csv`
  as `renamed`, with the old name kept in `aliases`. The TWI app cannot
  redirect old company links. This matches the 26 Oct decision to rename slugs
  more accurately across all three apps before the fresh seed.
- **Category slugs never change.** A renamed category keeps its slug; a merged
  category's slug is listed in the category redirect files (§12).
- **Slugs are internal.** They are never shown on a public page (hero,
  headings, cards) for any entity.
- **A mapping table links each slug** to the TankBazaar register Company ID
  (`CO#####`) and to the TankWorldIndia slug. Reviewed matches live in
  `src/lib/companyRegistryMap.ts` in the Tankonomics repo (data only, not yet
  read by the app); held, rejected and unmatched slugs are in
  `TB_Tankonomics_Link_Check_Reviewed.xlsx`.
- **Match on registry IDs, not names.** TankWorldIndia records carry
  `legalName` and `registrationId` (CIN/LLPIN, Companies House, KVK, HRB,
  SIREN, ABN and so on, with the LEI in front where one exists), taken from the
  official register. Use these as the first matching key; fall back to names
  only where no ID exists.
- **Retired TankWorldIndia slugs.** Every merged, deleted or renamed company
  slug is recorded in `TWI_RETIRED_SLUGS.csv` (with the dated
  `TWI_RETIRED_SLUGS_additions_*.csv` files of each round), with its survivor
  slug or "deleted". The mapping table and any link to a TankWorldIndia slug
  must resolve through that file.
- **A facility is an asset, not a company.** TankBazaar owns facility records;
  TankWorldIndia lists suppliers to those facilities.
- **TankBazaar facility ids are never reused.** Merged facility ids are listed
  in `TB_ID_REDIRECTS` (`src/lib/tbLocationId.ts`, Tankonomics repo), and
  Tankonomics location documents use the stable id `tb-<N>`. This replaces the
  table of six links in the 18 Oct version.

## 6. Database choice — Decided (17 Oct)

- **Stay on Firestore for all three apps.** Cloud Spanner is not adopted.
  - It has a fixed monthly cost.
  - It has no browser access or security rules.
  - Firestore already runs on Spanner underneath and scales to millions of
    users.
- **Revisit a relational database** (PostgreSQL through Firebase SQL Connect)
  only for a specific module that needs heavy joins on live data. It would sit
  alongside Firestore, not replace it.
- **BigQuery for cross-app reporting**, fed by scheduled copies, so analysis
  never runs against the live databases.

## 7. Building Tankonomics for 100,000 to 1,000,000 users — Proposed

What breaks first is how the app reads and writes, not the database. Findings
in the code at `4a13ce9`:

| Where | What happens now |
|---|---|
| Home feed (`Home.tsx`) | Live listener on every post, no limit |
| New chat (`NewChatModal`, `App.tsx`) | Reads every user, filters in the browser |
| Jobs, Forums, company posts | Whole collection, no limit |
| Global search (`App.tsx`) | 8 collections × 300 docs = 2,400 reads per search session |
| Admin analytics | Loads whole collections |
| Likes | Liker uids in an array on the post (1 MiB and write-rate limits) |
| Counters | Written by the browser; rules let any signed-in user change them |
| Notifications | Any signed-in user may create one for anyone |
| `users` | Readable in full by any signed-in user, emails included |
| Rules | `isApprovedUser()` does `exists` + `get` on every request |

**Changes:**

1. Page every list (`limit()` + cursors); use one-off fetches except for chat
   and notifications.
2. Build feeds as a timeline per user (a server job writes an entry into each
   follower's timeline); merge very large accounts' posts in at read time.
3. Move trusted writes to the server.
   - Trigger functions handle likes (one document per like), counters,
     notifications, feed copies and moderation.
   - Cloud Run handles payments, the bridge and admin actions.
4. Put tier and approval in custom claims.
5. Split the user record into a public profile and a private document (email,
   phone, billing).
6. Add a search engine (Typesense or Algolia), fed from Firestore. It also
   handles job filters.
7. Admin numbers from `count()` queries or BigQuery.
8. Protection:
   - App Check;
   - rate limits on Cloud Run;
   - tighter size limits in the rules (they still allow 2 MB `photoURL` and
     10 MB images).
9. Discipline:
   - a staging Firebase project;
   - emulator tests for the rules;
   - budget alerts.
10. Choose the database location deliberately; it can't be changed after
    creation. Regional in India suits a launch led by India Energy Week; if
    most users will be outside Asia, decide now while the data is small.

**Do before launch:** 1, 3 and 5.

## 8. Across the three apps — Proposed

- **One shared search index** with a section per app. Search keys are limited
  to what the user's tier may see.
- **One Cloud Run service** for the bridge, payments, webhooks and scheduled
  jobs.
- **TankBazaar and TankWorldIndia stay data apps** served as cached bundles;
  Tankonomics links to them and copies only what its pages need.

## 9. Known exposures to close

| App | Exposure | Fix |
|---|---|---|
| TankWorldIndia | `companies.json` (about 9,450 companies on 18 Oct) is served from hosting and committed to the repo, so anyone can download it | Serve it from Cloud Run only to approved, signed-in users, or load from Firestore; remove it from the repo |
| TankWorldIndia | The single-file build (`index.html` with the company list embedded) exposes the same data | Never commit or host the single-file build; deploy only the split build (`index.html` + `companies.json`) until the Cloud Run move |
| TankBazaar | Pipelines, rigs, fields and basins are still embedded in `index.html` | Phases 2 to 4 of the data move |
| TankBazaar | `liveDataCache` rule is `allow read, write: if true` | Give the vessels function its own service account, then close the rule |
| Tankonomics | `users` readable by any signed-in user; open notification creation; browser-written counters | §7 items 3 and 5 |
| Tankonomics | Server endpoints `/api/notify`, `/api/metadata`, `/api/job-apply` have no auth check (README §9) | Verify ID tokens, as the bridge will |

## 10. TankWorldIndia company data and locations — Decided

These rules govern how TankWorldIndia data is prepared for the Big Merge into
Tankonomics.

**Company identity**

- **The official register is the source of truth** for the display name,
  legal name, registered address and registration ID. For Indian companies
  that is the MCA register: the display name is the MCA registered name, and
  the MCA registered address and CIN/LLPIN are carried on the record.
- **Display name (restated 4 Nov).** For Private Limited, Limited, LLC/LLP and
  partnership firms the display name equals the legal name in full style
  ("Limited", not "Ltd"). Proprietorships keep their trade name. Indian
  companies need a legal suffix (Private Limited, Limited or LLP).
- **Registration details are internal.** Legal name, registry IDs, PAN, GSTIN
  and Udyam are for verification only and never appear on any public page of
  any T3 app. TWI keeps them in a private registry file, away from the app.
  One GSTIN per company, matching its registered address; it is the registry
  ID for proprietorships and partnerships.
- **Contact data is admin-only (decided 2 Nov).** Company email and phone are
  visible only to admins, in TWI and in Tankonomics.
- **Records sharing one registry ID are merged.** The duplicate's slug is
  retired and recorded in `TWI_RETIRED_SLUGS.csv`; real locations of the
  duplicate are carried over to the survivor.
- **Same name in different countries stays separate**: they are separate
  legal entities. A foreign company gets one record, plus a separate India
  record only when it is a real operating branch.
- **Subsidiaries are separate records** with `parent: { name, slug,
  relationship }`. Unlisted parents are organization records. Plants, works,
  divisions and offices that are not separately incorporated become locations
  of their company. Holding, IP and shell entities with no operations of their
  own are merged into their operating company (Round 19, 15 Nov).
- **Status.** Companies the register shows as not active are held; a company
  confirmed as liquidated, dissolved or struck off is deleted, not held.
- **Websites.** A website that belongs to another business is replaced with
  the right one, or cleared when the right one cannot be found.
- **Not stored:** Google Places business status (Google is not authoritative);
  vendor-list strings (discovery only; never shown or searchable); service
  types / delivery models (removed from TWI before the Big Merge).
- **Changes are tiered and approved.** Research is tiered (1 High to 4 not
  found), only approved tiers are applied, and every round has an applied log.
  Research lists sent out for validation exclude companies already verified.
- **The "R" and "V" signal squares are TankWorldIndia only**; they do not
  carry over to Tankonomics.

**Locations**

- **Locations of a supplier live on its TankWorldIndia company page**: head
  office, registered office, plants, regional and branch offices, service
  centres, R&D centres and warehouses. Every MCA-matched company carries its
  MCA registered address. Locations feed the Tankonomics jobs section.
- **Terminals and process facilities live only in Tankonomics**, as
  locations linked to TankBazaar (`tankbazaar.com/#terminal-N`). They are not
  added to TankWorldIndia.
- **Offices and branches of process-industry companies** (operators such as
  IOCL) are added from Tankonomics, not from TankWorldIndia or TankBazaar.
- **Location fields** in TankWorldIndia: `type`, `name`, `address`, `city`,
  `state`, `country`, `lat`, `lng`, `placeId`, `sourceUrl`, `sourceDate`. Types:
  `head-office`, `registered-office`, `plant`, `regional-office`,
  `branch-office`, `service-centre`, `r&d-centre`, `warehouse` (legacy
  `headquarters`, `office`, `branch` still read). Only the Place ID is loaded
  from Google; the Place ID Finder tool may only add Place IDs.

**Readiness (15 Nov 2026)**

- 8,826 companies (down from about 9,450 on 18 Oct after merges and
  deletions); 6,001 carry a legal name and 5,191 a registration ID; 5,147 are
  marked registry-verified.
- Category misfit rounds 1–19 are done (every section, plus the companies that
  had no category); 146 decisions are still open
  (`TWI_Pending_Decisions_2026-11-15.xlsx`).
- About 7,867 locations still use the legacy `headquarters` type; 43 parent
  links are plain text and 6 point at retired slugs.

## 11. What belongs in which app — Decided

- **TankBazaar holds process and storage entities only**: refineries,
  terminals, petrochemical, fertiliser and gas-processing plants, floating
  structures (FPSO/FSO/FSRU and LNG export terminals as asset owners), with oil
  rigs and pipelines growing. It holds no service companies. TankBazaar
  companies are the registered owners of their facilities.
- **TankWorldIndia holds suppliers and service companies.** Operators and
  facility owners (e.g. GAIL, IOCL, HPCL, Sikka Ports), storage and depot
  operators, and power producers and utilities do not belong in TWI. E&P
  operators are the owner's call, case by case.
- **No double listing.** TankBazaar never links to TWI and nothing is added to
  TWI from TankBazaar. Companies currently in both get a deep-dive round to
  settle where each belongs.
- **Stay in TWI:** upstream service companies and contract drillers (the UP
  section links all three apps); customs and forwarding brokers; rental firms
  (the RT section is a Tankonomics revenue line, kept separate from services).
- **Sector groups that never live in TWI:** Process Industries, Natural
  Resources & Upstream and Storage Terminals (Tankonomics and TankBazaar only).
  News, Media & Associations is part of TWI.

## 12. Category trees — Decided (15 Nov 2026)

- **TankWorldIndia's `CATEGORY_TREE` is the source of truth for supplier
  categories**: 429 nodes in 21 sections, each with a code (e.g. `FT-07.4`) and
  a slug. The tree was frozen on 8 Nov and extended since with UE-14 HVAC, EC-02.4
  shop-built tanks, the Piping & Pipeline Systems section (PP), UE-15 Cooling
  Towers, FS-17 Air Pollution Control and IA-06.1 CCTV & Video Surveillance.
- **Tankonomics' category tree matches TWI exactly** (same slugs, names,
  parents and order) and adds the TankBazaar categories below. It lives in
  `src/lib/categorySeed.ts` (439 nodes); retired Tankonomics slugs and their
  replacements are in `CATEGORY_REDIRECTS` in the same file.
- **TankBazaar categories:** Storage Terminals (no sub-categories); Process
  Industries with Refineries, Petrochemicals, Chemicals, Fertilizer Plants,
  Gas Processing and Offshore Production; Oil Rigs & Platforms (`oil-rigs`);
  Pipelines (`pipelines`). The Natural Resources branch and the other process
  categories (industrial gases, biofuels, edible oils, food, pharma,
  lubricants & bitumen) were dropped.
- **Attributes, not categories:** captive/independent (`access`), sole/JV
  ownership, port/inland/floating terminal type, rig type and pipeline
  commodity. TankBazaar facility records still need the `oil-rigs` and
  `pipelines` slugs when rigs and pipelines get categories there.
- **Category redirects:** `Category_Slug_Redirects_2026-11-08.csv` (TWI) and
  `CATEGORY_REDIRECTS` (Tankonomics).
- **Placement rules used in the misfit rounds** (details in the TWI standing
  rules): tags only for makers and specialist distributors; general traders
  MR-11; pipe stockists PP-01.6; plastic, GRE and FRP pipe MM-11; repair firms
  FT-31 (rotating) or AX-23 (valves); certification and third-party inspection
  AX-30; coating contractors EC-11, coating makers AX-04.1; boilers and burners
  UE-11; cooling towers UE-15; HVAC UE-14; air pollution control FS-17; crane
  hire RT-03; SPM/CALM buoys FT-19; EC-01 only for whole-project EPC; AX is
  services only (equipment makers go to IE or their product category); parent
  tags only where the sub-type is unclear.

## 13. The Big Merge into Tankonomics

**Decided**

- **Fresh seed (26 Oct).** Tankonomics company data is emptied and re-seeded
  with completely validated companies and locations only, with location ids.
  Required fields are checked per category. Logos and cover images are seeded
  later.
- **Only registry-verified companies go in.** The company claim process lives
  in Tankonomics.
- **TWI first.** TWI and TankBazaar companies are kept separate inside
  Tankonomics, and only TWI is synced for now. TankBazaar follows after its
  category and field work.
- **Data flows one way:** TWI → Tankonomics and TankBazaar → Tankonomics. TWI
  stays the system of record for suppliers, TankBazaar for facilities.
- **Companies in both apps** are shown as "both". Logo and banner precedence:
  Tankonomics upload, then TWI, then TankBazaar.
- **LinkedIn is the only company social link** (Facebook, Instagram, X
  removed).
- **Expected size:** about 20,000 companies including locations.
- **Business model** (e.g. whether the link through to a TWI or TankBazaar
  listing is for all claimed companies or premium only) is deferred until
  after the Big Merge.
- **Company pages, not a directory (27 Nov 2026).** Tankonomics has no
  company directory for users; the list of companies is for admins only.
  Companies live as pages that members reach by search, posts, jobs, events
  and links from TWI or TankBazaar. Each page is claimed by a user linked to
  the company, through the admin approval process.
- **Directory later (27 Nov 2026).** A user-facing directory (a Sales
  Navigator-type product) comes only after the pages are substantially
  claimed and their data accepted or updated by the owners.

**Proposed (15 Nov, from `T3_Schema_Field_Check_2026-11-15.xlsx`)** — replaced by the decided schema below (27 Nov 2026).

- Add to the Tankonomics company document before the seed: `countryCode`
  (ISO-2) and `country` (name), `hqCity`, `aliases[]`, `formerNames[]`,
  `brands[]`, `registryVerified`, `sources` (TWI / TankBazaar / both),
  `twiId`, `tbCompanyId`. Rename the seed's phone dial-code field to
  `phoneDialCode`.
- Keep email, phone, legal name, registration ID, Udyam number and research
  sources in an admin-only private store (the public company document is
  readable by every approved user).
- Corporate links as `organizations/{slug}` and
  `companyRelationships/{from}__{type}__{to}`; old slugs as
  `slugRedirects/{oldSlug}` (Relationships and Brands spec).
- Add to locations: `address`, `state`, `lat`, `lng`, `tbTerminalId`, and
  admin-only `sourceUrl`/`sourceDate`; rename `placeId` to `googlePlaceId` on
  export; one location-type list for all three apps (TWI's hyphenated types
  plus `port-terminal`, `inland-terminal`, `floating-facility`).
- Facility detail (capacity, tanks, berths, products, operator, metrics) stays
  in TankBazaar and is reached by link.

**Company schema — Decided (27 Nov 2026)**

Built from the 15 Nov field check and `docs/DATA_MODEL_V2.md`, checked against
the TWI roster `TWI_companies_2026-11-26c_8805`, the Tankonomics code at
`8b7ba82`, and the TankBazaar merge export (`scripts/t3_merge_export.py` and
`scripts/t3_common_fields.py`, "T3 Common Company Schema 17 Nov 2026") at
`9b9ba1d`. Where the two exports differ, the choice is marked below. Field names follow the live Tankonomics code where one exists, so
the app needs fewer changes. TWI → Tankonomics renames are done by the export.

*Company page: `companies/{slug}`, readable by approved members*

| Field | From TWI | Notes |
|---|---|---|
| doc id = `slug` | `slug` | Never changes once in Tankonomics |
| `name` | `name` | Registered legal name style, as in TWI |
| `twiId` | `id` | Numeric TWI id |
| `tbCompanyId` | — | TankBazaar register id, when the company is in both |
| `sources` | — | List: `TWI`, `TankBazaar` or both (as the TankBazaar export writes it) |
| `country`, `countryCode` | `country` | Name and ISO-2 |
| `hqCity`, `hqState` | HQ location | For the company picker and search |
| `description` | `desc` | One text field; the old `aboutUs` is dropped |
| `website` | `site` | |
| `linkedin` | `linkedin` | The only social link; shown as a labelled LinkedIn button on the company page, as in TWI; `socialLinks` is dropped |
| `logo`, `heroImage` | `logo` | Cover images are seeded later |
| `categoryIds` | `cats` | Leaf slugs of the shared tree; replaces the old single `categoryId` |
| `companyTypes`, `stockist` | derived from `cats` | Shared codes: `mfr`, `dist`, `contr`, `svc`, `cons`, `rent`, `oper`, `nonsup`. TWI derives them from its categories; TankBazaar stores them |
| `aliases`, `formerNames`, `brands` | same | Lists of text |
| `registryVerified` | `registered` | True for every seeded company; kept for later additions |
| `parentSlug`, `parentRelationship` | `parent` | Copy of the link; the full set lives in `companyRelationships`. One relationship list: `subsidiary`, `division`, `joint-venture`, `affiliate`, `associate`, `owned-by`, `brand-of` (TWI has the first six, TankBazaar adds `brand-of`) |
| `externalDirectoryUrl`, `externalDirectoryName` | — | Link to the TWI or TankBazaar listing (who sees it is a business-model decision) |
| `isClaimed`, `ownerUid`, `plan`, `planSince`, `isFeatured` | — | Empty or false at seed |
| `locationCount`, `followerCount` | — | Kept current by the server |
| `createdAt`, `updatedAt`, `seedVersion` | — | Set by the seeder |

*Admin-only store: `companies/{slug}/private/admin`*

- registry: `legalName`, `legalNameSource`, `registrationId`, `registryIds`,
  `lei`, `legalForm`, `jurisdiction`, `registryStatus` (the TankBazaar set);
  TWI adds `gstin`, `pan`, `constitution`, `otherIds`, `nameHistory`,
  `websiteHistory`;
- `email`, `phone`, `phoneDialCode` (admin-only, as in TWI);
- `sectors`, `msmeCategory`, `udyamNumber` (flat, as the TankBazaar export
  writes them), `delivery`;
- `notes`, and per location `sourceUrl` and `sourceDate`.

None of this is on the company page, which every approved member can read.

*Locations: `companies/{slug}/locations/{id}`*

- **Ids:** `twi-{n}` for TWI sites, `tb-{facilityId}` for TankBazaar
  facilities, so a re-seed updates in place.
- **Fields:** `type`, `name`, `address`, `city`, `state`, `country`,
  `countryCode`, `lat`, `lng`, `googlePlaceId` (TWI `placeId`); TankBazaar
  facilities also carry `tbTerminalId`, `role` (`owner`, `operator`,
  `owner-operator`), `facilityClass`, `processType`, `primaryClass`,
  `externalUrl`; ownership `ownerUid`, `ownerSource`, `assignedBy`,
  `assignedAt`. `sourceUrl` and `sourceDate` go to the admin-only store.
- **Country:** filled from the company when a TWI location has none (most
  TWI locations carry no country of their own).
- **One type list for all three apps:** `head-office`, `registered-office`,
  `regional-office`, `branch-office`, `plant`, `service-centre`,
  `r&d-centre`, `warehouse`, `port-terminal`, `inland-terminal`,
  `process-facility`, `floating-facility`, `pipeline`. TWI's legacy types are
  mapped: `headquarters` → `head-office`, `office` and `branch` →
  `branch-office`.

*Differences found in the TankBazaar export (27 Nov 2026), settled the same day*

- **Facility link form.** The export writes `externalUrl` as
  `tankbazaar.com/#/facility/{N}`, but Tankonomics reads only
  `#terminal-{N}` (`src/lib/tbLocationId.ts`), so stable location ids and
  merged-id redirects would fail for exported records. **Decided:** store
  `#terminal-{N}` everywhere; the export is changed, and Tankonomics reads
  both forms.
- **Process facilities typed as terminals.** The export maps every facility
  that is not `port` or `floating` to `inland-terminal`, refineries included.
  **Decided:** `process-facility` when the facility class is process only
  (export changed).
- **Pipelines.** Since 22 Nov the export includes pipelines as locations
  (`type: pipeline`, with `tbPipelineId`, route, length and capacity).
  **Decided:** pipelines are connected to their owners before the merge, and
  some of them go in with the first seed as locations; the rest follow
  later. This updates the 17 Nov note that pipelines come much later.
- **Names.** `parentRelationship` (not `relationship`), `sources` as a list,
  and flat `msmeCategory` / `udyamNumber` are taken from the TankBazaar
  export above.

*Links between the apps (checked 27 Nov 2026; to fix before the merge)*

- **Tankonomics → TWI:** `externalDirectoryUrl` points at
  `https://tankworldindia.com/#/company/{slug}`. The TWI app answers on
  `tankworldindia-t5.web.app`; the custom domain must be confirmed as live
  before the seed, or the export uses the address that works.
- **Retired TWI slugs:** TWI has no redirect for deleted or merged company
  slugs, so a link to one shows "No company at this URL". TWI needs a redirect
  from each merged slug to the company it was merged into (from
  `TWI_RETIRED_SLUGS.csv`), and Tankonomics gets the same list as
  `slugRedirects`.
- **TWI → Tankonomics:** TWI's category tiles link "Companies on Tankonomics"
  to `tankonomics.web.app/directory?category=…`. That directory is admin-only,
  so the link fails for everyone else. Remove it until there is a user-facing
  page to link to.
- **Tankonomics → TankBazaar (checked):** locations link to
  `https://tankbazaar.com/#terminal-{N}`, which opens the facility for
  signed-in members. Merged facility ids redirect on both sides, and the two
  lists match (43 ids in `TB_ID_REDIRECT` in TankBazaar and in
  `src/lib/tbLocationId.ts`); keep them in step. Fixed 27 Nov in TankBazaar:
  a signed-out visitor's `#terminal-N` link now opens after sign-in, and the
  `#/facility/{N}` form also follows merged ids. `#terminal-N` stays the form
  Tankonomics stores.
- **TankBazaar → Tankonomics and TWI:** TankBazaar has no links out; a
  company shows its Tankonomics address (`/business/{slug}`) as text only, and
  it never links to TWI (§11).

*Other collections:* `organizations/{slug}` (parents that are not listed
companies), `companyRelationships/{from}__{type}__{to}`,
`slugRedirects/{oldSlug}`.

*Not carried over:* the R and V squares; the legacy `categoryId`,
`subCategoryId`, `aboutUs`, `socialLinks` and the free-text company
`address`.

*Done 27 Nov 2026:* Tankonomics security rule (company page no longer
needs the single `categoryId`, refuses registration and contact fields, and
the admin-only `private` store is added); Tankonomics reads both TankBazaar
link forms; the TankBazaar export writes `#terminal-{N}` and
`process-facility`.

*Still to do:* the company page and Admin screens for the new fields, and the
TWI export (validation report first, rehearsed on `tankonomics-staging`).

**Open**

- How a company links to its rigs and pipelines in Tankonomics.
- The Tankonomics admin action that empties company data before the seed.
- Fixes in TWI before export: legacy location types, text-only parents,
  parent links to retired slugs.

## 14. Releases and costs — Decided

- **TWI release order:** push and deploy the hosting build first, then publish
  the roster JSON in Admin, then run the orphan scan and delete only what the
  removal archives explain.
- **TWI files:** roster and master changes come as `ROSTER_ONLY_*` zips (the
  master `index.html` in them is never deployed); app changes come only as
  `TWI_Deploy_*` builds. Repo updates come as a zip of the changed files in
  their repo paths.
- **Descriptions:** the published roster JSON is the source of truth; edits
  are copied into the app master, never the other way round.
- **Hosting cost:** TWI is on the Blaze plan and each hosting deploy caused a
  usage spike, so deploys are kept rare and the app is to be redesigned to cut
  that cost.
- **Search:** Typesense for Tankonomics (decided); other options for TWI and
  TankBazaar.

## 15. Tankonomics jobs and salary data — Decided (26 Nov 2026)

- **No levels.fyi.** Levels.fyi is not used for the Tankonomics jobs section.
  It covers mainly software and big-tech pay, has little data on tank,
  terminal and process-industry roles in India or the Gulf, sells salary
  data rather than job postings, and is enterprise-priced with unclear
  display rights.
- **Jobs come from verified companies.** Jobs are posted by claimed,
  verified companies, in line with the claim and verification model; no
  imported job feeds at launch.
- **Own salary data later, through Surveys.** Tankonomics builds its own pay
  data through the Surveys section, for example an annual **"Tank & Terminal
  Industry Salary Survey"** for members. The data belongs to Tankonomics and
  is specific to the industry, which levels.fyi cannot offer. It can become a
  paid report or a lead magnet.

## 16. Tender board — Decided (26 Nov 2026)

- **It lives in Tankonomics, not TWI.** The tender board is part of the
  interactive Tankonomics app, where it is worth using for members. TWI does
  not carry it.
- **A curated board, built by us.** Government and public-sector tenders are
  public notices. Admins post a short summary of each relevant tender: title,
  authority, closing date and value, with a link to the official notice. The
  tender documents themselves are not copied. This fits the verified-data
  approach used across the T3 apps.
- **How entries are added.** Admins add entries by hand, or use official
  feeds where a portal offers one. No automated scraping: most portals have
  CAPTCHAs and rules against it.
- **No third-party tender-data feed for now.** TenderKosh (API) was reviewed
  and not adopted: its terms ban republishing and limit use to internal
  business use, its operator is not named, and its portal coverage is not
  listed. Any paid feed would need a written right to display the tenders
  and a named company behind it.
- **Replaces the earlier note.** This settles the "tenders via partners or
  own app" item: the board is our own, inside Tankonomics.

## 17. Change log

- **17 Oct 2026:** first version. Covers the data placement, sign-in bridge,
  company identity, database choice and scale review above.
- **18 Oct 2026:** added §10 (TankWorldIndia company data and locations),
  registry-ID matching and retired slugs in §5, bridge details and open items
  from the plan in §4, the single-file build exposure in §9, and the database
  location note in §7. The plan now lives in the TankBazaar repo at
  `docs/TB_DATA_MOVE_PLAN.md`.
- **15 Nov 2026:** brought up to date with the work since 18 Oct. §1 sizes,
  users and module naming; §5 slug rule changed (renamed TWI companies get a
  new slug before the merge; frozen once in Tankonomics), registry map and TB
  facility redirects; §10 data rules added since (display names, private
  registration and contact data, websites, things not stored, readiness);
  new §11 app placement, §12 category trees (Tankonomics now matches TWI and
  TankBazaar), §13 the Big Merge (decided rules and the proposed field
  additions), §14 releases and costs.
- **26 Nov 2026:** new §15 (Tankonomics jobs and salary data: no levels.fyi,
  jobs from verified companies, own salary survey through Surveys); change
  log moved to §16.
- **26 Nov 2026 (later):** new §16 (tender board: lives in Tankonomics, curated
  by admins with links to the official notices, no scraping, TenderKosh not
  adopted); change log moved to §17.
- **27 Nov 2026:** §13 — company pages, not a user directory (directory
  later, once pages are substantially claimed); company schema for approval
  (company page, admin-only store, locations, one location-type list);
  LinkedIn button; links between the apps checked, with fixes listed
  (TankBazaar side checked and fixed the same day); schema reconciled with
  the TankBazaar merge export, with three differences to settle.
- **27 Nov 2026 (later):** §13 company schema decided, with the three
  TankBazaar export differences settled (link form, process facilities,
  pipelines in part at the first seed); rule and export changes done.

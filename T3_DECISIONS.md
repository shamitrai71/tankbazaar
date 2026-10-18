# T3 Decisions — Tankonomics, TankBazaar, TankWorldIndia

The single record of cross-app decisions for the three T3 apps. The same file
sits at the root of all three repos; when it changes, copy it to all three.

- **Last updated:** 18 Oct 2026.
- **Status words:**
  - **Decided** means Shamit decided it.
  - **Proposed** means a design waiting for review.
  - **Open** means not yet decided.
- **Based on** Tankonomics at commit `4a13ce9` (11 Sep 2026), TankWorldIndia at
  `e2711f9` (15 Oct 2026) and TankBazaar seed V399 (8,027 terminals).
- **Fuller working version:** `docs/TB_DATA_MOVE_PLAN.md` in the TankBazaar
  repo ("TankBazaar data move to Firestore — plan", 17 Oct), which has the
  reasoning, costs, phase checks and the per-app build notes.

Where this file disagrees with an older doc in any repo, this file wins. The
older docs carry a note pointing here.

---

## 1. The three apps

| | Tankonomics | TankBazaar | TankWorldIndia |
|---|---|---|---|
| Role | Hub: members, companies, feeds, jobs, events, groups | Asset data: terminals, refineries, plants, pipelines, rigs, fields, basins | Supplier and service-company directory |
| Firebase project | `tankonomics` | `tankbazaar` | `tankworldindia-t5` |
| Firestore database | `(default)` | named `tankbazaar` | `(default)` |
| Hosting | Firebase Hosting + Cloud Run `tankonomics` (asia-south1) | Netlify (auto-deploy from `main`) | Firebase Hosting, moving to Cloud Run |
| Approved status in `users` | `approved` (or no status field) | `active` | `approved` (or no status field) |
| Admin check | `admins/{uid}`, esraigroup@, petrodeksystems@ | esraigroup@ (by email) | esraigroup@, petrodeksystems@ (by email) |

ASTSPARES and TankProtocol are not part of T3 and are not linked to Tankonomics.

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

- **The Tankonomics slug is the shared company key.** Never rename a slug
  after seeding.
- **A mapping table links each slug** to the TankBazaar register Company ID
  (legal name, LEI or national registry number) and to the TankWorldIndia slug.
  - First pass: `TB_Tankonomics_Link_Check.xlsx`, which matched 858 Tankonomics
    companies: 163 exact, 120 through TankBazaar names (to check), 5 weak, 570
    no match.
- **Match on registry IDs, not names.** TankWorldIndia records carry
  `legalName` and `registrationId` (CIN/LLPIN, Companies House, KVK, HRB,
  SIREN, ABN and so on, with the LEI in front where one exists), taken from the
  official register. Use these as the first matching key against the
  TankBazaar register and Tankonomics; fall back to names only where no ID
  exists. The first name-based pass left 570 of 858 Tankonomics companies
  unmatched.
- **Retired TankWorldIndia slugs.** The TankWorldIndia clean-up merges
  duplicates and deletes companies that are no longer active, which retires
  their slugs. Every retired slug is recorded in `TWI_RETIRED_SLUGS.csv` in the
  TankWorldIndia repo, with its survivor slug or "deleted". The mapping table
  and any link to a TankWorldIndia slug must resolve through that file. A
  surviving record never changes its slug.
- **A facility is an asset, not a company.** TankBazaar owns facility records;
  TankWorldIndia lists suppliers to those facilities.
- **Six Tankonomics location links point at TankBazaar duplicates** that were
  deleted. Change them to the replacement ids:

  | Old id | New id |
  |---|---|
  | 74 | 3406 |
  | 419 | 3406 (to confirm) |
  | 420 | 3414 |
  | 521 | 76 |
  | 551 | 6434 |
  | 96 | 685 |

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

These rules govern how TankWorldIndia data is prepared for the merge into
Tankonomics. The hold on seeding company data into Tankonomics (§3 of
`TankBazaar_Tankonomics_Merge_Discussion.md` in the TankWorldIndia repo) stands
until this preparation is done.

**Company identity**

- **The official register is the source of truth** for the display name,
  legal name, registered address and registration ID. For Indian companies
  that is the MCA register: the display name is the MCA registered name, and
  the MCA registered address and CIN/LLPIN are carried on the record.
- **Slugs never change.** A rename changes the display name and keeps the old
  name in `aliases`.
- **Records sharing one registry ID are merged.** The duplicate's slug is
  retired and recorded in `TWI_RETIRED_SLUGS.csv`.
- **Same name in different countries stays separate**: they are separate
  legal entities.
- **Subsidiaries are separate records** with `parent: { name, slug,
  relationship }`. Plants, works, divisions and offices that are not separately
  incorporated become locations of their company.
- **Status.** Companies the register shows as not active are held; a company
  confirmed as liquidated, dissolved or struck off is deleted.
- **Changes are tiered and approved.** Research is tiered (1 High to 4 not
  found), and only approved tiers are applied, with an applied log.
- **The "R" and "V" signal squares are TankWorldIndia only**; they do not
  carry over to Tankonomics.

**Locations**

- **Locations of a supplier live on its TankWorldIndia company page**: head
  office, registered office, plants, regional and branch offices, service
  centres, R&D centres and warehouses. They are added before the merge
  because they feed the Tankonomics jobs section.
- **Terminals and process facilities live only in Tankonomics**, as
  locations linked to TankBazaar (`tankbazaar.com/#terminal-N`). They are not
  added to TankWorldIndia.
- **Offices and branches of process-industry companies** (operators such as
  IOCL) are added from Tankonomics, not from TankWorldIndia or TankBazaar.
- **Location fields** in TankWorldIndia: `type`, `name`, `address`, `city`,
  `state`, `country`, `lat`, `lng`, `placeId`, `sourceUrl`, `sourceDate`. Types:
  `head-office`, `registered-office`, `plant`, `regional-office`,
  `branch-office`, `service-centre`, `r&d-centre`, `warehouse` (legacy
  `headquarters`, `office`, `branch`, `facility` still read).

**Readiness (18 Oct 2026)**

- About 9,450 companies; about 3,850 carry a verified legal name and
  registration ID.
- About 5,600 in 90 countries are still being verified, country by country,
  from the "TWI Companies enrichment" work folder.
- Locations have been researched company by company (BHEL, Thermax so far).

**Open**

- Mapping of TankWorldIndia location types and fields to the Tankonomics
  location schema.
- Place IDs for newly added locations.

## 11. Change log

- **17 Oct 2026:** first version. Covers the data placement, sign-in bridge,
  company identity, database choice and scale review above.
- **18 Oct 2026:** added §10 (TankWorldIndia company data and locations),
  registry-ID matching and retired slugs in §5, bridge details and open items
  from the plan in §4, the single-file build exposure in §9, and the database
  location note in §7. The plan now lives in the TankBazaar repo at
  `docs/TB_DATA_MOVE_PLAN.md`.

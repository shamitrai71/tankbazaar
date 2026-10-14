# T3 Architecture and Migration Plan

Oct 9, 2026 · @Shamit Rai

## Purpose and decisions asked

Recommendation: keep Tankonomics on Firebase, move TankBazaar's confidential asset data to our own PostgreSQL/PostGIS database behind our own API, and use one Firebase sign-in across all three apps. This gets a secure, affordable base in place before India Energy Week (27–30 January 2027) without rewriting the live Tankonomics app.

Scope is T3 only: Tankonomics (the hub), TankWorldIndia (TWI) and TankBazaar. tankprotocol and astspares are not part of T3. This plan builds on the existing *TankBazaar, TWI & Tankonomics — Architecture, Merge Implications, and Launch Strategy* document and does not reopen its decisions (merge on hold, sync tracks decoupled, asset vs supplier boundary, common core plus extensions).

Decisions this plan asks for:

1. Approve the hybrid target architecture (section *Target architecture*).
2. Settle Open Question 2 of the merge document: one asset table with a `facility_type` field plus per-type extension tables.
3. Choose hosting provider and region (Mumbai assumed).
4. Name who runs operations: patching, backups, incidents.

## Where things stand (9 October 2026)

TankBazaar's data is the most valuable part of T3 and the least protected: most of it is readable without signing in, and its one live database collection is read in full on every page load.

| App | Built as | Data lives in | Size today |
| --- | --- | --- | --- |
| Tankonomics | React/Vite app, Firebase | Firestore (`companies`, people) | Live, paginated directory (48 per page) |
| TWI | Single-file HTML | In the file | About 5,000 companies (merge doc) |
| TankBazaar | Single-file HTML (11.4 MB), Netlify | Terminals in Firestore; basins, fields, rigs and pipelines embedded in `index.html` | 8,002 terminals, 199 basins, \~5,889 fields, 599 rigs, 1,357 pipelines |

Problems found in TankBazaar this week, all verified in the code:

- **Full reads on every load.** `TerminalStore.load()` lists all 8,002 terminal documents (27 requests of 300), and runs twice for a signed-in approved user: up to about 16,000 reads per visit against a free quota of 50,000 a day. The quota ran out on 8 October.
- **Seeders rewrite everything.** Each seeder run writes all 8,002 documents, against 20,000 free writes a day.
- **Data public without sign-in.** `index.html` embeds 6,434 terminals (2.2 MB) plus the whole register. Netlify publishes the repo root (`publish = "."`), so `Docs/*.xlsx`, seeder files, `basin_boundaries_full_resolution.gpkg`, scripts and the merge document itself are downloadable by path.
- **Self-approval.** The Firestore rules let any signed-in user set their own profile to `status: 'active'`, which unlocks terminals and listings. A fix is written and awaiting your test and publish.
- **Open cache.** `liveDataCache` is world-writable (vessel and commodity cache; no terminal data).

## Requirements

The architecture must keep TankBazaar data private, cost little at low traffic, and be ready by IEW 2027 (about 16 weeks away).

| Requirement | What it means in practice |
| --- | --- |
| Confidential asset data | No TankBazaar data reaches anyone who is not signed in and approved by the admin; no bulk export; per-user limits and access logs |
| Admin-only approval | Only the admin approves users or changes roles (rules fix pending) |
| Cost tracks use | No per-read billing that grows with dataset size; a busy day must not take the site down |
| Two-sided Tankonomics | Company profiles are meant to be found; people profiles and the directory stay on Tankonomics |
| Asset vs supplier boundary | TankBazaar owns assets (terminals, refineries, rigs, pipelines); TWI owns suppliers; operators link the two |
| Heterogeneous asset types | Terminals, refineries, petrochemical, fertiliser, floating units, gas processing, rigs, fields, pipelines, basins each keep their own fields |
| Geospatial | Points, outlines and routes queried by map area; map shows only what is in view |
| Provenance | Every record keeps source, position accuracy (`site`, `grid`, `town`) and last verified date |
| One sign-in | A user signs in once across T3 |
| Deadline | Secure TankBazaar data path live before IEW 2027 (27–30 January 2027) |

## Target architecture

TankBazaar data moves to our own database and API; Tankonomics stays on Firebase; Firebase Auth is the single sign-in for all three apps.

&#91;embedded content: T3 target architecture · 3 apps, 2 hosting zones\]

TankBazaar's page talks only to the T3 API, which verifies the Firebase token and the user's approval before any record leaves Postgres; Tankonomics keeps its own Firestore data and TWI keeps its existing sync track.

- **TankBazaar front end** becomes an app shell with no embedded data. It asks the T3 API for map tiles, search results and record detail, sending the user's Firebase ID token.
- **T3 API** (Node/Express) verifies the token, checks the user's approval and role in Postgres, applies per-user rate limits, logs access and never returns more than one page of records.
- **PostgreSQL + PostGIS** holds all asset data, users' T3 roles, approvals and the audit log. A tile server (Martin) renders vector tiles from PostGIS behind the same API check.
- **Tankonomics** keeps its Firestore company and people data. It reads asset summaries for an operator's profile through the T3 API, not by copying TankBazaar data into Firestore.
- **TWI** stays a static app with client-side search; its supplier data reaches Tankonomics through the existing TWI ↔ Tankonomics sync track.

Alternatives considered:

| Option | Why not chosen |
| --- | --- |
| Keep TankBazaar on Firestore with bundled reads | Cheaper reads, but data still reaches the browser in bulk and access control stays in rules only |
| Move all of T3, including Tankonomics, to the new stack | Rewrites a live React app; too much risk before IEW 2027 |
| Our own physical servers | Adds power, network, hardware and physical security work with no benefit at this data size |
| Hosted search (Typesense) for TankBazaar with a browser key | A browser search key lets any signed-in user page through the whole index |

## Data model

One `assets` table holds the common core of every TankBazaar record, with a `facility_type` field; each type keeps its own fields in an extension table. This answers the merge document's Open Question 2 and matches its "common core plus extensions" direction.

| Table | Holds | Key fields |
| --- | --- | --- |
| `assets` | Common core for every asset | `id` (UUID), `facility_type`, `name`, `country`, `city`, `geom` (point, outline or route), `status`, `operator_id`, `access` (independent or captive), `pos_acc` (site, grid, town), `source`, `verified_at` |
| `asset_terminal` | Storage terminals | tanks, berths, products, port/inland/floating, storage capacity (m³) |
| `asset_refinery` | Refineries | throughput, Nelson complexity, crude slate |
| `asset_floating` | FPSO, FSO, FSU, FSRU, FLNG | vessel specs, mooring, water depth, storage |
| `asset_process` | Petrochemical, fertiliser, gas processing | feedstock, product capacities |
| `asset_rig` / `field` / `basin` | Upstream register | type, status, field and basin links, outlines |
| `asset_pipeline` | Pipelines | route, length, diameter, capacity, flow direction |
| `operators` | Companies that own or run assets | name, country, `tankonomics_company_id` |
| `asset_links` | Asset to asset (FPSO ↔ field, rig ↔ field) | from, to, kind, source |
| `legacy_ids` | Old IDs from seeders and the register | old id, system, new UUID |
| `audit_log` | Every change and every bulk read | who, what, when, before/after |

Rules that carry over from TankBazaar work:

- Permanent UUIDs replace the seeder integers; `legacy_ids` keeps every old ID so nothing breaks during migration.
- `facility_type` is set on every row at import, so the later TankBazaar / Other Facilities / Pipeline Tracker module split is a filter, not a migration.
- Positions never invented; `pos_acc` and `source` travel with every point.
- Storage capacity (m³) gets its own field instead of being kept out of the record, ending the `cap` = throughput workaround.
- The bridge to Tankonomics is the operator: an asset points to an operator, and the operator to a Tankonomics company profile. Assets do not become Tankonomics companies.

## Access control and data protection

Every TankBazaar record is served by the API after a sign-in and approval check; nothing confidential ships in a static file.

- **Sign-in:** Firebase Auth (Google or email). The API verifies the ID token on every request with the Firebase Admin SDK.
- **Approval and roles:** stored in Postgres, changed only by the admin. Roles: `superadmin`, `admin`, `member` (approved reader), `pending`, `suspended`. Per-app access flags (Tankonomics, TWI, TankBazaar) on the same user.
- **No bulk export:** list and search endpoints return at most one page (for example 50 rows); map tiles carry only the fields a marker needs; full detail is one record per request.
- **Limits and logs:** per-user request limits; every detail view and search logged; an alert when one user reads an unusual share of the dataset in a day.
- **Nothing confidential in the deploy:** Netlify publishes a `public/` folder with the app shell only; registers, seeders, scripts and notes stay in the private repo.
- **Optional later:** per-user watermark fields in returned records, to trace a leak back to an account.

What this cannot do: an approved user can still copy what they are shown. Limits and logs make bulk copying slow and visible; they do not make it impossible.

Licensing checks before commercial launch:

- Positions taken from OpenStreetMap fall under the ODbL, which has share-alike terms for derived databases. Replace those 18 positions or confirm the terms allow our use.
- GEM data needs attribution; Google data is limited to Place IDs; Mapbox terms apply to the base map.
- India's Digital Personal Data Protection Act 2023 applies to T3 user accounts.

## Search

TankBazaar search runs inside the API on Postgres; Tankonomics can use a hosted engine with a browser key because its directory is meant to be public; TWI keeps client-side search.

| App | Engine | Why |
| --- | --- | --- |
| TankBazaar | Postgres full-text plus trigram similarity (`pg_trgm`), facets by SQL, behind the API | About 10,000–20,000 records fit easily; results stay paged and logged; no second copy of the data to secure or sync |
| Tankonomics | Typesense (as the merge document proposes), synced from Firestore | Public, two-sided directory; a search-only key in the browser exposes nothing secret |
| TWI | Client-side (as decided in the merge document) | Uniform supplier schema, category browsing, \~10,800 companies |

If TankBazaar later needs a dedicated engine, a self-hosted Typesense can sit behind the API, queried server-side only, never with a key in the browser.

## Infrastructure and operations

One rented server in a Mumbai region runs the whole TankBazaar stack, with off-server backups and a separate staging copy; estimated running cost is about US$15–60 a month before Mapbox.

| Part | Choice | Notes |
| --- | --- | --- |
| Production server | 1 VPS, about 4 vCPU, 8 GB RAM, 80 GB SSD | Docker Compose: Postgres + PostGIS, API, Martin tile server, Caddy (automatic HTTPS) |
| Staging | A smaller second server or a second Compose stack | Every change checked here before production |
| Edge | Cloudflare (free tier) | DDoS protection, firewall rules, hides the server address |
| Front ends | Netlify, publishing `public/` only | App shells with no data |
| Sign-in | Firebase Auth | Free for this scale; Firestore no longer used by TankBazaar |
| Backups | Nightly `pg_dump` plus point-in-time recovery to object storage | Monthly restore test |
| Monitoring | Uptime check, error tracking (e.g. Sentry), disk and memory alerts | Alerts to the admin's email or phone |
| Deploys | GitHub Actions builds and deploys from the private repo | Staging first, then production |
| Security | SSH keys only, firewall, database not exposed, secrets outside git, automatic OS updates |  |

Ongoing work someone must own: OS and database updates (monthly), backup restore test (monthly), certificate and domain renewals, incident response. Cost figures are estimates to check against current provider price lists.

## Migration plan

Five phases take TankBazaar from today's exposed setup to the new stack by 10 January 2027, leaving two weeks of freeze before IEW. Each phase ends at a gate that must pass before the next starts. The TWI ↔ Tankonomics sync track runs alongside, unchanged.

&#91;embedded content: T3 migration timeline · 5 phases to IEW 2027\]

Phase 2 is the longest and the one most likely to slip; the gates below decide whether each phase is done.

1. **Phase 0 — Close the exposures (12–18 October).** Publish the admin-only approval rules; publish only `public/`; check `Docs/`, seeders and the merge document return the app shell; review users for unexpected `active` accounts; lock `liveDataCache` to the Netlify function; move Firebase to the Blaze plan with a budget alert.
   - Gate: the rules playground tests pass and no confidential file is downloadable by path.
2. **Phase 1 — Database and import (19 October – 15 November).** Stand up staging; create the schema; import terminals from Firestore and the register from the v115 workbook and pipeline export; fill `legacy_ids` and `facility_type`.
   - Gate: row counts match the sources (8,002 terminals, 199 basins, \~5,889 fields, 599 rigs, 1,357 pipelines) and 50 random records match field by field.
3. **Phase 2 — API, tiles and the new front end (16 November – 20 December).** Build the API with sign-in checks, limits and logs; Martin tiles; Postgres search; admin editing; an import tool with a change preview to replace seeder files; switch the TankBazaar page to the API on staging and remove all embedded data.
   - Gate: `index.html` holds no asset data; a visit loads only what is in view; every admin action works on staging.
4. **Phase 3 — Cutover (21 December 2026 – 10 January 2027).** Production server, backups and monitoring live; switch tankbazaar.com to the new stack; keep Firestore terminals read-only for one week, then retire them; add read-only operator summaries for Tankonomics.
   - Gate: one week stable in production and one backup restored successfully.
5. **Phase 4 — IEW readiness (11–26 January).** Change freeze, approve launch accounts, rehearse the demo, keep a rollback ready.

After IEW: the TankBazaar data merge into Tankonomics (taxonomy checks first, as the merge document requires) and the three-module split.

The dates assume one developer working mostly full time with my help; they are a first estimate to adjust once hosting and ownership are decided.

## Risks

The biggest risk is the deadline: if Phase 2 slips, TankBazaar can stay on Firestore through IEW with Phase 0 fixes and a reduced-read loader as the fallback.

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Phase 2 overruns | New stack not live by IEW | Fallback: Phase 0 fixes plus loading terminals once per visit; cut admin editing before cutting security |
| One person runs operations | Outages or missed patches during busy weeks | Managed Postgres instead of self-run; automatic updates; uptime alerts to phone |
| Import mismatches | Wrong or lost records after migration | Count and field-by-field checks at the Phase 1 gate; `legacy_ids`; Firestore kept read-only for a week |
| Approved user copies data | Leak of the dataset | Page caps, rate limits, access logs, unusual-volume alerts; approve users carefully |
| Copies already taken | Data downloaded while files were public | Cannot be undone; Phase 0 stops further exposure; check Netlify logs if available |
| Licence terms (ODbL, GEM) | Restrictions on commercial use | Review before launch; replace OSM-derived positions if needed |
| Mapbox cost at launch | Bill grows with map loads | Watch usage; a self-hosted base map is an option later |

## Decisions and open questions

Four decisions unblock Phase 1; the open questions can be answered as the work runs.

- [ ] Approve the hybrid architecture (Tankonomics on Firebase, TankBazaar on own Postgres + API, one Firebase sign-in)
- [ ] Approve one `assets` table with `facility_type` plus extension tables (merge document Open Question 2)
- [ ] Choose hosting: provider, Mumbai region, self-run or managed Postgres
- [ ] Name who owns operations (patching, backups, incidents)
- [ ] Is the upstream register (basins, fields, rigs, pipelines) as confidential as terminals, or can parts be shown publicly as a teaser?
- [ ] Should approved users see full detail, or should some fields (capacities, operators) be limited by plan, in line with Tankonomics' paid tiers?
- [ ] Budget ceiling per month for hosting and Mapbox
- [ ] Does TWI data also need to stay sign-in only, or is it public directory content?

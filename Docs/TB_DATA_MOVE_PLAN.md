# TankBazaar data move to Firestore — plan

Oct 17, 2026 · @Shamit Rai

> Kept as the working plan behind `T3_DECISIONS.md`. Where the two disagree, `T3_DECISIONS.md` wins. The TankWorldIndia notes below are carried forward in `T3_TWI_WORKPLAN.md` in the TankWorldIndia repo (18 Oct: `companies.json` now holds about 9,450 companies).

## Goal

Move the pipeline, rig, field and basin data out of `index.html` into Firestore, readable only by the admin and approved users. This shrinks the page from about 12 MB to about 1 MB. It closes the remaining leak: anything embedded in the page can be read from its source by anyone. The Firestore `terminals` collection is already restricted to the admin and approved users.

What changes for you:

- **Privacy.** Data is no longer publicly downloadable, in line with the rule that the terminal dataset must never be public.
- **No redeploys for data.** Pipeline, rig and field corrections go out through seeders, as terminal updates do now. `index.html` changes only when the app itself changes.
- **Room to grow.** The GEM gas routes (about 4,200 lines) and future datasets fit without bloating the page.
- **Cheaper visits.** Each map load reads about 10 to 20 Firestore documents instead of about 8,000 today.

## Current state

Three quarters of the 12.1 MB page is data, and the largest block is the rig tracker, not the pipelines. Gzipped, the page is 3.0 MB.

| Embedded block | Size | Contents | Who can read it |
| --- | --- | --- | --- |
| `RIG_DATA_RAW` | 7.9 MB | 599 rigs, 5,889 oil fields (many with outline WKT), 199 basins | Anyone who opens the page |
| `const terminals` | 2.2 MB | Old demo copy of about 6,400 terminals, used only as a first-run fallback | Anyone who opens the page |
| `PIPE_DATA_RAW` | 1.5 MB | 1,401 pipelines; 0.9 MB of it is notes, 0.1 MB routes | Anyone who opens the page |
| Firestore `terminals` | — | 8,027 live terminal records | The admin and users with status `active`, per the published rules |

How terminals load today: the page lists the collection over the Firestore REST API, 300 records per request. One visit is 27 requests and about 8,027 billed document reads. Writes go through the seeders you run while signed in as admin.

## Target design

Each dataset becomes a small manifest plus a few bundle parts in Firestore; the browser reads the manifest on every visit and downloads parts only when the version has changed.

Data flow after the move: the seeder (run by the admin) writes the bundle parts and then the manifest into Firestore; the browser reads the manifest on each visit, downloads changed parts only, and keeps them in IndexedDB.

- **Datasets:** `pipelines` (1,401 lines), `rigs` (599), `fields` (5,889), `basins` (199), and later `gas-routes` (GEM). Each one is a manifest document holding the version, the part count and the source and as-of date, plus parts of about 0.8 MB.
- **Encoding:** routes and outlines become compact encoded text (polyline-style, 5 decimals, about 1 m). This also cuts the rig and field data well below its current 7.9 MB.
- **Browser cache:** parts are kept in the browser's IndexedDB under the manifest version. A repeat visit reads only the manifest.
- **Rules:** reads need the admin (esraigroup@gmail.com) or a signed-in user with status `active` in `users`, the rule `terminals` and `listings` already use; writes need the admin.
- **Seeders:** a new dataset seeder writes all parts first and the manifest last, so a visitor never sees a half-written version. Terminal seeders stay as they are.

## Phases

Five phases, each shippable on its own. Phase 1 goes ahead now. Phases 2 to 4 now follow the Tankonomics design in the section below; the datasets stay in the tankbazaar project, which remains the master copy. Phase 5 comes later. Until phase 4, the embedded data stays in the page as a fallback, so a failed load never leaves a blank map.

| Phase | What I deliver | What you do | Check before the next phase |
| --- | --- | --- | --- |
| 1. Remove the built-in terminal copy (done 17 Oct) | `index.html` without the old built-in copy of about 6,400 terminals (2.2 MB). The published rules already limit `terminals` and `listings` to the admin and `active` users, so no rules change is needed. Signed-out visitors keep the existing blurred sign-in screen, now over an empty map. | Deploy; open the site in a signed-out browser window, then sign in as admin | Signed-out: blurred screen, no terminals in the page source; admin: all 8,027 terminals load |
| 2. Data seeder | `seed-datasets-V1.html`: writes the pipeline, rig, field and basin bundles plus the manifest. Same sign-in-and-run pattern as the terminal seeders. | Run it once while signed in as admin | Firestore shows `datasets/pipelines`, `datasets/rigs`, `datasets/fields`, `datasets/basins` with their parts and versions |
| 3. App reads Firestore | `index.html` loads bundles after sign-in, checks the manifest, caches in the browser, and falls back to the embedded data if anything fails | Deploy; open Pipelines, Rigs and the Master Map signed in; reload twice | Second load reads only the manifest; counts match (1,401 pipelines, 599 rigs, 5,889 fields, 199 basins) |
| 4. Strip the page | `index.html` without the embedded data and the old 2.2 MB terminal copy; signed-out visitors see a blurred view of the globe and Map view with a sign-in prompt | Deploy | Page is about 1 MB; a signed-out visitor sees only a blurred view |
| 5. Terminal bundles (later) | Terminals also served as about 9 bundles, while the 8,027 records stay the master copy for claims and edits | Run one more seeder | A visit reads about 20 documents instead of 8,027 |

After phase 3, every data change I make reaches you as a dataset seeder instead of a new `index.html`. The GEM gas routes arrive the same way, as their own dataset, after the move is finished.

## Costs and limits

The move cuts Firestore reads per visit from about 8,027 to about 20. Costs stay in cents either way. Your database is the named database `tankbazaar`, and Google states that named databases do not get the free daily quota, so every read is billed ([pricing](https://cloud.google.com/firestore/pricing)).

| Item | Today | After phases 3 to 5 |
| --- | --- | --- |
| Reads per first visit | about 8,027 (terminals) | about 20 (manifest + bundles) |
| Reads per repeat visit | about 8,027 | 1 (manifest only; bundles come from the browser cache) |
| Cost per 1,000 first visits at $0.03 per 100,000 reads | about $2.40 | about $0.006 |
| One full reseed of all datasets (writes at $0.09 per 100,000) | — | under $0.01 |

Limits that shape the design ([quotas](https://firebase.google.com/docs/firestore/quotas)):

- **1 MiB per document.** Each dataset is split into parts of about 0.8 MB. The rig data needs about 10 parts and the pipelines 2; GEM gas routes, simplified, perhaps 6 to 10 more.
- **No lists of coordinate pairs.** Firestore cannot store `[[lon, lat], ...]`, so routes and outlines are stored as encoded text and decoded in the browser.
- **First-load size.** A first visit downloads about 9 MB of data (compressed in transit) before the rig and field layers draw. Later visits load from the browser cache in well under a second.

## Risks, rollback and decisions

The main risk is a rules mistake locking you out of your own data; phase 1 is done alone so it can be checked and reverted in minutes.

| Risk | What would happen | Guard |
| --- | --- | --- |
| Rules too strict | Maps empty for you as well | Keep the current rules text; republish it to revert. Check as admin and as a signed-out visitor before phase 2. |
| Rules too loose | Data still public | Test with a signed-out browser window after publishing. |
| Bundle fails to load | Blank pipeline or rig map | Until phase 4 the embedded data is the fallback; after it, the last cached copy is used and a banner says the data could not be refreshed. |
| Seeder half-run | Manifest points at parts that are missing | The seeder writes all parts first and the manifest last; the app only follows a manifest whose parts all exist. |
| Two copies drift (embedded vs Firestore) | Different numbers in different places | From phase 3, Firestore is the master copy; I stop editing the embedded data and remove it in phase 4. |
| Search engines and link previews | Pages show nothing to signed-out visitors | Intended: signed-out visitors get a blurred view only, so data stays private; a public landing text can stay. |

Rollback at any phase: redeploy the previous `index.html` and, for phase 1, republish the previous rules.

## Signing in with Tankonomics (proposed, 17 Oct)

Decided by you: TankBazaar data will also move into the `tankonomics` project but stays in TankBazaar. Tankonomics locations link to `tankbazaar.com/#terminal-N`, and only a pre-set Tankonomics tier may open them, signing in with Tankonomics credentials. Everyone else is blocked. The approval process is still to be discussed.

**What the repos show (Tankonomics 4a13ce9, TankWorldIndia e2711f9):**

|  | TankBazaar | Tankonomics | TankWorldIndia |
| --- | --- | --- | --- |
| Firebase project | `tankbazaar` | `tankonomics` | `tankworldindia-t5` |
| Database | named `tankbazaar` | default | default |
| Approved status | `active` | `approved` (or no status field) | `approved` (or no status field) |
| Admin | esraigroup@ | `admins` collection, esraigroup@, petrodeksystems@ | esraigroup@, petrodeksystems@ |

Each Firebase project has its own sign-in system, so a Tankonomics account means nothing to TankBazaar's database rules on its own. It needs a bridge.

**Proposed flow (token exchange):**

1. In Tankonomics, an admin-set flag on the user (for example `tbAccess`, alongside `isPro` and `isFounder`; users cannot set it themselves) decides who sees the TankBazaar link. Hiding the link is only for convenience; the real block is step 4.
2. On tankbazaar.com the user clicks **Continue with Tankonomics**, which signs in against the `tankonomics` project with their usual Google or email login. No token travels in the URL.
3. A small endpoint on the existing Tankonomics server (Cloud Run, `server.ts`) checks the Tankonomics sign-in and the user's flag, then issues a TankBazaar sign-in carrying `tk: true`. It needs a TankBazaar service-account key as a secret, and nothing else new.
4. TankBazaar's rules gain one clause: read `terminals` (and later the datasets) if admin, or an `active` user, or `request.auth.token.tk == true`. Tankonomics users are read-only.
5. Removing the flag in Tankonomics stops new sign-ins at once and ends an open session within the hour.

Why this way round: the data keeps one master copy (TankBazaar) and needs no copy in Tankonomics for the links to work. The copy into `tankonomics` can follow later as a one-way sync, from TankBazaar to Tankonomics.

**To fix in Tankonomics now:** 6 of its 1,036 TankBazaar links point at deleted duplicates (74→3406, 419→3406, 420→3414, 521→76, 551→6434, 96→685), listed in `TB_Tankonomics_Link_Check.xlsx`.

### Your decisions (17 Oct)

- **Who grants access:** the super admin, admins the super admin approves, or a completed payment.
- **Per user, not per company:** companies are only pages. A user also has to be linked to a company, either as its owner (approved by an admin, through Claim your Company) or approved by that owner.
- **Locations become TankBazaar facility claims:** a company owner owns its locations, or approves other users as owners of single locations. The same ownership makes them the approved claimant of the matching TankBazaar facility.
- **TankWorldIndia joins the same Tankonomics sign-in.**
- **The endpoint goes on Tankonomics' Cloud Run.** TankWorldIndia's hosting also moves to Cloud Run.

### Access model that follows

| Step | Where | Rule |
| --- | --- | --- |
| Grant TankBazaar access | Tankonomics `users/{uid}.tbAccess` | Written only by the super admin, an approved admin, or the payment webhook on Cloud Run. Holds the source (admin or payment), who granted it, when, and an expiry for paid access. Users cannot set it; the existing users rule already blocks the field. |
| Approve admins | Tankonomics `admins/{uid}` | Created and removed only by the super admin. Today the rule allows only the two hard-coded emails or the console. |
| Company link | `companies/{slug}.ownerUid`, or `users.isVerifiedByCompany` + `verifiedByCompanyId` | Already built. The owner is approved by an admin; staff are approved by the owner. |
| Location owner | `companies/{slug}/locations/{id}` | Effective owner = the location's own `ownerUid`, else the company owner (already the Tankonomics design). Each location gets a number field `tbTerminalId` so the endpoint need not read it out of the URL. |
| Sign-in to TankBazaar | Cloud Run endpoint | Checks the Tankonomics sign-in, `tbAccess` (not expired) and a company link. Then issues a TankBazaar sign-in as user `tk_<uid>`, marked as a Tankonomics user. |
| Facility claimant | TankBazaar `terminals/{id}` | The endpoint sets `ownerId` to `tk_<uid>` and `claimStatus` to `owned`, with `ownerSource: tankonomics`, on every facility the user effectively owns. It also clears facilities they no longer own, the same fields TankBazaar's own claim process uses. |
| Same for TankWorldIndia | Cloud Run endpoint | The same check issues a TankWorldIndia sign-in. TankWorldIndia's company pages map to Tankonomics companies by slug. |

When a user's access, company link or location ownership is removed in Tankonomics, their next sign-in is refused. Their TankBazaar claims are cleared on that check or by a nightly pass, whichever comes first.

**Still open:**

- Payment provider and price.
- Whether petrodeksystems@ is also super admin.
- What a Tankonomics owner may change on a TankBazaar facility: direct edits to metrics as TankBazaar owners do now, or proposals an admin approves.
- Who holds the Cloud Run secrets: the TankBazaar and TankWorldIndia service-account keys.

## Notes for the Tankonomics chat

For review and build in the Tankonomics conversation. Based on the repo at commit 4a13ce9 (11 Sep 2026); check anything that changed since.

**Context.** TankBazaar (`tankbazaar` project, named database `tankbazaar`) stays the master copy of facility data. Tankonomics becomes the single sign-in for TankBazaar and TankWorldIndia. Access is per user, granted by the super admin, an approved admin or a payment, and needs a company link: either the company owner (an admin-approved claim) or staff approved by that owner. A Tankonomics location's effective owner becomes the claimant of the matching TankBazaar facility.

**Changes in Tankonomics:**

1. **Access flag on the user.** `users/{uid}.tbAccess = { granted, source: 'admin' | 'payment', grantedBy, grantedAt, expiresAt | null }`. Leave it out of the owner-editable `hasOnly([...])` list in the `users` update rule, so users cannot set it. Add a toggle in Admin → Members beside Pro and Founder. Decide whether TankWorldIndia needs its own flag (`twiAccess`) or rides on approval alone.
2. **Super admin.** Add `isSuperAdmin()` (the hard-coded email or emails). Change `admins/{uid}` so only the super admin may create or delete it. Today create is allowed for the two hard-coded emails, and other writes go through the console only.
3. **Location field.** Add `tbTerminalId: number` to `SeedLocation` and to the live `companies/{slug}/locations/{id}` documents, filled from the `externalUrl` id. 1,036 locations carry a TankBazaar link.
   - Fix the 6 that point at deleted duplicates first: 74→3406, 419→3406, 420→3414, 521→76, 551→6434, 96→685 (see `TB_Tankonomics_Link_Check.xlsx`).
   - Keep `externalUrl` for display.
4. **Link visibility.** Show the TankBazaar link only to users with a valid `tbAccess`; others see a short note naming the tier that includes it. This is cosmetic: the block is enforced by TankBazaar.
5. **Location ownership.** `docs/LOCATION_CLAIMING_DRAFT.md` (delegation, `location_claims`, revoke) is a draft and not built. The bridge depends on it for per-location owners; until then, company owners own all their locations through the fallback.
6. **Bridge endpoint on Cloud Run (`server.ts`).** `POST /api/bridge/token` with body `{ app: 'tb' | 'twi' }` and header `Authorization: Bearer <Tankonomics ID token>`. It:
   - verifies the token with `firebase-admin`, checking for revocation;
   - reads the user doc, requires a non-expired `tbAccess` and a company link (owns an approved company, or `isVerifiedByCompany`), and refuses otherwise with a reason the page can show;
   - collects owned facilities: locations where `ownerUid == uid`, plus locations with `ownerUid == null` under companies the user owns, giving `tbTerminalId`s. This needs a collection-group index on `locations.ownerUid`.
   - for `tb`: uses a second admin app initialised with the TankBazaar service account and **the named database `tankbazaar`** (`getFirestore(app, 'tankbazaar')` — a wrong database id returns empty results, not an error). It writes `ownerId: 'tk_<uid>'`, `claimStatus: 'owned'`, `ownerSource: 'tankonomics'` on those terminals, clears the ones the user no longer owns, then returns `createCustomToken('tk_<uid>', { tk: true, tkUid, email })`;
   - for `twi`: the same with the TankWorldIndia service account (default database);
   - limits CORS to the TankBazaar and TankWorldIndia domains;
   - offers `POST /api/bridge/reconcile`, called nightly by Cloud Scheduler, to clear claims of users who lost access;
   - later, a payment webhook that writes `tbAccess` with `source: 'payment'` and an expiry.
7. **Secrets.** TankBazaar and TankWorldIndia service-account keys in Secret Manager, mounted into the Cloud Run service. The Tankonomics side uses the service's own identity.
8. **Auth settings.** Add the TankBazaar and TankWorldIndia domains to the Tankonomics project's Authorized domains, or the sign-in popup fails there. LinkedIn sign-in runs through `server.ts`, so the first version of the button offers Google and email only.
9. **Approval rule.** `isApprovedUser()` treats an account with no `status` field as approved (the grandfather clause). The bridge should rely on `tbAccess`, not on that clause.

**Check in review:** that the company-link test matches how Claim your Company and owner verification work today, and that the users read rule (any signed-in user can read any `users` doc) is acceptable once `tbAccess` holds payment details. Keep payment ids out of that doc.

### Building Tankonomics for 100,000 to 1,000,000 users

Conclusion: keep Firestore. It runs on Spanner underneath and scales to millions of users without tuning. What breaks first is how the app reads and writes, and Spanner or PostgreSQL would hit the same problems. Based on the repo at commit 4a13ce9.

**What won't survive scale today:**

| Where | What happens now | At 1M users |
| --- | --- | --- |
| Home feed (`Home.tsx`) | A live listener on every post, no limit | Each visit downloads the whole feed |
| New chat (`NewChatModal` in `App.tsx`) | Reads every user except yourself, then filters in the browser | One click is about 1M reads and a long wait |
| Jobs, Forums, the posts on a company page | Whole collection, no limit | Same problem as the feed |
| Global search (`App.tsx`) | 8 collections × 300 docs = 2,400 reads, filtered in the browser | Expensive, and misses anything outside those 300 |
| Admin analytics | Loads all users, companies, posts and more | Unusable |
| Likes | Every liker's uid in an array on the post | Popular posts hit the 1 MiB document limit and the roughly 1 write per second a single document sustains |
| Counters | The browser updates them; rules let any signed-in user change `likesCount` / `memberCount` | Counts can be faked |
| Notifications | Any signed-in user may create one for anyone | Spam vector |
| `users` collection | Readable in full by any signed-in user, emails included | Easy scraping of the member base |
| Rules | `isApprovedUser()` does an `exists` and a `get` on every request | Extra billed reads on every call |

**What to change in Tankonomics:**

1. **Page every list:** `limit()` plus cursors on the feed, jobs, forums, events and company posts. Use one-off fetches instead of live listeners, except for chat and notifications.
2. **Timeline per user for feeds.** When someone posts, a server job writes a small entry into each follower's timeline; the home feed reads only the newest 20 entries. For very large followings (big companies), merge their posts in at read time instead.
3. **Trusted writes on the server.**
   - Trigger functions handle likes (one document per like), comment and member counters, notifications, feed copies and moderation.
   - The Cloud Run service handles payments, the sign-in bridge and admin actions.
   - The browser never writes a count or someone else's notification.
4. **Tier and approval in the sign-in itself** (custom claims), so rules check the token instead of reading the `users` document on every request.
5. **Split the user record.** A small public profile (name, title, company, photo) stays readable by members. Email, phone and billing go in a private document only the owner and admins can read. This decision gets much harder later.
6. **A search engine** (Typesense or Algolia, fed automatically from Firestore) for people, companies, jobs and posts. It also handles job filters like location, salary and taxonomy.
7. **Admin numbers from aggregates:** `count()` queries, or nightly totals in BigQuery. Never load whole collections into the admin page.
8. **Protection:**
   - Firebase App Check, so only your own app can call the database.
   - Rate limits on Cloud Run endpoints.
   - Tighter size limits in the rules: they still allow 2 MB `photoURL` strings and 10 MB post images. Images belong in Storage, which the app has started doing (`uploadImage.ts`).
9. **Discipline at this size:**
   - A separate staging Firebase project.
   - Emulator tests for the 811-line rules file before each deploy.
   - Budget alerts in Google Cloud.
10. **Database location, decided deliberately.** It can't be changed after creation. Regional in India suits an IEW-led launch; if most users will be outside Asia, decide now while the data is small enough to move.

**Do before launch:** items 1, 3 and 5 (unbounded lists, browser-trusted writes, the public `users` document). The rest can come as the modules grow.

**Across the three apps:**

- **One sign-in, one company identity.** Tankonomics owns users and company slugs. A mapping table links each slug to the TankBazaar register Company ID and the TankWorldIndia slug; `TB_Tankonomics_Link_Check.xlsx` is the first pass.
- **TankBazaar and TankWorldIndia stay data apps on their own projects,** served as cached bundles. Tankonomics links to them, and copies only what its pages need, one way, by a scheduled job.
- **One shared search index,** with a section per app. Each search key is limited to what the user's tier may see, so search can't leak TankBazaar data to people without access.
- **One Cloud Run service** for the bridge, payments, webhooks and scheduled jobs across all three apps.
- **BigQuery** for cross-app reporting, so analysis never runs against the live databases.

**When to revisit a relational database:** if heavy joins across live data become a real need (recruiter dashboards, complex matching), add PostgreSQL alongside Firestore for that one module. It doesn't need to replace Firestore.

## Notes for the TankWorldIndia chat

For review and build in the TankWorldIndia conversation. Based on the repo at commit e2711f9 (15 Oct 2026).

**Context.** TankWorldIndia (`tankworldindia-t5`, default database) moves to the Tankonomics sign-in, and its hosting moves from Firebase Hosting to Cloud Run. The Firestore database stays where it is.

**Changes in TankWorldIndia:**

1. **Sign-in.** Replace the app's own sign-in with **Continue with Tankonomics**:
   - sign in to the `tankonomics` project in a popup;
   - call the bridge with `app: 'twi'`;
   - then `signInWithCustomToken` on TankWorldIndia's own Firebase app. The user id there becomes `tk_<Tankonomics uid>`.
2. **Admin check.** `isAdmin()` in `firestore.rules` and `ADMIN_EMAILS` in `index.html` test `request.auth.token.email`. A custom token carries no email unless the bridge adds it. Either the bridge adds `email` as a claim (as planned in the Tankonomics notes), or admins keep a direct sign-in. Test admin access first.
3. **Approval.** `users/{uid}` creation requires `status == 'pending'`, set by the user. Decide whether Tankonomics approval implies TankWorldIndia approval. If it does, the bridge writes the TankWorldIndia `users` doc as `approved` with the service account; if not, the current pending-then-approve flow stays.
4. **Existing accounts and owners.** `users` docs and `companies.ownerUid` / `companyClaims` hold today's TankWorldIndia uids. They need a one-time mapping to `tk_<uid>` by email, done before the switch, or owners lose their listings.
5. **Public roster.** `companies.json` (9,391 companies, 7.2 MB) is served from hosting and committed to the repo, so anyone can download it, whatever the database rules say.
   - The Cloud Run move is the chance to serve it only to approved, signed-in users: the server checks the ID token before sending it.
   - Alternatively, load from Firestore only.
   - Remove it from the public repo either way.
6. **Cloud Run hosting.** Carry over the security headers from `firebase.json` (X-Frame-Options, nosniff, Referrer-Policy) and the `?v=` long-cache rule. A single Cloud Run service can serve both Tankonomics and TankWorldIndia domains, or run as its own service; either works with the bridge.
7. **Company identity.** TankWorldIndia companies map to Tankonomics companies by slug (the shared key; never rename a slug after seeding). `CATEGORY_TREE` already mirrors the Tankonomics master taxonomy.

## What the TankBazaar side does (this chat)

- Add **Continue with Tankonomics** to the sign-in screen, calling the bridge with `app: 'tb'`.
- Add the rules clause: Tankonomics users (`request.auth.token.tk == true`) can read terminals and later datasets, never write. Admin stays the direct sign-in.
- Let a Tankonomics claimant edit their facilities the way TankBazaar owners can now, once you decide between direct edits and admin-approved proposals.
- Optionally, redirect deleted terminal ids to their replacements, so old links keep working.

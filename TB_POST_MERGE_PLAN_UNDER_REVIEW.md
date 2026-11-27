# TankBazaar post-merge plan (UNDER REVIEW, not approved)

Status: draft, 1 Nov 2026. Contains no data, only decisions, open questions and sequencing.
Gate: nothing below starts until the pre-merge verification and missing-field rounds are finished and the Big Merge (TB and TWI into Tankonomics) is done. Users are admin-only until then.

## 0. Pre-merge gate (must finish first)
- Company and facility verification rounds (companies not yet verified, facilities not yet verified).
- Missing-field rounds: company registry fields, website / LinkedIn / HQ, facility process type, source and date, site status.
- Unlinked facilities: research rounds until every facility has an owner link or a recorded reason.
- "To research further" companies (medium-confidence owners) confirmed or corrected.
- Open held lists from every round decided.
- Category tree decisions closed (product-derived tags, keep-in-TWI list, heavy-leaf splits).
- Tankonomics `companyRegistryMap.ts` entry for CO02553.
- Normalise free-text `siteStatus` values to the fixed set (Operating, Idle, Decommissioned, Under construction, Planned, Out of service).

## 1. Capacity
Findings (1 Nov 2026 audit, no values recorded here):
- Capacity is not one field. `cap` (all records) is the throughput figure in the standing rule (kbd; storage in m3 is kept out of it). Sourced figures sit in `storageCapacity`, the refinery `nameplate*` fields, LNG / liquefaction / gas and oil processing fields and their `refCapSource*` / `refCapStatus` fields.
- Only about 1 in 8 facilities has any sourced capacity. For the rest `cap` is unsourced.
- `cap` values repeat heavily (a few round values and zero account for about half of all records), which looks like defaults, not measurements. UNRESOLVED: what each repeated value means and whether size buckets derive from it.
Plan to review:
1. Define capacity per facility type (storage m3, refinery bpd, LNG mtpa, processing, throughput) with one unit per field, and a source and date alongside each.
2. Decide the role of `cap` (throughput, display weight, or retire). Check how map sizing and `size` buckets use it before changing anything.
3. Never show an unsourced `cap` as a capacity to users.
4. Capacity research rounds for unsourced facilities, ordered by size class and type (port terminals first). Public sources only.

## 2. Operator versus owner
- Standing rule: process plants carry the registered legal owner only; operator is kept for storage terminals where it differs from the owner. Tankonomics has no operator field yet.
- Audit finding: the facility `op` field is filled on very few records, while the company link carries an operator-style role on nearly every linked facility.
Plan to review:
1. Decide whether the facility link role stays "Operator" or becomes "Owner" / "Operator" per the rule above, then derive `op` from the link only where needed (storage terminals).
2. Define precedence when a facility has several companies (owner, operator, partner, group parent).
3. Agree the Tankonomics operator field (facility types, who edits it) before migrating.

## 3. One map and one globe
- Direction (31 Oct): one map and one globe driven by filters, instead of separate maps per tab, to cut Mapbox map loads (the billed unit).
- Deferred until after the Big Merge and a decision that it is a premium Tankonomics feature with real, regularly updated content.
Plan to review: filter model (layers, categories, status, owner), load budget, signed-out behaviour (blurred), tier gating, performance targets measured by the user in a real browser.

## 4. Analytics pages: Benchmark, Market, Flow
- Audit before rebuild: what each page shows, where each number comes from, how often it can be refreshed, who it is for.
- Rebuilds need decisions on data feeds (EIA key, JODI use or not) and on refresh cadence and ownership. Not started.
- Only keep a page if the content is genuine and regularly updated; otherwise merge into the filter-driven map or drop.
- Capacity (section 1) is a prerequisite for any benchmark.

## 5. Data model and taxonomy (from earlier decisions)
- Companies and facilities: a company owns any mix of facility classes; facilities are locations. Stable Tankonomics location ids of the form tb-<TB id>. Company slugs must match existing Tankonomics slugs.
- Category trees: the T3 tree workbook and audit are the basis; decisions still open (section 0).
- Value-chain tags (Upstream / Midstream / Downstream) on facilities and companies, company tag derived from its facilities; storage rule per the 27 Oct decision. Schema change waits for the merged taxonomy.
- Scope: metal production sites are out of TB; owner companies of TB vessels and facilities belong in TB, not TWI.

## 6. Access and delivery
- Terminal dataset is never publicly downloadable. Reads for approved users only; signed-out visitors see a blurred view.
- Tankonomics tier: granted per user by super admin / approved admins or by payment; user linked to a company; company owners own or approve their locations. Approval flow still to be finalised.
- Move pipeline, rig, field and basin data from the page into Firestore after the Tankonomics Firestore structure is agreed; terminal bundles later; GEM gas routes after the move.
- Hardened Firestore rules (block self-approval) prepared but not applied; decide before opening to non-admin users.
- Hosting: TB on Netlify, TWI on Firebase Hosting, Tankonomics on Cloud Run; consider moving TB and TWI to Cloud Run.

## 7. Operations
- Vessel positions use a free-tier key that expires every 90 days; rotate it in the Netlify environment (last set 31 Oct 2026, next due about 29 Jan 2027).
- Known UI issues listed in the register notes are unresolved and still need checking in a real browser.

## 8. Suggested order after the gate
1. Merge and slug / id reconciliation. 2. Operator and capacity model decisions. 3. Firestore data move and rules. 4. Analytics audit. 5. One-map / globe build behind the premium tier. 6. User onboarding beyond admins.

## Open questions for the owner
- What is `cap` meant to be, and may the unsourced values be cleared?
- Link role: "Operator" or "Owner" going forward?
- Are Benchmark / Market / Flow kept, merged or dropped?
- JODI and EIA: use or not?
- Which Tankonomics tier gets TB access, and how is it approved?

# TankBazaar: registration details kept private (V442, 27 Oct 2026)

Rule: registered legal names, LEIs, registry IDs, legal forms, registered addresses and register sources are for internal verification only. They never go into index.html, any bundle, or any document an approved non-admin user can read.

## Where things live
- Public (approved users): `companies/CO#####` and `bundles/*` hold the display name, slug, country, HQ city, website, LinkedIn, segments, facilities, parent and `verified` (true when there is a legal name plus an LEI or registry ID). Terminal records carry `verified` instead of legalName/lei/registryId. Pipelines in index.html carry `ci` (company IDs) and `v` instead of ln/li/ri.
- Admin only: Firestore `registryPrivate/manifest` + `registryPrivate/part-N` (rule: read/write isAdmin only). It holds companies (by CO id), terminals (by id) and pipelines. The app shows it only through the "Registration details (admin only)" button on a company page and in a terminal fact sheet.
- Local only: `TB_Registry_PRIVATE_<date>.json`, the register workbooks and every `seed-*.html` (seeders embed the data). None of these belong in the repo or the Netlify build.

## Build steps (scratchpad `priv/`)
`split.py` (public/private split, display names, ID scrub of notes) → `patch_index.py` (pipelines + UI) → `make_seeder.py` (companies seeder) → `v442/build442.py` (terminal seeder) → `scan.py` on every public file (must report 0 hits).

## Counts at V442
2,537 companies: 1,976 verified, 561 not yet. 8,020 terminals: 5,908 verified. 582 pipelines linked to companies.

## Tankonomics
`src/lib/companyRegistryMap.ts` now holds only tbCompanyId, country, verified, match and note. Its legal names, LEIs and registry IDs were removed.

# TankBazaar: registration details kept private (V442, 27 Oct 2026; updated V566, 17 Nov 2026)

Rule: registered legal names, LEIs, registry IDs, PAN, GSTIN, Udyam numbers, legal forms and register sources are for internal verification only. They never go into index.html, any bundle, the public merge export, or any document an approved non-admin user can read. MSME category, sectors served, email and phone are admin-only too.

**Registered-office address is not a registration detail (decided 17 Nov 2026).** It is a public location like any other office. TankBazaar shows city and country only for now (the registered-office city is already on the public company document as `locations[].city` and fills `hqCity` when no head-office city is recorded); street address and state are left blank so company owners can add them later. The full registered address still sits in `registryPrivate` until it is moved to a public location record.

## Where things live
- Public (approved users): `companies/CO#####` and `bundles/*` hold the display name, slug, `countryCode` (ISO-2), `country` (English name), HQ city, website, LinkedIn, segments, facilities, parent (`parent` id plus `parentSlug` and `parentRelationship`), `registryVerified` (true when there is a legal name plus an LEI or registry ID), `aliases`, `formerNames`, `brands`, `description`, `categoryIds`, `companyTypes` and `sources`. Terminal records carry `verified` instead of legalName/lei/registryId. Pipelines in index.html carry `ci` (company IDs) and `v` instead of ln/li/ri. Until V566 the company fields were named `hqCountry`, `verified` and `aka`; the V566 seeder renames them and removes the old names.
- Admin only: Firestore `registryPrivate/manifest` + `registryPrivate/part-N` (rule: read/write isAdmin only). It holds companies (by CO id), `companiesBySlug` (the same companies keyed by slug with the T3 section 3 field names: legalName, legalNameSource, registrationId, registryIds, lei, legalForm, jurisdiction, registryStatus, notes), terminals (by id) and pipelines. The app shows it only through the "Registration details (admin only)" button on a company page and in a terminal fact sheet.
- Local only: `TB_Registry_PRIVATE_<date>.json`, `TankBazaar_Merge_Private_<date>.json` (the T3 merge export), the register workbooks and every `seed-*.html` (seeders embed the data). None of these belong in the repo or the Netlify build; `.gitignore` excludes them.

## Build steps
Seeders: build the terminal and companies seeders, then `t3_seed` adds the T3 common fields to the companies payload (scripts/t3_common_fields.py holds the shared logic).
Merge export: `python3 scripts/t3_merge_export.py seed-terminals-VNNN.html seed-companies-bundles-VNNN.html [out_dir]` writes the public and private merge files and runs the T3 section 7 checks (no registration or contact field in the public file; clean descriptions).

## Counts at V566
4,001 companies: 2,657 registry-verified (exported to the merge), 1,344 not yet. 8,058 terminals.

## Tankonomics
`src/lib/companyRegistryMap.ts` holds only tbCompanyId, country, verified, match and note. Its legal names, LEIs and registry IDs were removed. Registration details reach Tankonomics only through the local private merge file, into the admin-only `companyPrivate/{slug}`.

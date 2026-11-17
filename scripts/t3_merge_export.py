"""T3 Big Merge export for TankBazaar (T3 Common Company Schema, section 7).

Writes two files from the latest local seeders:
  TankBazaar_Merge_Public_<date>.json   companies (section 2) with locations (section 4, no admin-only fields)
  TankBazaar_Merge_Private_<date>.json  keyed by slug: section 3 fields + admin-only location fields

The private file holds registration details. It is LOCAL ONLY: never commit it, never put it in a
bundle, never deploy it to Netlify (the .gitignore excludes *_Merge_Private_*.json).

Usage:
  python3 scripts/t3_merge_export.py seed-terminals-V566.html seed-companies-bundles-V566.html [out_dir]

Inputs are the two local seeder pages (they embed ALL_TERMINALS, COMPANIES, REGISTRY_PRIVATE
and RETIRED_IDS). Only registry-verified companies are exported. The checks of section 7 run at
the end; the report is printed and saved as TankBazaar_Merge_Checks_<date>.json next to the files.
Exit code 0 when every exported record passes, 1 otherwise (the files are still written so the
failures can be inspected).
"""
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t3_common_fields as F  # noqa: E402

FACILITY_URL = 'https://tankbazaar.com/#/facility/{}'
REG_KEYS = ('legalName', 'legalNameSource', 'registrationId', 'registryIds', 'lei', 'legalForm',
            'jurisdiction', 'registryStatus', 'udyamNumber', 'notes')
CONTACT_KEYS = ('email', 'phone', 'phoneDialCode', 'msmeCategory', 'sectors')
PUBLIC_FORBIDDEN = set(REG_KEYS) | set(CONTACT_KEYS) | {'privateNote', 'identifiers', 'gleifRecord', 'sourceUrl', 'sourceDate', 'registrationId'}


def _const(html, name):
    m = re.search(r'const ' + name + r'\s*=\s*', html)
    if not m:
        raise SystemExit(f'{name} not found in the seeder page')
    val, _ = json.JSONDecoder().raw_decode(html[m.end():])
    return val


def load(term_html, co_html):
    th = open(term_html, encoding='utf-8').read()
    ch = open(co_html, encoding='utf-8').read()
    terms = _const(th, 'ALL_TERMINALS')
    comps = _const(ch, 'COMPANIES')
    rp = _const(ch, 'REGISTRY_PRIVATE')
    if isinstance(rp, str):
        rp = json.loads(rp)
    try:
        retired = set(_const(ch, 'RETIRED_IDS'))
    except SystemExit:
        retired = set()
    return terms, comps, rp, retired


def build(terms, comps, rp, retired, now):
    T = {int(t['id']): t for t in terms}
    comps = [c for c in comps if c['id'] not in retired]
    byid = {c['id']: c for c in comps}
    kids = {}
    for c in comps:
        pid = (c.get('parent') or {}).get('id')
        if pid in byid:
            kids.setdefault(pid, []).append(c['id'])
    regc = rp.get('companies', {})

    def descendants_facilities(cid, seen):
        out = []
        for k in kids.get(cid, []):
            if k in seen:
                continue
            seen.add(k)
            out += [(f.get('role'), T[f['id']]) for f in byid[k].get('facilities', []) if f['id'] in T]
            out += descendants_facilities(k, seen)
        return out

    public, private, skipped_roles = [], {}, 0
    for c in comps:
        verified = c.get('registryVerified', c.get('verified'))
        if not verified:
            continue
        slug = c['slug']
        cc = c.get('countryCode') or F.country_code(c.get('hqCountry') or c.get('country'))
        reg = regc.get(c['id'], {})
        hq = c.get('hqCity') or next((l.get('city') for l in c.get('locations', []) if l.get('city')), '') or reg.get('city', '')
        if hq and hq.isupper():
            hq = hq.title()
        facs = [(f.get('role'), T[f['id']]) for f in c.get('facilities', []) if f['id'] in T]
        scope = facs or descendants_facilities(c['id'], {c['id']})
        cats = []
        for _, t in scope:
            for k in F.facility_categories(t):
                if k not in cats:
                    cats.append(k)
        parent = c.get('parent') or {}
        pslug = byid[parent['id']]['slug'] if parent.get('id') in byid else ''
        desc = c.get('description') or F.describe(c['name'], facs, [byid[k]['name'] for k in kids.get(c['id'], [])], cc)
        locs, plocs = [], {}
        for role, t in facs:
            r = F.location_role(role)
            if not r:
                skipped_roles += 1
                continue
            tcc = F.country_code(t.get('country'))
            lid = f"tb-{t['id']}"
            locs.append({
                'id': lid, 'tbTerminalId': int(t['id']), 'role': r,
                'type': F.TYPE_MAP.get(t.get('type'), 'inland-terminal'), 'name': t.get('name', ''),
                'address': '', 'city': t.get('city', ''), 'state': '',
                'countryCode': tcc, 'country': F.country_name(tcc),
                'lat': t.get('lat'), 'lng': t.get('lng'), 'googlePlaceId': t.get('placeId', '') or '',
                'facilityClass': t.get('facilityClass') or [], 'processType': t.get('processType') or [],
                'primaryClass': t.get('primaryClass') or ((t.get('facilityClass') or ['storage'])[0]),
                'externalUrl': FACILITY_URL.format(t['id']),
            })
            if t.get('infoSrc') or t.get('infoDate'):
                plocs[lid] = {'sourceUrl': t.get('infoSrc', ''), 'sourceDate': t.get('infoDate', '')}
        rel = c.get('parentRelationship') or ('joint-venture' if c.get('kind') == 'joint venture' else 'subsidiary')
        public.append({
            'slug': slug, 'name': c['name'], 'tbCompanyId': c['id'], 'sources': ['TankBazaar'],
            'countryCode': cc, 'country': F.country_name(cc), 'hqCity': hq,
            'aliases': list(c.get('aliases', c.get('aka', [])) or []), 'formerNames': list(c.get('formerNames', []) or []),
            'brands': list(c.get('brands', []) or []), 'description': desc,
            'website': c.get('website', '') or '', 'linkedin': c.get('linkedin', '') or '', 'logo': '',
            'categoryIds': cats, 'companyTypes': c.get('companyTypes') or (['oper'] if scope else ['nonsup']),
            'stockist': False, 'registryVerified': True,
            'parentSlug': pslug, 'parentRelationship': rel if pslug else '',
            'createdAt': now, 'updatedAt': now, 'locations': locs,
        })
        regids = reg.get('registryIds') or []
        private[slug] = {
            'tbCompanyId': c['id'], 'email': '', 'phoneDialCode': '', 'phone': '',
            'legalName': reg.get('legalName', ''), 'legalNameSource': reg.get('source', ''),
            'registrationId': regids[0] if regids else '', 'registryIds': regids, 'lei': reg.get('lei', ''),
            'legalForm': reg.get('legalForm', ''), 'jurisdiction': reg.get('jurisdiction', ''),
            'registryStatus': reg.get('status', ''), 'udyamNumber': '', 'sectors': [], 'msmeCategory': '',
            'notes': reg.get('privateNote', ''), 'locations': plocs,
        }
    return public, private, skipped_roles


def check(public, private):
    """Section 7 checks. Returns (report dict, failing slugs per check)."""
    fails = {k: [] for k in ('slug', 'name', 'countryCode', 'country', 'hqCity', 'description', 'category', 'companyType',
                             'registryVerified', 'slugFormat', 'slugUnique', 'noRegistrationFields', 'descriptionClean',
                             'locationId', 'locationType', 'locationCity', 'locationCountry', 'locationLatLng')}
    seen = set()
    loc_total = 0
    for c in public:
        s = c.get('slug', '')
        for k in ('slug', 'name', 'countryCode', 'country', 'hqCity', 'description'):
            if not c.get(k):
                fails[k].append(s)
        if not c.get('categoryIds'):
            fails['category'].append(s)
        if not c.get('companyTypes'):
            fails['companyType'].append(s)
        if c.get('registryVerified') is not True:
            fails['registryVerified'].append(s)
        if not F.SLUG_RE.match(s):
            fails['slugFormat'].append(s)
        if s in seen:
            fails['slugUnique'].append(s)
        seen.add(s)
        if PUBLIC_FORBIDDEN & set(c.keys()):
            fails['noRegistrationFields'].append(s)
        if F.NOTE_RE.search(c.get('description', '')):
            fails['descriptionClean'].append(s)
        for l in c.get('locations', []):
            loc_total += 1
            if PUBLIC_FORBIDDEN & set(l.keys()):
                fails['noRegistrationFields'].append(s + '/' + l.get('id', '?'))
            if not re.match(r'^tb-\d+$', l.get('id', '')):
                fails['locationId'].append(s + '/' + str(l.get('id')))
            if l.get('type') not in F.TYPE_MAP.values():
                fails['locationType'].append(l.get('id'))
            if not l.get('city'):
                fails['locationCity'].append(l.get('id'))
            if not l.get('countryCode'):
                fails['locationCountry'].append(l.get('id'))
            if not isinstance(l.get('lat'), (int, float)) or not isinstance(l.get('lng'), (int, float)):
                fails['locationLatLng'].append(l.get('id'))
    bad_companies = {x.split('/')[0] for k, v in fails.items() if not k.startswith('location') for x in v}
    bad_companies |= {c['slug'] for c in public for l in c['locations']
                      if any(l.get('id') in fails[k] for k in ('locationType', 'locationCity', 'locationCountry', 'locationLatLng'))}
    report = {
        'companies': len(public), 'locations': loc_total, 'privateRecords': len(private),
        'companiesPassingAllChecks': len(public) - len(bad_companies), 'companiesFailing': len(bad_companies),
        'failCounts': {k: len(v) for k, v in fails.items()},
    }
    return report, fails


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    out = sys.argv[3] if len(sys.argv) > 3 else '.'
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    day = now[:10]
    terms, comps, rp, retired = load(sys.argv[1], sys.argv[2])
    public, private, skipped = build(terms, comps, rp, retired, now)
    report, fails = check(public, private)
    report['locationLinksSkipped (not owner/operator roles)'] = skipped
    report['exportedAt'] = now
    pub = os.path.join(out, f'TankBazaar_Merge_Public_{day}.json')
    prv = os.path.join(out, f'TankBazaar_Merge_Private_{day}.json')
    chk = os.path.join(out, f'TankBazaar_Merge_Checks_{day}.json')
    json.dump({'app': 'TankBazaar', 'schema': 'T3 Common Company Schema 17 Nov 2026', 'exportedAt': now, 'companies': public},
              open(pub, 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump({'app': 'TankBazaar', 'exportedAt': now, 'bySlug': private}, open(prv, 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump({'report': report, 'failingRecords': {k: v[:500] for k, v in fails.items() if v}}, open(chk, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps(report, indent=1))
    print('Wrote', pub, prv, chk, sep='\n  ')
    sys.exit(0 if report['companiesFailing'] == 0 else 1)


if __name__ == '__main__':
    main()

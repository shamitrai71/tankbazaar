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

# Facility links use #terminal-<id>, the form Tankonomics reads (decided 27 Nov 2026).
FACILITY_URL = 'https://tankbazaar.com/#terminal-{}'
PIPE_URL = 'https://tankbazaar.com/#/pipeline/{}'
PIPE_KEYS = {}  # pipeline id -> app URL key (same rule as tbUniqueKeys in index.html)


def pipe_keys(pipes):
    seen, out = {}, {}
    for p in sorted(pipes, key=lambda x: x['id']):
        base = re.sub(r'^-+|-+$', '', re.sub(r'[^a-z0-9]+', '-', str(p.get('n') or '').lower())) or 'item'
        seen[base] = seen.get(base, 0) + 1
        out[p['id']] = base if seen[base] == 1 else f'{base}-{seen[base]}'
    return out
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
    try:
        pipes = _const(ch, 'PIPELINES')
    except SystemExit:
        pipes = []
    return terms, comps, rp, retired, pipes


def build(terms, comps, rp, retired, now, pipes=()):
    T = {int(t['id']): t for t in terms}
    comps = [c for c in comps if c['id'] not in retired]
    byid = {c['id']: c for c in comps}
    kids = {}
    for c in comps:
        pid = (c.get('parent') or {}).get('id')
        if pid in byid:
            kids.setdefault(pid, []).append(c['id'])
    regc = rp.get('companies', {})
    # Pipelines (22 Nov 2026): a pipeline's "ci" lists the TB companies that own or operate it;
    # "cr" (optional) gives each company's role. Each linked pipeline is exported as a location.
    pipes_by_co = {}
    for i, p in enumerate(pipes):
        for cid in p.get('ci') or []:
            pipes_by_co.setdefault(cid, []).append(p)

    def descendants_pipes(cid, seen):
        out = []
        for k in kids.get(cid, []):
            if k in seen:
                continue
            seen.add(k)
            out += pipes_by_co.get(k, [])
            out += descendants_pipes(k, seen)
        return out

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
        own_pipes = pipes_by_co.get(c['id'], [])
        if own_pipes or descendants_pipes(c['id'], {c['id']}):
            cats.append(F.PIPELINE_CATEGORY)
        parent = c.get('parent') or {}
        pslug = byid[parent['id']]['slug'] if parent.get('id') in byid else ''
        desc = c.get('description') or F.add_pipelines(F.describe(c['name'], facs, [byid[k]['name'] for k in kids.get(c['id'], [])], cc), facs, own_pipes)
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
                'type': F.location_type(t), 'name': t.get('name', ''),
                'address': '', 'city': t.get('city', ''), 'state': '',
                'countryCode': tcc, 'country': F.country_name(tcc),
                'lat': t.get('lat'), 'lng': t.get('lng'), 'googlePlaceId': t.get('placeId', '') or '',
                'facilityClass': t.get('facilityClass') or [], 'processType': t.get('processType') or [],
                'primaryClass': t.get('primaryClass') or ((t.get('facilityClass') or ['storage'])[0]),
                'externalUrl': FACILITY_URL.format(t['id']),
            })
            if t.get('infoSrc') or t.get('infoDate'):
                plocs[lid] = {'sourceUrl': t.get('infoSrc', ''), 'sourceDate': t.get('infoDate', '')}
        for p in own_pipes:
            w = p.get('w') or []
            if not w:
                continue
            r = F.location_role((p.get('cr') or {}).get(c['id'], 'Operator')) or 'operator'
            pcc = p.get('cc') or ''
            locs.append({
                'id': 'tb-' + p['id'], 'tbPipelineId': p['id'], 'role': r, 'type': 'pipeline', 'name': p.get('n', ''),
                'address': '', 'city': '', 'state': '', 'countryCode': pcc, 'country': F.country_name(pcc),
                'lat': w[0][1], 'lng': w[0][0], 'endLat': w[-1][1], 'endLng': w[-1][0],
                'route': [[pt[1], pt[0]] for pt in w], 'routeApproximate': bool(p.get('ra')),
                'countries': sorted({x for x in (p.get('cc'), p.get('cc2')) if x}),
                'pipelineCategory': p.get('cat', ''), 'status': p.get('st', ''), 'lengthKm': p.get('km'),
                'capacityMtpa': p.get('mt'), 'origin': p.get('o', ''), 'destination': p.get('d', ''),
                'googlePlaceId': '', 'facilityClass': [], 'processType': [], 'primaryClass': 'pipeline',
                'externalUrl': PIPE_URL.format(PIPE_KEYS.get(p['id'], '')),
            })
        rel = c.get('parentRelationship') or ('joint-venture' if c.get('kind') == 'joint venture' else 'subsidiary')
        public.append({
            'slug': slug, 'name': c['name'], 'tbCompanyId': c['id'], 'sources': ['TankBazaar'],
            'countryCode': cc, 'country': F.country_name(cc), 'hqCity': hq,
            'aliases': list(c.get('aliases', c.get('aka', [])) or []), 'formerNames': list(c.get('formerNames', []) or []),
            'brands': list(c.get('brands', []) or []), 'description': desc,
            'website': c.get('website', '') or '', 'linkedin': c.get('linkedin', '') or '', 'logo': '',
            'categoryIds': cats, 'companyTypes': (['oper'] if (scope or own_pipes) else (c.get('companyTypes') or ['nonsup'])),
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
    fails = {k: [] for k in ('slug', 'name', 'countryCode', 'country', 'hqCity', 'description', 'companyType',
                             'registryVerified', 'slugFormat', 'slugUnique', 'noRegistrationFields', 'descriptionClean',
                             'locationId', 'locationType', 'locationCity', 'locationCountry', 'locationLatLng')}
    seen = set()
    no_category = []
    loc_total = 0
    for c in public:
        s = c.get('slug', '')
        for k in ('slug', 'name', 'countryCode', 'country', 'hqCity', 'description'):
            if not c.get(k):
                fails[k].append(s)
        if not c.get('categoryIds'):
            no_category.append(s)  # allowed (decided 19 Nov 2026): no facilities yet
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
            if not re.match(r'^tb-(\d+|PL\d{5})$', l.get('id', '')):
                fails['locationId'].append(s + '/' + str(l.get('id')))
            if l.get('type') not in F.LOCATION_TYPES:
                fails['locationType'].append(l.get('id'))
            if not l.get('city') and l.get('type') != 'pipeline':
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
        'noCategory (allowed, no facilities)': len(no_category),
        'pipelineLocations': sum(1 for c in public for l in c['locations'] if l.get('type') == 'pipeline'),
    }
    return report, fails


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    out = sys.argv[3] if len(sys.argv) > 3 else '.'
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    day = now[:10]
    terms, comps, rp, retired, pipes = load(sys.argv[1], sys.argv[2])
    PIPE_KEYS.update(pipe_keys(pipes))
    public, private, skipped = build(terms, comps, rp, retired, now, pipes)
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

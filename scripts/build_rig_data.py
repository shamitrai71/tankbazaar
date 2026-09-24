"""Rebuild RIG_DATA_RAW payload (rigs, basins, fields) from a register workbook.
Usage: python3 build_rig_data.py <register.xlsx> <out.json>"""
import sys, json, openpyxl
def num(x):
    try: return float(str(x).replace(',','').strip())
    except: return None
def status_cat(s):
    t=(s or '').lower()
    if not t.strip(): return 'unknown'
    if any(k in t for k in ['decommission','abandon','scrapped','sank','destroyed']): return 'decommissioned'
    if any(k in t for k in ['pre-production','undeveloped','discovery']): return 'pre-production'
    if any(k in t for k in ['construction','development','targeting first','startup']): return 'development'
    if any(k in t for k in ['suspend','shut','idle','halt','mothball']): return 'idle'
    if any(k in t for k in ['operational','producing','active']): return 'operational'
    return 'other'
def type_cat(s):
    t=(s or '').lower()
    if 'land' in t or 'onshore' in t: return 'land'
    if any(k in t for k in ['fpso','floating','semi','drillship']): return 'floating'
    if any(k in t for k in ['fixed','platform','jacket']): return 'fixed'
    if 'n/a' in t or not t.strip(): return 'undeveloped'
    return 'other'

src_xlsx, out_json = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src_xlsx, data_only=True)
fws = wb['Rig Tracker Field & Complex']; FH = {fws.cell(row=1,column=c).value: c for c in range(1, fws.max_column+1)}
LATC, LONC = 'Latitude (matched field position)', 'Longitude (matched field position)'
field_coord = {}
for r in range(2, fws.max_row+1):
    fk = fws.cell(row=r,column=FH['Field Key']).value
    if not fk or LATC not in FH: continue
    la, lo = num(fws.cell(row=r,column=FH[LATC]).value), num(fws.cell(row=r,column=FH[LONC]).value)
    if la is not None and lo is not None:
        field_coord[str(fk)] = (la, lo, str(fws.cell(row=r,column=FH['Field / Complex Name']).value or ''))

rws = wb['Rig & Platform Tracker']; RH = {rws.cell(row=1,column=c).value: c for c in range(1, rws.max_column+1)}
rigs = []
for r in range(2, rws.max_row+1):
    rk = rws.cell(row=r,column=RH['Rig Key']).value
    if not rk: continue
    g = lambda k: rws.cell(row=r,column=RH[k]).value if k in RH else None
    la, lo = num(g('Latitude')), num(g('Longitude')); src = 'direct'
    if la is None or lo is None or not(-90<=la<=90) or not(-180<=lo<=180):
        pla, plo = num(g('Latitude (matched OGIM offshore platform)')), num(g('Longitude (matched OGIM offshore platform)'))
        if pla is not None and plo is not None: la, lo, src = pla, plo, 'matched OGIM offshore platform'
        else:
            inh = field_coord.get(str(g('Field Key (FK)') or ''))
            if not inh: continue
            la, lo, fname = inh; src = f'inherited from matched field "{fname}"'
    rigs.append({'k':str(rk),'n':str(g('Rig / Platform / Well Name') or ''),'fld':str(g('Field / Complex Name') or ''),
        'lat':la,'lng':lo,'ty':str(g('Rig Type') or ''),'tc':type_cat(str(g('Rig Type') or '')),
        'st':str(g('Status') or ''),'sc':status_cat(str(g('Status') or '')),'sub':str(g('Sub-Type') or ''),
        'bld':str(g('Builder / Shipyard') or '')[:140],'wd':g('Water Depth Rating (m)'),'slots':g('Well Slots'),
        'oil':str(g('Oil Production Capacity (bpd)') or ''),'gas':str(g('Gas Production Capacity') or ''),
        'sto':str(g('Storage Capacity') or ''),'src':src,'c':'','basin':'','op':'','water':'',
        'srcnote':str(g('Data Source') or '')[:180]})

bws = wb['Basin Register']; BH = {bws.cell(row=1,column=c).value: c for c in range(1, bws.max_column+1)}
HULL = 'Basin footprint - DERIVED (convex hull of real field points, NOT surveyed)'
BBOX = 'Basin footprint - APPROXIMATE (user-supplied bounding box, NOT surveyed or derived)'
basins, ns, nh, nb, total = [], 0, 0, 0, 0
for r in range(2, bws.max_row+1):
    if not bws.cell(row=r,column=BH['Basin ID']).value: continue
    total += 1
    cell = lambda k: bws.cell(row=r,column=BH[k]).value
    la, lo = num(cell('Latitude')), num(cell('Longitude'))
    wkt, hull, bbox = cell('Basin outline (WKT) - surveyed'), cell(HULL), cell(BBOX)
    rec = {'n':str(cell('Basin / Province') or ''),'c':str(cell('Country / Area') or ''),
           'rigs':num(cell('Rig Tracker Field Count')) or 0,'wkt':wkt,'hullWkt':hull,
           'hullPts':cell('Derived hull - field point count'),'bboxWkt':bbox}
    if wkt: ns += 1
    elif hull: nh += 1
    elif bbox: nb += 1
    if la is not None and lo is not None: rec['lat'], rec['lng'] = la, lo
    if (la is not None and lo is not None) or wkt or hull or bbox: basins.append(rec)

ows = wb['Oil Fields by Basin']; OH = {ows.cell(row=1,column=c).value: c for c in range(1, ows.max_column+1)}
FMAP = [('id','Unit ID'),('n','Unit Name'),('basin','Register Basin'),('c','Country/Area'),('sub','Subnational unit'),
        ('fuel','Fuel type'),('ptype','Production Type'),('st','Status'),('stdet','Status detail'),('disc','Discovery year'),
        ('prodstart','Production start year'),('op','Operator'),('owner','Owner(s)'),('oo','Onshore/Offshore'),('block','Block(s)'),
        ('oilprod','Latest Oil Production Converted'),('oilunit','Latest Oil Production Converted Units'),
        ('oilyr','Latest Oil Production Year'),('reserves','Latest Oil Reserve Records')]
fields = []
for r in range(2, ows.max_row+1):
    if not ows.cell(row=r,column=OH['Unit ID']).value: continue
    la, lo = num(ows.cell(row=r,column=OH['Latitude']).value), num(ows.cell(row=r,column=OH['Longitude']).value)
    if la is None or lo is None: continue
    f = {}
    for key, col in FMAP:
        v = ows.cell(row=r,column=OH[col]).value if col in OH else None
        f[key] = v if key in ('disc','prodstart','oilprod','oilyr','reserves') else ('' if v is None else str(v))
    f['oilprod'] = num(f['oilprod']) if f['oilprod'] is not None else None
    f['lat'], f['lng'], f['wkt'] = la, lo, ows.cell(row=r,column=OH['Field outline (WKT)']).value
    fields.append(f)
json.dump({'rigs':rigs,'basins':basins,'fields':fields,'totalRigs':539}, open(out_json,'w'), separators=(',',':'), ensure_ascii=False)
print(f"Basins total {total} | surveyed {ns} | hull {nh} | bbox {nb} | resolved {ns+nh+nb} | rigs {len(rigs)} | fields {len(fields)}")

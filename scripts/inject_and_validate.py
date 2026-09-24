"""Inject a RIG_DATA_RAW json into index.html and run full validation.
Usage: python3 inject_and_validate.py <data.json> <in.html> <out.html>"""
import sys, json, io, re, subprocess
data_json, in_html, out_html = sys.argv[1], sys.argv[2], sys.argv[3]
new_json = json.dumps(json.load(open(data_json)), separators=(',',':'), ensure_ascii=False)
ANCHOR = '"totalRigs":539}'
assert new_json.endswith(ANCHOR), "payload must end with totalRigs anchor"
html = io.open(in_html, encoding='utf-8').read()
start = html.index('const RIG_DATA_RAW = ')
end = html.index(ANCHOR, start) + len(ANCHOR)
s = html[:start] + 'const RIG_DATA_RAW = ' + new_json + html[end:]
io.open(out_html, 'w', encoding='utf-8').write(s)
checks = {
  'script tags balanced': len(re.findall(r'<script\b', s)) == len(re.findall(r'</script\s*>', s)),
  'div tags balanced': len(re.findall(r'<div[\s>]', s)) == s.count('</div>'),
  'RIG_DATA_RAW exactly once': s.count('const RIG_DATA_RAW = ') == 1,
  'PIPE_DATA_RAW exactly once': s.count('const PIPE_DATA_RAW = ') == 1,
}
tags = list(re.finditer(r'<script\b[^>]*>|</script\s*>', s)); i = 0; n = 0
while i < len(tags):
    if not tags[i].group().startswith('</'):
        b = s[tags[i].end():tags[i+1].start()]; i += 2
        if not b.strip(): continue
        open(f'/tmp/blk_{n}.js','w',encoding='utf-8').write(b)
        r = subprocess.run(['node','--check',f'/tmp/blk_{n}.js'],capture_output=True,text=True)
        checks[f'script block {n} syntax'] = (r.returncode == 0); n += 1
    else: i += 1
emb = json.loads(s[start+len('const RIG_DATA_RAW = '): s.index(ANCHOR, start)+len(ANCHOR)])
from shapely import wkt as _W
def _bad(x):
    if not x: return False
    try: _W.loads(x); return False
    except Exception: return True
for grp, key in [('basins','wkt'),('basins','hullWkt'),('basins','bboxWkt'),('fields','wkt')]:
    broken = [e.get('n') for e in emb[grp] if _bad(e.get(key))]
    checks[f'all {grp}.{key} geometries parse ({sum(1 for e in emb[grp] if e.get(key))} present)'] = not broken
    if broken: print(f"   unparseable {grp}.{key}: {broken[:8]}")
for k,v in checks.items(): print(('PASS ' if v else 'FAIL ') + k)
print(f"Embedded: {len(emb['rigs'])} rigs, {len(emb['basins'])} basins, {len(emb['fields'])} fields | size {len(s):,}")
print("ALL CHECKS PASSED" if all(checks.values()) else "VALIDATION FAILED - DO NOT SHIP")
sys.exit(0 if all(checks.values()) else 1)

"""Fit a geometry into an Excel cell (hard limit 32,767 chars) with a safety margin, measuring the cost."""
import pyproj
from shapely import wkt as W, force_2d, make_valid
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import transform
LIMIT = 30000
def area_km2(g):
    c = g.centroid
    p = pyproj.Transformer.from_crs('EPSG:4326', f'+proj=aea +lat_1={c.y-10} +lat_2={c.y+10} +lat_0={c.y} +lon_0={c.x}', always_xy=True).transform
    return transform(p, g).area / 1e6
def as_multi(g):
    g = force_2d(g)
    if not g.is_valid: g = make_valid(g)
    if g.geom_type == 'GeometryCollection':
        g = MultiPolygon([p for x in g.geoms for p in (x.geoms if x.geom_type=='MultiPolygon' else [x]) if p.geom_type=='Polygon'])
    return MultiPolygon([g]) if g.geom_type == 'Polygon' else g
def fit(g):
    """Returns (wkt, tolerance_deg, area_change_pct, full_area_km2). Never returns a string over LIMIT."""
    g = as_multi(g); full = area_km2(g)
    for tol in [0, 0.0005, 0.001, 0.002, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.1]:
        s = g if tol == 0 else as_multi(g.simplify(tol, preserve_topology=True))
        w = W.dumps(s, rounding_precision=5)
        if len(w) <= LIMIT:
            back = W.loads(w)
            assert back.is_valid or make_valid(back).area > 0, "fitted geometry must parse"
            return w, tol, 100 * (area_km2(back) - full) / full, full
    raise ValueError("could not fit geometry under limit")

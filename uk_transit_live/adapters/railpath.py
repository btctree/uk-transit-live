"""Rail-corridor geometry: snap interpolated trains onto real tracks.

For each (station A, station B) calling-point pair we lazily fetch the OSM
railway ways in that corridor (Overpass), build a small graph, route A->B
along the tracks, and cache the polyline on disk forever. While a corridor
is still unfetched the frontend keeps the straight-line fallback.
"""
import asyncio
import heapq
import json
import math
from pathlib import Path

import httpx

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "railpaths"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter"]

_mem: dict[str, list | None] = {}     # pair key -> oriented A->B path | None(=failed)
_pending: dict[str, tuple] = {}       # pair key -> (aLat, aLon, bLat, bLon)
_inflight = False


def _key(a_crs: str, b_crs: str) -> str:
    return f"{a_crs}_{b_crs}" if a_crs < b_crs else f"{b_crs}_{a_crs}"


def _load(key: str):
    if key in _mem:
        return _mem[key]
    f = CACHE_DIR / f"{key}.json"
    if f.exists():
        try:
            _mem[key] = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            _mem[key] = None
        return _mem[key]
    return "missing"


def get(a_crs, b_crs, a_lat, a_lon, b_lat, b_lon):
    """Oriented A->B track polyline if cached; queue a fetch otherwise."""
    key = _key(a_crs, b_crs)
    hit = _load(key)
    if hit == "missing":
        if len(_pending) < 200:
            _pending.setdefault(key, (a_lat, a_lon, b_lat, b_lon))
        return None
    if not hit:
        return None
    path = hit
    # orient: cached path runs low-CRS -> high-CRS; flip if caller is reversed
    d_same = (path[0][0] - a_lat) ** 2 + (path[0][1] - a_lon) ** 2
    d_flip = (path[-1][0] - a_lat) ** 2 + (path[-1][1] - a_lon) ** 2
    return path if d_same <= d_flip else path[::-1]


def _dist_m(a, b):
    return math.hypot((a[0] - b[0]) * 111000,
                      (a[1] - b[1]) * 111000 * math.cos(math.radians(a[0])))


def _route(elements, a, b):
    """Graph over OSM rail ways; A* between nodes nearest the two stations."""
    nodes, ways = {}, []
    for e in elements:
        if e["type"] == "node":
            nodes[e["id"]] = (e["lat"], e["lon"])
        elif e["type"] == "way":
            ways.append(e["nodes"])
    adj: dict[int, list] = {}
    for w in ways:
        for i in range(len(w) - 1):
            u, v = w[i], w[i + 1]
            if u in nodes and v in nodes:
                d = _dist_m(nodes[u], nodes[v])
                adj.setdefault(u, []).append((v, d))
                adj.setdefault(v, []).append((u, d))
    if not adj:
        return None

    def nearest(pt):
        return min(adj.keys(), key=lambda n: _dist_m(nodes[n], pt))

    start, goal = nearest(a), nearest(b)
    if _dist_m(nodes[start], a) > 1500 or _dist_m(nodes[goal], b) > 1500:
        return None
    gp = nodes[goal]
    dist = {start: 0.0}
    prev = {}
    pq = [(0.0, start)]
    seen = set()
    while pq:
        f, u = heapq.heappop(pq)
        if u == goal:
            break
        if u in seen:
            continue
        seen.add(u)
        for v, w in adj.get(u, []):
            nd = dist[u] + w
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd + _dist_m(nodes[v], gp), v))
    if goal not in prev and goal != start:
        return None
    path_ids = [goal]
    while path_ids[-1] != start:
        path_ids.append(prev[path_ids[-1]])
    pts = [nodes[i] for i in reversed(path_ids)]
    # sanity: routed length shouldn't wildly exceed the crow-flies distance
    total = sum(_dist_m(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    if total > max(4 * _dist_m(a, b), _dist_m(a, b) + 20000):
        return None
    if len(pts) > 400:
        stride = len(pts) // 400 + 1
        pts = pts[::stride] + [pts[-1]]
    return [[round(p[0], 5), round(p[1], 5)] for p in pts]


async def _fetch_pair(client: httpx.AsyncClient, key: str, coords: tuple) -> None:
    a = (coords[0], coords[1])
    b = (coords[2], coords[3])
    s, n = sorted((a[0], b[0]))
    w, e = sorted((a[1], b[1]))
    pad_lat = max(0.04, (n - s) * 0.35)
    pad_lon = max(0.06, (e - w) * 0.35)
    bbox = f"{s - pad_lat},{w - pad_lon},{n + pad_lat},{e + pad_lon}"
    q = f'[out:json][timeout:30];way["railway"~"^(rail|light_rail)$"]({bbox});(._;>;);out body;'
    result = None
    for url in OVERPASS:
        try:
            r = await client.post(url, data={"data": q}, timeout=45,
                                  headers={"User-Agent": "uk-transit-live/0.1"})
            if r.status_code == 200:
                result = _route(r.json().get("elements", []), a, b)
                break
        except Exception:
            continue
    # stored orientation is irrelevant: get() re-orients by endpoint distance
    (CACHE_DIR / f"{key}.json").write_text(json.dumps(result), encoding="utf-8")
    _mem[key] = result


async def worker(client: httpx.AsyncClient) -> None:
    """Background: fetch one pending corridor at a time, politely."""
    global _inflight
    while True:
        if _pending and not _inflight:
            _inflight = True
            key, coords = next(iter(_pending.items()))
            _pending.pop(key, None)
            try:
                await _fetch_pair(client, key, coords)
            except Exception:
                _mem[key] = None
            _inflight = False
            await asyncio.sleep(2)   # Overpass fair-use spacing
        else:
            await asyncio.sleep(1)


def stats() -> dict:
    cached = len(list(CACHE_DIR.glob("*.json")))
    return {"cached": cached, "pending": len(_pending)}

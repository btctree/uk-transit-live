"""Rail-corridor geometry: snap interpolated trains onto real tracks.

For each (station A, station B) calling-point pair we lazily fetch the OSM
railway ways in that corridor (Overpass), build a small graph, route A->B
along the tracks, and cache the polyline on disk forever. While a corridor
is still unfetched the frontend keeps the straight-line fallback.
"""
import asyncio
import heapq
import time as _time
import json
import math
from pathlib import Path

import httpx

from . import railnet

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "railpaths"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://overpass.openstreetmap.fr/api/interpreter"]

_mem: dict[str, list | None] = {}     # pair key -> oriented A->B path | None(=failed)
_fail_at: dict[str, float] = {}       # pair key -> last failure time (retry later)
_pending: dict[str, tuple] = {}       # pair key -> (aLat, aLon, bLat, bLon)
_inflight = 0
RETRY_AFTER = 900                     # seconds before re-attempting a failed corridor


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
    if hit == "missing" or (hit is None and _time.time() - _fail_at.get(key, 0) > RETRY_AFTER):
        if len(_pending) < 1500:
            _pending.setdefault(key, (a_lat, a_lon, b_lat, b_lon))
        if hit == "missing":
            return None
    if not hit or hit == "missing":
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
    # Local national-graph routing first: instant, no rate limits.
    if railnet.ready():
        a = (coords[0], coords[1])
        b = (coords[2], coords[3])
        result = await asyncio.to_thread(railnet.route, a, b)
        if result:
            (CACHE_DIR / (key + ".json")).write_text(json.dumps(result), encoding="utf-8")
        else:
            _fail_at[key] = _time.time()
        _mem[key] = result
        _log(key, "local-" + ("ok" if result else "no-route"))
        return
    await _fetch_pair_overpass(client, key, coords)


async def _fetch_pair_overpass(client: httpx.AsyncClient, key: str, coords: tuple) -> None:
    a = (coords[0], coords[1])
    b = (coords[2], coords[3])
    s, n = sorted((a[0], b[0]))
    w, e = sorted((a[1], b[1]))
    pad_lat = max(0.04, (n - s) * 0.35)
    pad_lon = max(0.06, (e - w) * 0.35)
    bbox = f"{s - pad_lat},{w - pad_lon},{n + pad_lat},{e + pad_lon}"
    # long express corridors need a patient query; short urban hops a quick one
    span = max(n - s, (e - w) * 0.6)
    if span > 1.4:   # ~150km+: too big for Overpass — accept the chord (permanent)
        (CACHE_DIR / f"{key}.json").write_text("null", encoding="utf-8")
        _mem[key] = None
        _log(key, "skipped-too-long")
        return
    op_timeout = 90 if span > 0.35 else 30
    q = f'[out:json][timeout:{op_timeout}][maxsize:1073741824];way["railway"~"^(rail|light_rail)$"]({bbox});(._;>;);out body;'
    result = None
    # ONE mirror per attempt (alternating) — sequential mirror retries were
    # doubling the worst case and strangling throughput.
    url = OVERPASS[_pick_n % len(OVERPASS)]
    status = "error"
    try:
        r = await client.post(url, data={"data": q}, timeout=op_timeout + 15,
                              headers={"User-Agent": "uk-transit-live/0.1"})
        status = str(r.status_code)
        if r.status_code == 200:
            result = _route(r.json().get("elements", []), a, b)
            status = "ok" if result else "no-route"
    except Exception as e:
        status = type(e).__name__
    _log(key, f"{status} span={span:.2f}")
    # Persist successes only; failures stay in memory with a retry-after so
    # transient Overpass hiccups don't leave corridors straight forever.
    if result:
        (CACHE_DIR / f"{key}.json").write_text(json.dumps(result), encoding="utf-8")
    else:
        _fail_at[key] = _time.time()
    _mem[key] = result


_pick_n = 0

async def _consume_one(client: httpx.AsyncClient) -> None:
    global _inflight, _pick_n
    # Mostly shortest-first (quick wins), but every third pick takes the oldest
    # entry so long express corridors are never starved by fresh short ones.
    _pick_n += 1
    if _pick_n % 3 == 0:
        key = next(iter(_pending))
    else:
        key = min(_pending, key=lambda k: _dist_m(_pending[k][:2], _pending[k][2:]))
    coords = _pending.pop(key)
    _inflight += 1
    try:
        await _fetch_pair(client, key, coords)
    except Exception:
        _fail_at[key] = _time.time()
        _mem[key] = None
    finally:
        _inflight -= 1


async def worker(client: httpx.AsyncClient) -> None:
    """Background corridor resolver: instant local routing once the national
    graph is built; single-flight polite Overpass before that."""
    while True:
        if _pending and railnet.ready():
            if _inflight < 2:
                asyncio.create_task(_consume_one(client))
            await asyncio.sleep(0.15)
        elif _pending and _inflight < 1:
            if railnet.status().get("status") == "building":
                await asyncio.sleep(5)   # don't compete with the tile build
                continue
            asyncio.create_task(_consume_one(client))
            await asyncio.sleep(6)     # Overpass fair-use spacing (interim only)
        else:
            await asyncio.sleep(0.8)


def _log(key: str, msg: str) -> None:
    try:
        with open(CACHE_DIR.parent / "railpath.log", "a", encoding="utf-8") as f:
            f.write(_time.strftime("%H:%M:%S") + " " + key + " " + msg + chr(10))
    except Exception:
        pass


def stats() -> dict:
    cached = len(list(CACHE_DIR.glob("*.json")))
    return {"cached": cached, "pending": len(_pending)}

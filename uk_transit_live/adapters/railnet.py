"""National rail graph: the whole GB railway network, routed locally.

Fetched ONCE as ~20 polite Overpass tile queries (or reloaded from disk),
then every station-pair corridor is routed on this machine in milliseconds —
no external service in the loop. Ends the per-corridor rate-limit problem.
"""
import asyncio
import heapq
import math
import pickle
import time
from pathlib import Path

import httpx

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
NET_FILE = DATA_DIR / "railnet.pkl"
OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://overpass.openstreetmap.fr/api/interpreter"]
UA = {"User-Agent": "uk-transit-live/0.1 (one-time national rail extract)"}

_net = None
_state = {"status": "idle", "tiles_done": 0, "tiles_total": 0, "nodes": 0}


def ready() -> bool:
    return _net is not None


def status() -> dict:
    return dict(_state)


def _dist(a, b):
    return math.hypot((a[0] - b[0]) * 111000,
                      (a[1] - b[1]) * 111000 * math.cos(math.radians(a[0])))


def load_from_disk() -> bool:
    global _net
    if _net is not None:
        return True
    if not NET_FILE.exists():
        return False
    try:
        with open(NET_FILE, "rb") as f:
            _net = pickle.load(f)
        _state.update(status="ready", nodes=len(_net["nodes"]))
        return True
    except Exception:
        return False


async def build(client: httpx.AsyncClient) -> None:
    """One-time national extract; ~15 min of polite tile queries."""
    if _state["status"] in ("building", "ready") or load_from_disk():
        return
    _state["status"] = "building"
    nodes: dict = {}
    ways: list = []
    tiles = []
    lat = 49.9
    while lat < 58.8:
        lon = -7.8
        while lon < 2.0:
            tiles.append((lat, lon, min(lat + 1.0, 58.8), min(lon + 1.3, 2.0)))
            lon += 1.3
        lat += 1.0
    _state["tiles_total"] = len(tiles)

    import gzip
    import json as _json
    tile_dir = DATA_DIR / "railnet_tiles"
    tile_dir.mkdir(exist_ok=True)
    for i, (s, w, n, e) in enumerate(tiles):
        ck = tile_dir / f"tile_{i}.json.gz"
        if ck.exists():                          # checkpoint: survives restarts
            try:
                slim = _json.loads(gzip.decompress(ck.read_bytes()))
                nodes.update({int(k): tuple(v) for k, v in slim["n"].items()})
                ways.extend(slim["w"])
                _state["tiles_done"] = i + 1
                continue
            except Exception:
                pass
        q = (f'[out:json][timeout:150][maxsize:1610612736];'
             f'way["railway"~"^(rail|light_rail)$"]({s},{w},{n},{e});(._;>;);out body;')
        for attempt in range(6):
            url = OVERPASS[(i + attempt) % len(OVERPASS)]  # spread tiles across mirrors
            _state["now"] = f"tile {i} try {attempt + 1} {url.split('/')[2]}"
            try:
                r = await client.post(url, data={"data": q}, timeout=60, headers=UA)
                _state["now"] = f"tile {i} {url.split('/')[2]} -> {r.status_code}"
                if r.status_code == 200:
                    tn, tw = {}, []
                    for el in r.json().get("elements", []):
                        if el["type"] == "node":
                            tn[el["id"]] = (el["lat"], el["lon"])
                        elif el["type"] == "way":
                            tw.append(el["nodes"])
                    nodes.update(tn)
                    ways.extend(tw)
                    ck.write_bytes(gzip.compress(_json.dumps(
                        {"n": {str(k): v for k, v in tn.items()}, "w": tw}).encode()))
                    break
                await asyncio.sleep(12)
            except Exception:
                await asyncio.sleep(10)
        _state["tiles_done"] = i + 1
        await asyncio.sleep(2.5)

    def _assemble():
        adj: dict = {}
        for wn in ways:
            for j in range(len(wn) - 1):
                u, v = wn[j], wn[j + 1]
                if u in nodes and v in nodes:
                    d = _dist(nodes[u], nodes[v])
                    adj.setdefault(u, []).append((v, d))
                    adj.setdefault(v, []).append((u, d))
        keep = {k: nodes[k] for k in adj}
        grid: dict = {}
        for nid, (la, lo) in keep.items():
            grid.setdefault((int(la * 20), int(lo * 20)), []).append(nid)
        return {"nodes": keep, "adj": adj, "grid": grid}

    net = await asyncio.to_thread(_assemble)
    with open(NET_FILE, "wb") as f:
        pickle.dump(net, f, protocol=4)
    global _net
    _net = net
    _state.update(status="ready", nodes=len(net["nodes"]))


def _nearest(pt, max_m=1500):
    if _net is None:
        return None
    grid, nodes = _net["grid"], _net["nodes"]
    cy, cx = int(pt[0] * 20), int(pt[1] * 20)
    best, best_d = None, max_m
    for dy in (-1, 0, 1):
        for dx in (-2, -1, 0, 1, 2):
            for nid in grid.get((cy + dy, cx + dx), []):
                d = _dist(nodes[nid], pt)
                if d < best_d:
                    best, best_d = nid, d
    return best


def route(a, b):
    """A* on the national graph -> [[lat, lon], ...] or None. CPU-only."""
    if _net is None:
        return None
    nodes, adj = _net["nodes"], _net["adj"]
    start, goal = _nearest(a), _nearest(b)
    if start is None or goal is None:
        return None
    gp = nodes[goal]
    dist = {start: 0.0}
    prev = {}
    pq = [(0.0, start)]
    seen = set()
    max_expand = 400_000
    while pq and max_expand:
        max_expand -= 1
        _, u = heapq.heappop(pq)
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
                heapq.heappush(pq, (nd + _dist(nodes[v], gp), v))
    if goal not in prev and goal != start:
        return None
    ids = [goal]
    while ids[-1] != start:
        ids.append(prev[ids[-1]])
    pts = [nodes[i] for i in reversed(ids)]
    total = sum(_dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    crow = _dist(a, b)
    if total > max(4 * crow, crow + 30000):
        return None
    if len(pts) > 400:
        stride = len(pts) // 400 + 1
        pts = pts[::stride] + [pts[-1]]
    return [[round(p[0], 5), round(p[1], 5)] for p in pts]

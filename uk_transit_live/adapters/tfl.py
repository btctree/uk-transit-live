"""TfL Unified API adapter.

Anonymous access is ~50 req/min; a free app_key raises it to 500 req/min.
Every call goes through a small TTL cache so the browser can poll freely
without the upstream budget being consumed per-viewer.
"""
import asyncio
import json
import os
import re
import time
from pathlib import Path

import httpx

# TfL ids are alphanumeric + hyphen/underscore (line ids, NaPTAN stop ids).
# Validating before interpolating into upstream URL paths blocks path-traversal
# / SSRF (e.g. "../AccidentStats") and keeps junk out of the cache keyspace.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_MAX_CACHE = 800


def _safe_id(value: str) -> str:
    v = (value or "").strip()
    if not _ID_RE.match(v):
        raise ValueError(f"invalid id: {value!r}")
    return v

BASE = "https://api.tfl.gov.uk"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

RAIL_MODES = "tube,dlr,overground,elizabeth-line,tram,river-bus"

# Official line colours (TfL brand palette; river services in Thames blue).
LINE_COLOURS = {
    "bakerloo": "#B36305", "central": "#E32017", "circle": "#FFD300",
    "district": "#00782A", "hammersmith-city": "#F3A9BB", "jubilee": "#A0A5A9",
    "metropolitan": "#9B0056", "northern": "#000000", "piccadilly": "#003688",
    "victoria": "#0098D4", "waterloo-city": "#95CDBA",
    "dlr": "#00A4A7", "elizabeth": "#6950A1", "tram": "#84B817",
    "lioness": "#FAA61A", "mildmay": "#0077AD", "windrush": "#EF7B10",
    "weaver": "#9B0058", "suffragette": "#5BBD72", "liberty": "#676767",
    "rb1": "#2D9CDB", "rb2": "#0072BC", "rb4": "#61C29D", "rb6": "#E84393",
    "woolwich-ferry": "#F39C12",
}
DEFAULT_COLOUR = "#DC241F"  # bus red fallback

_cache: dict[str, tuple[float, object]] = {}
_locks: dict[str, asyncio.Lock] = {}


def _lock(key: str) -> asyncio.Lock:
    if key not in _locks:
        _locks[key] = asyncio.Lock()
    return _locks[key]


def _params() -> dict:
    key = os.environ.get("TFL_APP_KEY", "").strip()
    return {"app_key": key} if key else {}


async def _get(client: httpx.AsyncClient, path: str, params: dict | None = None):
    p = _params()
    if params:
        p.update(params)
    r = await client.get(f"{BASE}{path}", params=p, timeout=25)
    r.raise_for_status()
    return r.json()


async def cached(client: httpx.AsyncClient, key: str, ttl: float, fetch):
    """TTL cache with per-key lock so concurrent viewers trigger one upstream call."""
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    async with _lock(key):
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        val = await fetch()
        _cache[key] = (time.time(), val)
        if len(_cache) > _MAX_CACHE:
            _evict()
        return val


def _evict() -> None:
    """Drop the oldest quarter of entries so the cache/lock tables stay bounded."""
    victims = sorted(_cache, key=lambda k: _cache[k][0])[: _MAX_CACHE // 4]
    for k in victims:
        _cache.pop(k, None)
        _locks.pop(k, None)


async def lines(client: httpx.AsyncClient) -> list[dict]:
    """All rail-ish TfL lines with colours (static-ish, cached 1h)."""
    async def fetch():
        raw = await _get(client, f"/Line/Mode/{RAIL_MODES}")
        return [
            {
                "id": l["id"],
                "name": l["name"],
                "mode": l["modeName"],
                "colour": LINE_COLOURS.get(l["id"], DEFAULT_COLOUR),
            }
            for l in raw
        ]
    return await cached(client, "lines", 3600, fetch)


async def status(client: httpx.AsyncClient) -> list[dict]:
    """Line status for all rail modes — one upstream call, cached 60s."""
    async def fetch():
        raw = await _get(client, f"/Line/Mode/{RAIL_MODES}/Status", {"detail": "true"})
        out = []
        for l in raw:
            worst = None
            reasons = []
            for s in l.get("lineStatuses", []):
                if worst is None or s["statusSeverity"] < worst["statusSeverity"]:
                    worst = s
                if s.get("reason"):
                    reasons.append(s["reason"])
            out.append({
                "id": l["id"],
                "name": l["name"],
                "mode": l["modeName"],
                "colour": LINE_COLOURS.get(l["id"], DEFAULT_COLOUR),
                "severity": worst["statusSeverity"] if worst else 10,
                "severityText": worst["statusSeverityDescription"] if worst else "Good Service",
                "reason": " / ".join(dict.fromkeys(reasons)) or None,
            })
        return out
    return await cached(client, "status", 60, fetch)


def _parse_linestrings(raw_strings: list[str]) -> list[list[list[float]]]:
    """TfL lineStrings are JSON-encoded arrays; normalise to [[lat,lon],...] paths."""
    paths = []
    for s in raw_strings:
        try:
            arr = json.loads(s)
        except (json.JSONDecodeError, TypeError):
            continue
        # Shape is [[[lon,lat],...]] or [[lon,lat],...] depending on line.
        chunks = arr if arr and isinstance(arr[0][0], list) else [arr]
        for chunk in chunks:
            paths.append([[pt[1], pt[0]] for pt in chunk if isinstance(pt, list) and len(pt) >= 2])
    return paths


async def geometry(client: httpx.AsyncClient, line_id: str) -> dict:
    """Route geometry + ordered stop sequences. Static — cached on disk forever."""
    line_id = _safe_id(line_id)
    f = DATA_DIR / f"geom_{line_id}.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))

    raw = await _get(client, f"/Line/{line_id}/Route/Sequence/all")
    stations = {}
    sequences = []
    for seq in raw.get("stopPointSequences", []):
        ids = []
        for sp in seq.get("stopPoint", []):
            sid = sp.get("stationId") or sp.get("id")
            stations[sid] = {
                "id": sid,
                "naptan": sp.get("id"),
                "name": (sp.get("name") or "").replace(" Underground Station", "")
                        .replace(" Rail Station", "").replace(" DLR Station", ""),
                "lat": sp.get("lat"),
                "lon": sp.get("lon"),
            }
            ids.append(sid)
        sequences.append({"direction": seq.get("direction"), "stops": ids})
    out = {
        "id": line_id,
        "colour": LINE_COLOURS.get(line_id, DEFAULT_COLOUR),
        "paths": _parse_linestrings(raw.get("lineStrings", [])),
        "stations": list(stations.values()),
        "sequences": sequences,
    }
    f.write_text(json.dumps(out), encoding="utf-8")
    return out


async def line_arrivals(client: httpx.AsyncClient, line_ids: list[str]) -> list[dict]:
    """Batched arrivals for many lines in ONE upstream call, cached 25s."""
    ids = ",".join(sorted({_safe_id(i) for i in line_ids})[:25])
    if not ids:
        return []
    async def fetch():
        raw = await _get(client, f"/Line/{ids}/Arrivals")
        return [
            {
                "vehicleId": a.get("vehicleId"),
                "lineId": a.get("lineId"),
                "stationId": a.get("naptanId"),
                "stationName": a.get("stationName"),
                "platform": a.get("platformName"),
                "destination": a.get("destinationName") or a.get("towards"),
                "timeToStation": a.get("timeToStation"),
                "expectedArrival": a.get("expectedArrival"),
                "currentLocation": a.get("currentLocation"),
                "direction": a.get("direction"),
            }
            for a in raw
        ]
    return await cached(client, f"arr:{ids}", 25, fetch)


async def stop_arrivals(client: httpx.AsyncClient, stop_id: str) -> list[dict]:
    """Arrivals board for one station/stop, cached 25s."""
    stop_id = _safe_id(stop_id)
    async def fetch():
        raw = await _get(client, f"/StopPoint/{stop_id}/Arrivals")
        raw.sort(key=lambda a: a.get("timeToStation") or 0)
        return [
            {
                "lineId": a.get("lineId"),
                "lineName": a.get("lineName"),
                "mode": a.get("modeName"),
                "platform": a.get("platformName"),
                "destination": a.get("destinationName") or a.get("towards"),
                "timeToStation": a.get("timeToStation"),
                "expectedArrival": a.get("expectedArrival"),
                "currentLocation": a.get("currentLocation"),
                "vehicleId": a.get("vehicleId"),
            }
            for a in raw
        ]
    return await cached(client, f"stop:{stop_id}", 25, fetch)


def _in_uk(lat: float, lon: float) -> bool:
    return 49.0 <= lat <= 61.5 and -9.0 <= lon <= 2.5


async def vehicle_arrivals(client: httpx.AsyncClient, vehicle_id: str,
                           line_id: str | None = None) -> list[dict]:
    """Onward stop predictions for one vehicle (works for tube trains and
    London buses). Tube vehicleIds repeat across lines, so filter by line."""
    vehicle_id = _safe_id(vehicle_id)
    if line_id:
        line_id = _safe_id(line_id)
    key = f"veh:{vehicle_id}:{line_id or ''}"
    async def fetch():
        raw = await _get(client, f"/Vehicle/{vehicle_id}/Arrivals")
        if line_id:
            raw = [a for a in raw if a.get("lineId") == line_id]
        raw.sort(key=lambda a: a.get("timeToStation") or 0)
        return [
            {
                "stop": (a.get("stationName") or "")
                    .replace(" Underground Station", "").replace(" Rail Station", "")
                    .replace(" DLR Station", ""),
                "stopId": a.get("naptanId"),
                "tts": a.get("timeToStation"),
                "platform": a.get("platformName"),
                "line": a.get("lineName"),
                "lineId": a.get("lineId"),
                "destination": a.get("destinationName") or a.get("towards"),
            }
            for a in raw
        ]
    return await cached(client, key, 20, fetch)


async def stop_info(client: httpx.AsyncClient, stop_id: str) -> dict:
    """Name + coordinates for a stop, so the UI can fly to it. Cached 24h."""
    stop_id = _safe_id(stop_id)
    async def fetch():
        raw = await _get(client, f"/StopPoint/{stop_id}")
        return {
            "id": raw.get("naptanId") or stop_id,
            "name": raw.get("commonName"),
            "lat": raw.get("lat"),
            "lon": raw.get("lon"),
        }
    return await cached(client, f"sinfo:{stop_id}", 86400, fetch)


async def bus_stops_near(client: httpx.AsyncClient, lat: float, lon: float) -> list[dict]:
    """Bus/tram stops within ~500m of a point."""
    if not _in_uk(lat, lon):
        return []
    key = f"near:{round(lat, 3)}:{round(lon, 3)}"
    async def fetch():
        raw = await _get(client, "/StopPoint", {
            "lat": lat, "lon": lon, "radius": 500,
            "stopTypes": "NaptanPublicBusCoachTram",
            "modes": "bus",
        })
        return [
            {
                "id": s["id"],
                "name": s.get("commonName"),
                "letter": s.get("stopLetter"),
                "lat": s.get("lat"),
                "lon": s.get("lon"),
                "lines": [l["name"] for l in s.get("lines", [])],
            }
            for s in raw.get("stopPoints", [])
            if s.get("lat")
        ]
    return await cached(client, key, 120, fetch)


async def search_bus_route(client: httpx.AsyncClient, query: str) -> list[dict]:
    # Route names are short alphanumerics (e.g. "73", "N25"); strip anything else
    # so the term is safe to interpolate into the search path.
    query = re.sub(r"[^A-Za-z0-9]", "", query or "")[:8]
    if not query:
        return []
    async def fetch():
        raw = await _get(client, f"/Line/Search/{query}", {"modes": "bus"})
        return [
            {"id": m["lineId"], "name": m["lineName"], "mode": "bus"}
            for m in raw.get("searchMatches", [])
        ][:12]
    return await cached(client, f"bsearch:{query.lower()}", 600, fetch)

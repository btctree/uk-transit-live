"""DfT Bus Open Data Service adapter — live bus GPS for England (incl. London).

Free registration: https://data.bus-data.dft.gov.uk/account/signup/ then copy
the API key (Account settings) into .env as BODS_API_KEY. The SIRI-VM datafeed
serves vehicle positions refreshed every ~10 seconds.
"""
import asyncio
import os
import time
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
import zlib

import httpx
from google.transit import gtfs_realtime_pb2

FEED = "https://data.bus-data.dft.gov.uk/api/v1/datafeed/"
NS = {"siri": "http://www.siri.org.uk/siri"}

_cache: dict[str, tuple[float, object]] = {}
NATIONAL_SAMPLE = 2500  # markers a browser can animate comfortably at UK zoom
# How long to stop hammering a dead BODS before trying again.
NATIONAL_FAIL_TTL = 120
EMPTY_NATIONAL = {"total": 0, "shown": 0, "fetched": None, "vehicles": []}

# One lock per cache key, tfl.cached-style. Without it, every request that
# arrives after a TTL expires launches its own download AND its own parse of
# the national feed - and since viewers poll on aligned ~20s timers, they
# expire together and stampede the single CPU core every window.
_locks: dict[str, asyncio.Lock] = {}


def _lock(key: str) -> asyncio.Lock:
    if key not in _locks:
        _locks[key] = asyncio.Lock()
    return _locks[key]


def enabled() -> bool:
    return bool(os.environ.get("BODS_API_KEY", "").strip())


def _txt(el, path: str) -> str | None:
    node = el.find(path, NS)
    return node.text if node is not None else None


async def vehicles(client: httpx.AsyncClient, min_lon: float, min_lat: float,
                   max_lon: float, max_lat: float) -> list[dict]:
    # Round the bbox so small pans reuse the cache.
    key = f"{round(min_lon,2)},{round(min_lat,2)},{round(max_lon,2)},{round(max_lat,2)}"
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < 12:
        return hit[1]

    async with _lock(key):
        hit = _cache.get(key)           # double-check: a peer may have filled it
        if hit and time.time() - hit[0] < 12:
            return hit[1]
        r = await client.get(
            FEED,
            params={
                "boundingBox": f"{min_lon},{min_lat},{max_lon},{max_lat}",
                "api_key": os.environ["BODS_API_KEY"].strip(),
            },
            timeout=30,
        )
        r.raise_for_status()
        # Multi-MB XML parse runs in a worker thread, off the event loop.
        out = await asyncio.to_thread(_parse_siri, r.content)

        _cache[key] = (time.time(), out)
        return out


def _parse_siri(content: bytes) -> list[dict]:
    """Sync SIRI-VM XML -> vehicle dicts; called via asyncio.to_thread."""
    root = ET.fromstring(content)
    out = []
    for va in root.iter(f"{{{NS['siri']}}}VehicleActivity"):
        mvj = va.find("siri:MonitoredVehicleJourney", NS)
        if mvj is None:
            continue
        loc = mvj.find("siri:VehicleLocation", NS)
        if loc is None:
            continue
        try:
            lat = float(_txt(loc, "siri:Latitude"))
            lon = float(_txt(loc, "siri:Longitude"))
        except (TypeError, ValueError):
            continue
        out.append({
            "id": f"{_txt(mvj, 'siri:OperatorRef') or '?'}|{_txt(mvj, 'siri:VehicleRef') or '?'}",
            "lat": lat,
            "lon": lon,
            "line": _txt(mvj, "siri:PublishedLineName") or _txt(mvj, "siri:LineRef"),
            "operator": _txt(mvj, "siri:OperatorRef"),
            "destination": _txt(mvj, "siri:DestinationName"),
            "bearing": _txt(mvj, "siri:Bearing"),
            "vehicle": _txt(mvj, "siri:VehicleRef"),
            "recorded": _txt(va, "siri:RecordedAtTime"),
            "originName": _txt(mvj, "siri:OriginName"),
            "originRef": _txt(mvj, "siri:OriginRef"),
            "originDep": _txt(mvj, "siri:OriginAimedDepartureTime"),
            "destRef": _txt(mvj, "siri:DestinationRef"),
            "destArrival": _txt(mvj, "siri:DestinationAimedArrivalTime"),
        })
        if len(out) >= 4000:  # keep payloads sane at wide zooms
            break
    return out


async def national(client: httpx.AsyncClient) -> dict:
    """Every bus in England via the bulk GTFS-RT download (~2MB zip of
    protobuf; the keyed /gtfsrtdatafeed API 403s but this bulk route is open —
    no key needed). Stable-sampled down to a count a browser can animate;
    sampling by vehicle-id hash so the same buses stay selected between polls
    and glide instead of flickering."""
    now = time.time()
    hit = _cache.get("national")
    if hit and now - hit[0] < 20:
        return hit[1]

    # Negative cache. BODS is a government service that goes down, and when it
    # does this endpoint returns a GOV.UK error PAGE with HTTP 200 - roughly
    # 10s per request. Without this, every /api/departures, /api/ghosts and
    # /api/ghostcount call re-attempts the dead download, so a favourites tab
    # with four stops took ~40s to render and then 500'd. Fail fast instead.
    fail = _cache.get("national_fail")
    if fail and now - fail[0] < NATIONAL_FAIL_TTL:
        return (_cache.get("national") or (0, EMPTY_NATIONAL))[1]

    async with _lock("national"):
        hit = _cache.get("national")    # double-check: a peer may have filled it
        if hit and time.time() - hit[0] < 20:
            return hit[1]
        fail = _cache.get("national_fail")
        if fail and time.time() - fail[0] < NATIONAL_FAIL_TTL:
            return (_cache.get("national") or (0, EMPTY_NATIONAL))[1]
        try:
            r = await client.get(
                "https://data.bus-data.dft.gov.uk/avl/download/gtfsrt",
                headers={"User-Agent": "uk-transit-live/0.1"},
                timeout=20,
                follow_redirects=True,
            )
            r.raise_for_status()
            body = r.content
            # Validate before parsing: an outage page is HTTP 200 text/html,
            # and feeding that to protobuf raises DecodeError deep inside a
            # worker thread, which surfaced to the browser as a bare 500.
            ctype = (r.headers.get("content-type") or "").lower()
            looks_binary = body[:2] in (b"PK", b"\x1f\x8b") or not body[:1].isascii() \
                or body[:1] in (b"\n", b"\x08", b"\x1a", b"\x12")
            if "html" in ctype or body[:1] in (b"<", b"{") or not looks_binary:
                raise ValueError(
                    f"BODS returned {ctype or 'unknown type'}, not a GTFS-RT feed "
                    "(the service is probably down)")
            # Unzip + protobuf parse + fleet-wide dict build is the heaviest CPU
            # job in the app; it runs in a worker thread, off the event loop.
            out, trip_positions_map = await asyncio.to_thread(_parse_national, body)
        except Exception as e:                      # noqa: BLE001 - degrade, never 500
            _cache["national_fail"] = (time.time(), str(e))
            print(f"bods national feed unavailable ({type(e).__name__}: {e}) - "
                  f"serving without live bus positions for {NATIONAL_FAIL_TTL}s",
                  flush=True)
            return (_cache.get("national") or (0, EMPTY_NATIONAL))[1]
        _cache.pop("national_fail", None)
        _cache["trip_positions"] = (time.time(), trip_positions_map)
        _cache["national"] = (time.time(), out)
        return out


def _parse_national(data: bytes) -> tuple[dict, dict]:
    """Sync GTFS-RT parse -> (payload, trip positions); via asyncio.to_thread."""
    if data[:2] == b"PK":  # zip wrapper around the protobuf
        import io
        import zipfile
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            data = z.read(z.namelist()[0])
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(data)

    all_vehicles = []
    trip_positions_map = {}
    for e in feed.entity:
        v = e.vehicle
        if not v or not v.position or not v.position.latitude:
            continue
        vid = v.vehicle.id or e.id
        all_vehicles.append({
            "id": vid,
            "lat": round(v.position.latitude, 5),
            "lon": round(v.position.longitude, 5),
            "bearing": round(v.position.bearing) if v.position.bearing else None,
            "route": v.trip.route_id or None,
            # GPS-fix time (unix secs). The client dead-reckons buses forward
            # by the real age of each fix; without this the national layer
            # has no age signal at all. Proto default 0 -> None.
            "ts": v.timestamp or None,
        })
        if v.trip.trip_id:
            trip_positions_map[v.trip.trip_id] = (v.position.latitude, v.position.longitude)

    total = len(all_vehicles)
    if total > NATIONAL_SAMPLE:
        step = (total // NATIONAL_SAMPLE) + 1
        sampled = [v for v in all_vehicles if zlib.crc32(v["id"].encode()) % step == 0]
    else:
        sampled = all_vehicles

    # "fetched" also ages honestly during outages: the negative cache re-serves
    # this same payload, so the client can see exactly how stale it is.
    return {"total": total, "shown": len(sampled), "fetched": int(time.time()),
            "vehicles": sampled}, trip_positions_map


async def trip_positions(client: httpx.AsyncClient) -> dict:
    """{trip_id: (lat, lon)} for the whole live fleet (refreshes with national())."""
    hit = _cache.get("trip_positions")
    if not hit or time.time() - hit[0] > 40:
        # national() degrades to empty rather than raising, but belt and
        # braces: /api/departures must still return timetable data when the
        # live bus feed is down, not a 500.
        try:
            await national(client)
        except Exception:                       # noqa: BLE001
            pass
        hit = _cache.get("trip_positions")
    return hit[1] if hit else {}


def _bearing_deg(from_lat, from_lon, to_lat, to_lon):
    import math
    dy = to_lat - from_lat
    dx = (to_lon - from_lon) * math.cos(math.radians((from_lat + to_lat) / 2))
    return (math.degrees(math.atan2(dx, dy)) + 360) % 360


async def eta_estimates(client: httpx.AsyncClient, lat: float, lon: float) -> list[dict]:
    """v1 stop ETA estimator for areas with GPS but no predictions.

    Heuristic: live buses within ~3km whose GPS bearing points toward the stop
    (within 65°) are assumed to be approaching at typical urban speed
    (~17 km/h incl. stops). Clearly labelled an estimate in the UI; v2 is
    proper timetable matching.
    """
    import math
    vs = await vehicles(client, lon - 0.045, lat - 0.03, lon + 0.045, lat + 0.03)
    out = []
    for v in vs:
        # Parked buses re-report a frozen fix for hours; one pointing at the
        # stop would fabricate a phantom "due in N min". Live fixes only.
        try:
            rec = datetime.fromisoformat(v["recorded"])
            if rec.tzinfo is None:      # offset-less strings: SIRI times are UTC
                rec = rec.replace(tzinfo=timezone.utc)
            if time.time() - rec.timestamp() > 900:
                continue
        # OSError: naive .timestamp() of epoch-ish values raises on Windows.
        except (TypeError, ValueError, KeyError, OSError, OverflowError):
            pass
        dy_km = (lat - v["lat"]) * 111.0
        dx_km = (lon - v["lon"]) * 111.0 * math.cos(math.radians(lat))
        dist = math.hypot(dx_km, dy_km)
        if not 0.05 <= dist <= 3.0:
            continue
        try:
            brg = float(v["bearing"])
        except (TypeError, ValueError):
            continue
        to_stop = _bearing_deg(v["lat"], v["lon"], lat, lon)
        diff = abs((brg - to_stop + 180) % 360 - 180)
        if diff > 65:
            continue
        out.append({
            "line": v["line"],
            "destination": v["destination"],
            "operator": v["operator"],
            "etaMin": max(1, round(dist / 17.0 * 60)),
            "distKm": round(dist, 2),
        })
    out.sort(key=lambda x: x["etaMin"])
    return out[:20]

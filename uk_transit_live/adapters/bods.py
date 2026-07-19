"""DfT Bus Open Data Service adapter — live bus GPS for England (incl. London).

Free registration: https://data.bus-data.dft.gov.uk/account/signup/ then copy
the API key (Account settings) into .env as BODS_API_KEY. The SIRI-VM datafeed
serves vehicle positions refreshed every ~10 seconds.
"""
import os
import time
import xml.etree.ElementTree as ET
import zlib

import httpx
from google.transit import gtfs_realtime_pb2

FEED = "https://data.bus-data.dft.gov.uk/api/v1/datafeed/"
NS = {"siri": "http://www.siri.org.uk/siri"}

_cache: dict[str, tuple[float, object]] = {}
NATIONAL_SAMPLE = 2500  # markers a browser can animate comfortably at UK zoom


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

    r = await client.get(
        FEED,
        params={
            "boundingBox": f"{min_lon},{min_lat},{max_lon},{max_lat}",
            "api_key": os.environ["BODS_API_KEY"].strip(),
        },
        timeout=30,
    )
    r.raise_for_status()
    root = ET.fromstring(r.content)

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

    _cache[key] = (time.time(), out)
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

    r = await client.get(
        "https://data.bus-data.dft.gov.uk/avl/download/gtfsrt",
        headers={"User-Agent": "uk-transit-live/0.1"},
        timeout=60,
        follow_redirects=True,
    )
    r.raise_for_status()
    data = r.content
    if data[:2] == b"PK":  # zip wrapper around the protobuf
        import io
        import zipfile
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            data = z.read(z.namelist()[0])
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(data)

    all_vehicles = []
    trip_positions = {}
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
        })
        if v.trip.trip_id:
            trip_positions[v.trip.trip_id] = (v.position.latitude, v.position.longitude)
    _cache["trip_positions"] = (time.time(), trip_positions)

    total = len(all_vehicles)
    if total > NATIONAL_SAMPLE:
        step = (total // NATIONAL_SAMPLE) + 1
        sampled = [v for v in all_vehicles if zlib.crc32(v["id"].encode()) % step == 0]
    else:
        sampled = all_vehicles

    out = {"total": total, "shown": len(sampled), "vehicles": sampled}
    _cache["national"] = (time.time(), out)
    return out


async def trip_positions(client: httpx.AsyncClient) -> dict:
    """{trip_id: (lat, lon)} for the whole live fleet (refreshes with national())."""
    hit = _cache.get("trip_positions")
    if not hit or time.time() - hit[0] > 40:
        await national(client)
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

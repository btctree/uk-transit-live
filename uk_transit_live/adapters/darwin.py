"""National Rail Darwin LDBWS adapter (Rail Data Marketplace REST product).

Free registration: https://raildata.org.uk — subscribe to the
"Live Departure Board" product, copy the Consumer key into .env as
DARWIN_API_KEY. Gives live departures with platforms, delays and
cancellations (incl. reasons) for every GB National Rail station.

The exact product path can differ per RDM subscription, so the base URL is
overridable via DARWIN_BASE_URL.
"""
import asyncio
import html
import json
import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

LONDON_TZ = ZoneInfo("Europe/London")

_TAG_RE = re.compile(r"<[^>]+>")


def _to_text(markup: str) -> str:
    """NRCC messages are documented XHTML — strip tags to plain text so the
    client renders them as text, never HTML. Prevents stored XSS."""
    text = _TAG_RE.sub(" ", markup or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


DEFAULT_BASE = (
    "https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120"
)
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)
STATIONS_URL = (
    "https://raw.githubusercontent.com/davwheat/uk-railway-stations/main/stations.json"
)

_cache: dict[str, tuple[float, object]] = {}


def enabled() -> bool:
    return bool(os.environ.get("DARWIN_API_KEY", "").strip())


async def stations(client: httpx.AsyncClient) -> list[dict]:
    """Station name -> CRS list (community dataset, cached on disk)."""
    f = DATA_DIR / "rail_stations.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    try:
        r = await client.get(STATIONS_URL, timeout=30, follow_redirects=True)
        r.raise_for_status()
        raw = r.json()
        out = [
            {"name": s.get("stationName"), "crs": s.get("crsCode"),
             "lat": s.get("lat"), "lon": s.get("long")}
            for s in raw
            if s.get("crsCode")
        ]
        f.write_text(json.dumps(out), encoding="utf-8")
        return out
    except Exception:
        return []


def _loc_names(field) -> str:
    """destination/origin fields arrive as {location:[{locationName}]} or [{...}]."""
    if isinstance(field, dict):
        field = field.get("location", [])
    if not isinstance(field, list):
        return ""
    return " & ".join(l.get("locationName", "") for l in field if isinstance(l, dict))


async def board(client: httpx.AsyncClient, crs: str) -> dict:
    crs = crs.strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", crs):
        raise ValueError(f"invalid CRS code: {crs!r}")
    now = time.time()
    hit = _cache.get(crs)
    if hit and now - hit[0] < 30:
        return hit[1]

    base = os.environ.get("DARWIN_BASE_URL", DEFAULT_BASE).rstrip("/")
    key = os.environ["DARWIN_API_KEY"].strip()
    r = await client.get(
        f"{base}/GetDepBoardWithDetails/{crs}",
        params={"numRows": 15},
        headers={"x-apikey": key, "User-Agent": "uk-transit-live/0.1"},
        timeout=25,
    )
    r.raise_for_status()
    raw = r.json()

    services = []
    train_services = raw.get("trainServices") or {}
    if isinstance(train_services, dict):
        train_services = train_services.get("service", []) or []
    for s in train_services:
        etd = s.get("etd") or ""
        services.append({
            "std": s.get("std"),
            "etd": etd,
            "platform": s.get("platform"),
            "operator": s.get("operator"),
            "destination": _loc_names(s.get("destination")),
            "origin": _loc_names(s.get("origin")),
            "cancelled": bool(s.get("isCancelled")) or etd.lower() == "cancelled",
            "delayed": etd.lower() not in ("on time", "cancelled", "") and etd != s.get("std"),
            "cancelReason": s.get("cancelReason"),
            "delayReason": s.get("delayReason"),
            "length": s.get("length"),
        })

    messages = raw.get("nrccMessages") or []
    if isinstance(messages, dict):
        messages = messages.get("message", []) or []
    msg_texts = []
    for m in messages:
        if isinstance(m, dict):
            msg_texts.append(m.get("Value") or m.get("value") or m.get("xhtmlMessage") or "")
        elif isinstance(m, str):
            msg_texts.append(m)

    out = {
        "station": raw.get("locationName", crs),
        "crs": crs,
        "generatedAt": raw.get("generatedAt"),
        "messages": [t for t in (_to_text(m) for m in msg_texts) if t],
        "services": services,
    }
    if len(_cache) > 200:
        _cache.clear()
    _cache[crs] = (time.time(), out)
    return out


# ---------------------------------------------------------------------------
# National live-train estimation.
#
# No open GPS feed exists for GB rail, so we do what the live tube maps do:
# poll GetDepBoardWithDetails at ~55 major hubs, harvest each departed
# service's forward calling points (with live ETAs), and interpolate the
# train's position between the two calling points either side of "now".
# ~55 requests per 90s cycle is far inside Darwin's free 5M/4-week allowance.
# ---------------------------------------------------------------------------

HUBS = [
    "KGX", "EUS", "PAD", "VIC", "WAT", "LST", "STP", "LBG", "CHX", "MYB",
    "BHM", "MAN", "LDS", "SHF", "NOT", "DBY", "LEI", "COV", "WVH", "STA",
    "LIV", "PRE", "LAN", "CRE", "CAR", "YRK", "NCL", "DON", "HUL", "MBR",
    "EDB", "GLC", "GLQ", "ABD", "INV", "DEE", "STG", "PTH",
    "HYM", "KDY", "ARB", "MTS", "AYR",
    "BRI", "CDF", "SWA", "NPT", "EXD", "PLY", "SOU", "BTN", "REA", "OXF",
    "CBG", "NRW", "IPS", "PBO", "LTN", "SVG", "GLD", "TON",
    # expansion: regional + Scottish + branch coverage (net catches far more trains)
    "CLJ", "SRA", "WIM", "FST", "CST", "BFR", "MOG",
    "AYR", "KDY", "ARB", "MTH", "KMK", "DMF", "ELG",
    "SHR", "CHD", "WKF", "HFX", "BDI", "HGT", "SCA", "DAR", "DHM", "SUN",
    "PNR", "OXN", "BPN", "WGN", "BOL", "SPT", "MCV", "MIA", "CTR", "SOT",
    "TAM", "NUN", "RUG", "MKC", "BDM", "LCN", "GRA", "ELY", "KLN", "COL",
    "CHM", "AFK", "DVP", "MAR", "HGS", "EBN", "PMH", "WIN", "BSK", "SAL",
    "BMH", "POO", "WEY", "TAU", "TOT", "PNZ", "TRU", "CNM", "GCR", "WOS",
    "HFD", "BHI", "HHD", "BNG", "CMN",
]
HUBS = list(dict.fromkeys(HUBS))  # dedupe overlapping additions

_trains: dict[str, dict] = {}     # service id -> {timeline, dest, operator, updated}
_stations_by_crs: dict[str, dict] = {}
_poll_started = False


def _as_list(field, inner: str):
    """LDBWS JSON wraps lists two ways depending on gateway; normalise."""
    if field is None:
        return []
    if isinstance(field, dict):
        field = field.get(inner, []) or []
    return field if isinstance(field, list) else []


def _parse_hhmm(s, ref: datetime):
    """'14:37' near ref -> aware datetime; handles midnight wrap. None if not a time."""
    if not s or not isinstance(s, str) or ":" not in s:
        return None
    try:
        h, m = s.strip().split(":")[:2]
        t = ref.replace(hour=int(h), minute=int(m), second=0, microsecond=0)
    except ValueError:
        return None
    if (t - ref) > timedelta(hours=12):
        t -= timedelta(days=1)
    elif (ref - t) > timedelta(hours=12):
        t += timedelta(days=1)
    return t


def _best_time(cp: dict, ref: datetime):
    """Actual > estimated > scheduled; 'On time'/'Delayed' fall through to st."""
    for k in ("at", "et", "st"):
        t = _parse_hhmm(cp.get(k), ref)
        if t is not None:
            return t
    return None


def _ingest_board(raw: dict, hub_crs: str, now: datetime) -> None:
    services = _as_list(raw.get("trainServices"), "service")
    hub = _stations_by_crs.get(hub_crs)
    for s in services:
        if s.get("isCancelled"):
            continue
        sid = s.get("rid") or s.get("serviceID") or s.get("serviceIdUrlSafe")
        if not sid:
            continue
        dep_t = None
        for k in ("atd", "etd", "std"):
            dep_t = _parse_hhmm(s.get(k), now)
            if dep_t:
                break
        timeline = []
        if hub and dep_t:
            timeline.append({"crs": hub_crs, "lat": hub["lat"], "lon": hub["lon"],
                             "name": hub["name"], "t": dep_t.timestamp()})
        cpls = _as_list(s.get("subsequentCallingPoints"), "callingPointList")
        for cpl in cpls[:1]:   # primary portion only — joins/splits list extra groups
            for cp in _as_list(cpl if isinstance(cpl, list) else cpl.get("callingPoint"), "callingPoint"):
                st = _stations_by_crs.get((cp.get("crs") or "").upper())
                t = _best_time(cp, now)
                if st and t:
                    timeline.append({"crs": cp["crs"], "lat": st["lat"], "lon": st["lon"],
                                     "name": st["name"], "t": t.timestamp()})
        if len(timeline) < 2:
            continue
        timeline.sort(key=lambda x: x["t"])
        # Pre-queue track corridors for every upcoming hop, so geometry is
        # already cached by the time the train reaches each segment.
        from . import railpath
        for _i in range(len(timeline) - 1):
            _p, _q = timeline[_i], timeline[_i + 1]
            railpath.get(_p["crs"], _q["crs"], _p["lat"], _p["lon"], _q["lat"], _q["lon"])
        known = _trains.get(sid)
        try:
            cars = int(s.get("length") or 0) or (known or {}).get("cars")
        except (TypeError, ValueError):
            cars = (known or {}).get("cars")
        # Keep the freshest view of a service (later hubs see later ETAs).
        _trains[sid] = {
            "timeline": timeline,
            "dest": _loc_names(s.get("destination")) or (known or {}).get("dest", ""),
            "operator": s.get("operator") or (known or {}).get("operator", ""),
            "cars": cars,
            "updated": time.time(),
        }


async def _details_board(client: httpx.AsyncClient, crs: str) -> dict:
    base = os.environ.get("DARWIN_BASE_URL", DEFAULT_BASE).rstrip("/")
    key = os.environ["DARWIN_API_KEY"].strip()
    r = await client.get(
        f"{base}/GetDepBoardWithDetails/{crs}",
        params={"numRows": 20},
        headers={"x-apikey": key, "User-Agent": "uk-transit-live/0.1"},
        timeout=25,
    )
    r.raise_for_status()
    return r.json()


async def poll_loop(client: httpx.AsyncClient) -> None:
    """Background task: refresh the national train picture every ~90s."""
    global _poll_started
    if _poll_started:
        return
    _poll_started = True
    while True:
        if enabled():
            if not _stations_by_crs:
                for s in await stations(client):
                    if s.get("lat") is not None:
                        _stations_by_crs[s["crs"].upper()] = s
            now = datetime.now(LONDON_TZ)
            for i in range(0, len(HUBS), 4):
                chunk = HUBS[i:i + 4]
                results = await asyncio.gather(
                    *(_details_board(client, h) for h in chunk), return_exceptions=True)
                for hub, res in zip(chunk, results):
                    if isinstance(res, dict):
                        try:
                            _ingest_board(res, hub, now)
                        except Exception:
                            pass
                await asyncio.sleep(1.5)
            cutoff = time.time() - 600
            for sid in [k for k, v in _trains.items() if v["updated"] < cutoff]:
                _trains.pop(sid, None)
        await asyncio.sleep(120)


def national_trains() -> list[dict]:
    """Current estimated segment per tracked train, for the frontend animator."""
    now = time.time()
    out = []
    for sid, svc in _trains.items():
        tl = svc["timeline"]
        if now < tl[0]["t"] or now > tl[-1]["t"]:
            continue  # not yet departed our hub / already arrived
        for i in range(len(tl) - 1):
            a, b = tl[i], tl[i + 1]
            if a["t"] <= now <= b["t"]:
                from . import railpath
                track = railpath.get(a["crs"], b["crs"], a["lat"], a["lon"], b["lat"], b["lon"])
                out.append({
                    "id": sid,
                    "a": {"lat": a["lat"], "lon": a["lon"]},
                    "b": {"lat": b["lat"], "lon": b["lon"]},
                    "path": track,
                    "tts": max(0, round(b["t"] - now)),
                    "segDur": max(30, round(b["t"] - a["t"])),
                    "nextName": b["name"],
                    "dest": svc["dest"],
                    "operator": svc["operator"],
                    "cars": svc.get("cars"),
                })
                break
    return out


def train_detail(sid: str) -> dict | None:
    """Remaining calling points (with minutes-to-arrival) for a tracked train."""
    svc = _trains.get(sid)
    if not svc:
        return None
    now = time.time()
    stops = [
        {"name": p["name"], "crs": p["crs"], "mins": max(0, round((p["t"] - now) / 60))}
        for p in svc["timeline"]
        if p["t"] >= now - 60
    ]
    # Full journey polyline: chain the cached track corridors (straight-line
    # fallback per missing pair). Powers click-a-train route reveal.
    from . import railpath
    tl = svc["timeline"]
    pts: list = []
    dots = []
    for i in range(len(tl) - 1):
        p, q = tl[i], tl[i + 1]
        seg = railpath.get(p["crs"], q["crs"], p["lat"], p["lon"], q["lat"], q["lon"])             or [[p["lat"], p["lon"]], [q["lat"], q["lon"]]]
        pts.extend(seg if not pts else seg[1:])
    for p in tl:
        dots.append({"lat": p["lat"], "lon": p["lon"], "name": p["name"],
                     "passed": p["t"] < now})
    if len(pts) > 1500:
        stride = len(pts) // 1500 + 1
        pts = pts[::stride] + [pts[-1]]
    return {"dest": svc["dest"], "operator": svc["operator"], "stops": stops,
            "route": pts, "callingPoints": dots}

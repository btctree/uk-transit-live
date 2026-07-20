"""GTFS timetable engine (v2): full stop lists + delay vs schedule, nationwide.

Uses BODS's daily-processed GTFS per English region, loaded into SQLite on
first use (a few minutes, once). Live SIRI/GTFS-RT vehicles are matched to
their scheduled trip either by trip_id (GTFS-RT carries it) or by
(route, origin stop, aimed departure) for SIRI vehicles. Delay = wall clock
vs the schedule interpolated at the vehicle's current position.
"""
import asyncio
import csv
import io
import math
import sqlite3
import time
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LONDON_TZ = ZoneInfo("Europe/London")
GTFS_URL = "https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file/{region}/"

# Rough bounding boxes (min_lon, min_lat, max_lon, max_lat) per BODS region.
REGIONS = {
    "north_west":    (-3.65, 52.90, -1.90, 55.20),
    "north_east":    (-2.60, 54.35, -0.75, 55.85),
    "yorkshire":     (-2.60, 53.30, 0.20, 54.60),
    "west_midlands": (-3.35, 51.95, -1.15, 53.25),
    "east_midlands": (-2.05, 52.55, 0.40, 53.65),
    "east_anglia":   (-0.55, 51.65, 1.80, 53.10),
    "south_west":    (-6.50, 49.90, -1.45, 51.95),
    "south_east":    (-1.95, 50.55, 1.50, 52.20),
    "london":        (-0.60, 51.25, 0.35, 51.72),
    # Devolved nations: BODS carries their timetables (largely TNDS-backfilled),
    # so scheduled boards work even where live GPS publishing is voluntary.
    "scotland":      (-7.80, 54.60, -0.70, 58.80),
    "wales":         (-5.40, 51.30, -2.60, 53.50),
}

_status: dict[str, str] = {}          # region -> idle|downloading|building|ready|error
_conns: dict[str, sqlite3.Connection] = {}
_active_cache: dict[str, tuple[str, set]] = {}   # region -> (yyyymmdd, service_ids)
_delay_cache: dict[str, tuple[float, int | None]] = {}  # trip -> (ts, delay_secs)


def region_for(lat: float, lon: float) -> str | None:
    """The rough boxes overlap, so among matches pick the nearest box centre
    (lon scaled for latitude). London's small box still wins inside London."""
    def centre_dist(b):
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        return math.hypot((lon - cx) * math.cos(math.radians(lat)), lat - cy)
    hits = [(r, centre_dist(b)) for r, b in REGIONS.items()
            if b[0] <= lon <= b[2] and b[1] <= lat <= b[3]]
    if not hits:
        return None
    if any(r == "london" for r, _ in hits):
        return "london"
    return min(hits, key=lambda x: x[1])[0]


def status(region: str) -> str:
    if _status.get(region) == "ready":
        return "ready"
    if (DATA_DIR / f"gtfs_{region}.sqlite").exists() and _status.get(region) is None:
        return "on-disk"
    return _status.get(region, "idle")


def _conn(region: str) -> sqlite3.Connection | None:
    if region in _conns:
        return _conns[region]
    db = DATA_DIR / f"gtfs_{region}.sqlite"
    if not db.exists():
        return None
    c = sqlite3.connect(db, check_same_thread=False)
    c.execute("PRAGMA query_only=1")
    _conns[region] = c
    _status[region] = "ready"
    return c


def _hms_to_secs(s: str) -> int | None:
    try:
        h, m, sec = s.strip().split(":")
        return int(h) * 3600 + int(m) * 60 + int(sec)
    except (ValueError, AttributeError):
        return None


def _build_db(zip_path: Path, db_path: Path) -> None:
    """Stream the GTFS csvs into SQLite (runs in a worker thread)."""
    tmp = db_path.with_suffix(".building")
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    con.executescript("""
        PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
        CREATE TABLE routes(route_id TEXT PRIMARY KEY, short TEXT);
        CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, headsign TEXT);
        CREATE TABLE cal(service_id TEXT PRIMARY KEY, mon INT,tue INT,wed INT,thu INT,fri INT,sat INT,sun INT, start INT, end INT);
        CREATE TABLE cal_dates(service_id TEXT, date INT, exc INT);
        CREATE TABLE stops(stop_id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL);
        CREATE TABLE stop_times(trip_id TEXT, seq INT, arr INT, dep INT, stop_id TEXT);
    """)
    z = zipfile.ZipFile(zip_path)

    def rows(name):
        with z.open(name) as fh:
            yield from csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig"))

    con.executemany("INSERT OR IGNORE INTO routes VALUES(?,?)",
                    ((r["route_id"], r["route_short_name"]) for r in rows("routes.txt")))
    con.executemany("INSERT OR IGNORE INTO trips VALUES(?,?,?,?)",
                    ((r["trip_id"], r["route_id"], r["service_id"], r.get("trip_headsign", "")) for r in rows("trips.txt")))
    con.executemany("INSERT OR IGNORE INTO cal VALUES(?,?,?,?,?,?,?,?,?,?)",
                    ((r["service_id"], r["monday"], r["tuesday"], r["wednesday"], r["thursday"],
                      r["friday"], r["saturday"], r["sunday"], r["start_date"], r["end_date"])
                     for r in rows("calendar.txt")))
    con.executemany("INSERT INTO cal_dates VALUES(?,?,?)",
                    ((r["service_id"], r["date"], r["exception_type"]) for r in rows("calendar_dates.txt")))
    con.executemany("INSERT OR IGNORE INTO stops VALUES(?,?,?,?)",
                    ((r["stop_id"], r["stop_name"], float(r["stop_lat"] or 0), float(r["stop_lon"] or 0))
                     for r in rows("stops.txt")))

    batch = []
    ins = "INSERT INTO stop_times VALUES(?,?,?,?,?)"
    for r in rows("stop_times.txt"):
        arr = _hms_to_secs(r["arrival_time"])
        dep = _hms_to_secs(r["departure_time"])
        if arr is None and dep is None:
            continue
        batch.append((r["trip_id"], int(r["stop_sequence"]), arr if arr is not None else dep,
                      dep if dep is not None else arr, r["stop_id"]))
        if len(batch) >= 100_000:
            con.executemany(ins, batch)
            batch.clear()
    if batch:
        con.executemany(ins, batch)

    con.executescript("""
        CREATE INDEX ix_st_trip ON stop_times(trip_id, seq);
        CREATE INDEX ix_st_stop ON stop_times(stop_id, dep);
        CREATE TABLE trip_starts AS
          SELECT st.trip_id AS trip_id, st.stop_id AS origin_stop, st.dep AS dep, r.short AS route_short
          FROM stop_times st
          JOIN (SELECT trip_id, MIN(seq) AS m FROM stop_times GROUP BY trip_id) f
            ON f.trip_id = st.trip_id AND f.m = st.seq
          JOIN trips t ON t.trip_id = st.trip_id
          JOIN routes r ON r.route_id = t.route_id;
        CREATE INDEX ix_ts ON trip_starts(origin_stop, dep, route_short);
    """)
    con.commit()
    con.close()
    if db_path.exists():
        db_path.unlink()
    tmp.rename(db_path)


async def ensure_region(client: httpx.AsyncClient, region: str) -> None:
    if region not in REGIONS or status(region) in ("ready", "on-disk", "downloading", "building"):
        return
    db = DATA_DIR / f"gtfs_{region}.sqlite"
    if db.exists():
        return
    try:
        zip_path = DATA_DIR / f"gtfs_{region}.zip"
        if not zip_path.exists():
            _status[region] = "downloading"
            r = await client.get(GTFS_URL.format(region=region), timeout=1800,
                                 follow_redirects=True, headers={"User-Agent": "uk-transit-live/0.1"})
            r.raise_for_status()
            zip_path.write_bytes(r.content)
        _status[region] = "building"
        await asyncio.to_thread(_build_db, zip_path, db)
        _status[region] = "ready"
    except Exception:
        _status[region] = "error"


def _active_services(region: str, con: sqlite3.Connection, day: datetime) -> set:
    key = day.strftime("%Y%m%d")
    hit = _active_cache.get(region)
    if hit and hit[0] == key:
        return hit[1]
    wd = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][day.weekday()]
    ids = {r[0] for r in con.execute(
        f"SELECT service_id FROM cal WHERE {wd}=1 AND start<=? AND end>=?", (key, key))}
    for sid, exc in con.execute("SELECT service_id, exc FROM cal_dates WHERE date=?", (key,)):
        if int(exc) == 1:
            ids.add(sid)
        else:
            ids.discard(sid)
    _active_cache[region] = (key, ids)
    return ids


def _now_secs(now: datetime) -> int:
    return now.hour * 3600 + now.minute * 60 + now.second


def match_siri_trip(region: str, line: str, origin_stop: str, origin_dep_iso: str) -> str | None:
    """SIRI vehicle -> GTFS trip via (origin stop, aimed departure, route)."""
    con = _conn(region)
    if not con or not origin_dep_iso:
        return None
    try:
        dep_local = datetime.fromisoformat(origin_dep_iso).astimezone(LONDON_TZ)
    except ValueError:
        return None
    dep_secs = _now_secs(dep_local)
    active = _active_services(region, con, dep_local)
    for tolerance in (0, 60):
        rows = con.execute(
            """SELECT ts.trip_id FROM trip_starts ts JOIN trips t ON t.trip_id=ts.trip_id
               WHERE ts.origin_stop=? AND ts.route_short=? AND ABS(ts.dep-?)<=?""",
            (origin_stop, line, dep_secs, tolerance)).fetchall()
        for (tid,) in rows:
            svc = con.execute("SELECT service_id FROM trips WHERE trip_id=?", (tid,)).fetchone()
            if svc and svc[0] in active:
                return tid
    return None


def trip_stops(region: str, trip_id: str) -> list[dict]:
    con = _conn(region)
    if not con:
        return []
    return [
        {"seq": seq, "arr": arr, "dep": dep, "stopId": sid, "name": name, "lat": lat, "lon": lon}
        for seq, arr, dep, sid, name, lat, lon in con.execute(
            """SELECT st.seq, st.arr, st.dep, st.stop_id, s.name, s.lat, s.lon
               FROM stop_times st LEFT JOIN stops s ON s.stop_id=st.stop_id
               WHERE st.trip_id=? ORDER BY st.seq""", (trip_id,))
    ]


def delay_for_position(region: str, trip_id: str, lat: float, lon: float,
                       now: datetime | None = None) -> int | None:
    """Delay (secs, +ve = late) = now vs schedule interpolated at the vehicle's
    nearest point along the trip's stop sequence. Cached 30s per trip."""
    hit = _delay_cache.get(trip_id)
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    stops = trip_stops(region, trip_id)
    if len(stops) < 2:
        return None
    now = now or datetime.now(LONDON_TZ)
    coslat = math.cos(math.radians(lat))
    best_i, best_frac, best_d = 0, 0.0, 1e18
    for i in range(len(stops) - 1):
        a, b = stops[i], stops[i + 1]
        if a["lat"] is None or b["lat"] is None:
            continue
        ax, ay = a["lon"] * coslat, a["lat"]
        bx, by = b["lon"] * coslat, b["lat"]
        px, py = lon * coslat, lat
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        frac = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        cx, cy = ax + dx * frac, ay + dy * frac
        d = (px - cx) ** 2 + (py - cy) ** 2
        if d < best_d:
            best_i, best_frac, best_d = i, frac, d
    a, b = stops[best_i], stops[best_i + 1]
    sched = (a["dep"] or a["arr"]) + best_frac * max(0, (b["arr"] or b["dep"]) - (a["dep"] or a["arr"]))
    now_s = _now_secs(now)
    if sched > 20 * 3600 and now_s < 4 * 3600:   # trip runs past midnight
        now_s += 24 * 3600
    delay = int(now_s - sched)
    delay = max(-900, min(7200, delay))
    _delay_cache[trip_id] = (time.time(), delay)
    return delay


def departures(region: str, stop_id: str, live_positions: dict,
               window_min: int = 75, limit: int = 40) -> list[dict]:
    """Scheduled departures at a stop, live-adjusted where a tracked vehicle
    is on the trip. live_positions: {trip_id: (lat, lon)} from GTFS-RT."""
    con = _conn(region)
    if not con:
        return []
    now = datetime.now(LONDON_TZ)
    now_s = _now_secs(now)
    active = _active_services(region, con, now)
    rows = con.execute(
        """SELECT st.dep, st.trip_id, r.short, t.headsign, t.service_id
           FROM stop_times st JOIN trips t ON t.trip_id=st.trip_id
           JOIN routes r ON r.route_id=t.route_id
           WHERE st.stop_id=? AND st.dep BETWEEN ? AND ?
           ORDER BY st.dep LIMIT ?""",
        (stop_id, now_s - 180, now_s + window_min * 60, limit * 3)).fetchall()
    # Last departure of the day per (line, headsign) — powers "last one tonight".
    last_dep = {}
    for dep_all, tid_all, short_all, hs_all, svc_all in con.execute(
        """SELECT st.dep, st.trip_id, r.short, t.headsign, t.service_id
           FROM stop_times st JOIN trips t ON t.trip_id=st.trip_id
           JOIN routes r ON r.route_id=t.route_id
           WHERE st.stop_id=? AND st.dep >= ?""", (stop_id, now_s - 180)):
        if svc_all in active:
            k = (short_all, hs_all)
            if dep_all > last_dep.get(k, -1):
                last_dep[k] = dep_all

    out = []
    for dep, tid, short, headsign, svc in rows:
        if svc not in active:
            continue
        delay = None
        vpos = None
        live = tid in live_positions
        if live:
            plat, plon = live_positions[tid]
            vpos = [round(plat, 5), round(plon, 5)]
            delay = delay_for_position(region, tid, plat, plon, now)
        expected = dep + (delay or 0)
        if expected < now_s - 60:   # already gone
            continue
        out.append({
            "line": short, "headsign": headsign, "tripId": tid,
            "schedSecs": dep, "expectedSecs": expected,
            "delayMin": None if delay is None else round(delay / 60),
            "live": live, "vpos": vpos,
            "isLast": last_dep.get((short, headsign)) == dep,
            "mins": max(0, round((expected - now_s) / 60)),
        })
        if len(out) >= limit:
            break
    out.sort(key=lambda x: x["expectedSecs"])
    return out


_ghost_cache: dict[str, tuple[float, list]] = {}


def ghosts(region: str, min_lon: float, min_lat: float, max_lon: float, max_lat: float,
           exclude: set, limit: int = 250) -> list[dict]:
    """Timetable-positioned ("ghost") vehicles for areas without live GPS.

    Scheduled trips currently between two stops in the viewport, interpolated
    along the timetable — clearly flagged so the UI renders them translucent.
    """
    con = _conn(region)
    if not con:
        return []
    ck = f"{region}:{round(min_lon,2)}:{round(min_lat,2)}:{round(max_lon,2)}:{round(max_lat,2)}"
    hit = _ghost_cache.get(ck)
    if hit and time.time() - hit[0] < 25:
        return hit[1]

    now = datetime.now(LONDON_TZ)
    now_s = _now_secs(now)
    active = _active_services(region, con, now)

    stop_ids = [r[0] for r in con.execute(
        "SELECT stop_id FROM stops WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
        (min_lat, max_lat, min_lon, max_lon))]
    if not stop_ids:
        _ghost_cache[ck] = (time.time(), [])
        return []

    out = []
    seen_trips = set()
    for chunk_start in range(0, len(stop_ids), 300):
        chunk = stop_ids[chunk_start:chunk_start + 300]
        q = ",".join("?" * len(chunk))
        trip_ids = [r[0] for r in con.execute(
            f"SELECT DISTINCT trip_id FROM stop_times WHERE stop_id IN ({q}) "
            "AND dep BETWEEN ? AND ?", (*chunk, now_s - 2400, now_s + 2400))]
        trip_ids = [tid for tid in trip_ids if tid not in exclude and tid not in seen_trips][:1500]
        if not trip_ids:
            continue
        qt = ",".join("?" * len(trip_ids))
        meta = {r[0]: (r[1], r[2], r[3]) for r in con.execute(
            f"SELECT t.trip_id, r.short, t.headsign, t.service_id FROM trips t "
            f"JOIN routes r ON r.route_id=t.route_id WHERE t.trip_id IN ({qt})", trip_ids)}
        rows = con.execute(
            f"SELECT st.trip_id, st.seq, st.arr, st.dep, s.lat, s.lon, st.stop_id FROM stop_times st "
            f"JOIN stops s ON s.stop_id=st.stop_id WHERE st.trip_id IN ({qt}) "
            "ORDER BY st.trip_id, st.seq", trip_ids).fetchall()
        by_trip: dict = {}
        trip_stop_ids: dict = {}
        for tid, seq, arr, dep, lat, lon, sid in rows:
            by_trip.setdefault(tid, []).append((arr, dep, lat, lon))
            trip_stop_ids.setdefault(tid, []).append(sid)
        for tid, stops in by_trip.items():
            m = meta.get(tid)
            if not m or m[2] not in active or len(stops) < 2:
                continue
            for i in range(len(stops) - 1):
                t0 = stops[i][1] or stops[i][0]
                t1 = stops[i + 1][0] or stops[i + 1][1]
                if t0 is None or t1 is None or not (t0 <= now_s <= t1):
                    continue
                seen_trips.add(tid)
                out.append({
                    "id": tid,
                    "a": {"lat": stops[i][2], "lon": stops[i][3]},
                    "b": {"lat": stops[i + 1][2], "lon": stops[i + 1][3]},
                    "tts": max(0, t1 - now_s),
                    "segDur": max(30, t1 - t0),
                    "line": m[0],
                    "headsign": m[1],
                    "mode": "tram" if any(s.startswith("9400ZZ") for s in trip_stop_ids.get(tid, ())) else "bus",
                })
                break
            if len(out) >= limit:
                break
        if len(out) >= limit:
            break

    _ghost_cache[ck] = (time.time(), out)
    if len(_ghost_cache) > 60:
        _ghost_cache.clear()
    return out

"""UK Transit Live — free, open-data live transport map.

Run:  python -m uvicorn server:app --port 8620  (from this directory)

Works with zero keys (TfL anonymous tier). Optional free keys in .env:
  TFL_APP_KEY    — raises TfL limit 50 -> 500 req/min (api-portal.tfl.gov.uk)
  DARWIN_API_KEY — National Rail live boards (raildata.org.uk)
  BODS_API_KEY   — live England bus GPS (data.bus-data.dft.gov.uk)
"""
import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from adapters import bods, darwin, gtfs, naptan, railnet, railpath, tfl

ROOT = Path(__file__).resolve().parent


def load_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_env()
    app.state.client = httpx.AsyncClient()
    # National train tracker: no-ops until DARWIN_API_KEY is configured.
    poller = asyncio.create_task(darwin.poll_loop(app.state.client))
    # GB stop index (NaPTAN): one ~100MB download on first run, then disk cache.
    stops_task = asyncio.create_task(naptan.ensure(app.state.client))
    # v2 timetable engine: pre-build the user's home region; others build lazily.
    # SKIP_GTFS_PREBUILD is for ephemeral hosts (Hugging Face Spaces): the
    # sqlites are 2.7 GB and would rebuild from scratch on every cold start,
    # so there they build on demand instead of at boot.
    if os.environ.get("SKIP_GTFS_PREBUILD") == "1":
        gtfs_task = asyncio.create_task(asyncio.sleep(0))
    else:
        gtfs_task = asyncio.create_task(gtfs.ensure_region(app.state.client, "north_west"))
        for _r in ("scotland", "wales"):
            asyncio.create_task(gtfs.ensure_region(app.state.client, _r))
    # Track-geometry worker: snaps trains onto real OSM rail corridors, lazily.
    rail_task = asyncio.create_task(railpath.worker(app.state.client))
    # One-time national rail graph (~15 min of polite tile fetches, then local
    # routing forever). Reloads instantly from disk on later starts.
    asyncio.create_task(railnet.build(app.state.client))
    yield
    rail_task.cancel()
    poller.cancel()
    stops_task.cancel()
    gtfs_task.cancel()
    await app.state.client.aclose()


app = FastAPI(title="UK Transit Live", lifespan=lifespan)


# The app updates frequently — never let browsers cache the UI, so a plain
# refresh always shows the newest version.
@app.middleware("http")
async def no_cache_ui(request: Request, call_next):
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


# Central error handling so a bad id -> 400 and an upstream hiccup -> 502/503,
# never a bare 500 that the frontend can't distinguish. Covers every route
# (including /api/status, which previously had none).
@app.exception_handler(ValueError)
async def _bad_input(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(httpx.HTTPStatusError)
async def _upstream_status(request: Request, exc: httpx.HTTPStatusError):
    return JSONResponse(
        status_code=502,
        content={"detail": f"upstream {exc.response.status_code}"},
    )


@app.exception_handler(httpx.RequestError)
async def _upstream_down(request: Request, exc: httpx.RequestError):
    return JSONResponse(status_code=503, content={"detail": "upstream unreachable"})


@app.get("/api/config")
async def config():
    return {
        "tflKeyed": bool(os.environ.get("TFL_APP_KEY", "").strip()),
        "darwin": darwin.enabled(),
        "bods": bods.enabled(),
    }


@app.get("/api/lines")
async def lines():
    return await tfl.lines(app.state.client)


@app.get("/api/status")
async def status():
    return await tfl.status(app.state.client)


@app.get("/api/geometry/{line_id}")
async def geometry(line_id: str):
    try:
        return await tfl.geometry(app.state.client, line_id)
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f"TfL: {e.response.text[:200]}")


@app.get("/api/trains")
async def trains(lines: str = Query(..., description="comma-separated line ids")):
    ids = [l for l in lines.split(",") if l.strip()]
    if not ids:
        return []
    try:
        return await tfl.line_arrivals(app.state.client, ids)
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f"TfL: {e.response.text[:200]}")


@app.get("/api/arrivals/{stop_id}")
async def arrivals(stop_id: str):
    try:
        return await tfl.stop_arrivals(app.state.client, stop_id)
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f"TfL: {e.response.text[:200]}")


@app.get("/api/busstops")
async def busstops(lat: float, lon: float):
    return await tfl.bus_stops_near(app.state.client, lat, lon)


@app.get("/api/stopname/{atco}")
async def stopname(atco: str):
    import re as _re
    if not _re.fullmatch(r"[A-Za-z0-9]{4,16}", atco):
        raise HTTPException(400, "bad ATCO code")
    s = naptan.by_id(atco)
    if not s:
        raise HTTPException(404, "unknown stop")
    return {"id": s[0], "name": s[1], "indicator": s[2], "lat": s[3], "lon": s[4]}


@app.get("/api/departures/{stop_id}")
async def stop_departures(stop_id: str):
    """v2: scheduled departures at any GB stop, live-adjusted with delays."""
    import re as _re
    if not _re.fullmatch(r"[A-Za-z0-9]{4,16}", stop_id):
        raise HTTPException(400, "bad stop id")
    s = naptan.by_id(stop_id)
    if not s:
        raise HTTPException(404, "unknown stop")
    region = gtfs.region_for(s[3], s[4])
    if not region:
        return {"state": "unsupported", "departures": []}
    st = gtfs.status(region)
    if st != "ready":
        if st in ("idle",):
            asyncio.create_task(gtfs.ensure_region(app.state.client, region))
        elif st == "on-disk":
            gtfs._conn(region)  # open it
            st = "ready"
    if gtfs.status(region) != "ready":
        return {"state": gtfs.status(region), "region": region, "departures": []}
    live = await bods.trip_positions(app.state.client) if bods.enabled() else {}
    deps = await asyncio.to_thread(gtfs.departures, region, stop_id, live)
    return {"state": "ready", "region": region, "departures": deps}


@app.get("/api/journey")
async def vehicle_journey(line: str, origin: str, dep: str, lat: float, lon: float):
    """v2: full stop list for a live SIRI vehicle, with delay vs timetable."""
    region = gtfs.region_for(lat, lon)
    if not region or gtfs.status(region) not in ("ready", "on-disk"):
        if region and gtfs.status(region) == "idle":
            asyncio.create_task(gtfs.ensure_region(app.state.client, region))
        return {"matched": False, "state": region and gtfs.status(region) or "unsupported"}
    gtfs._conn(region)
    trip_id = await asyncio.to_thread(gtfs.match_siri_trip, region, line, origin, dep)
    if not trip_id:
        return {"matched": False, "state": "no-match"}
    stops = await asyncio.to_thread(gtfs.trip_stops, region, trip_id)
    delay = await asyncio.to_thread(gtfs.delay_for_position, region, trip_id, lat, lon)
    return {"matched": True, "tripId": trip_id, "delaySecs": delay, "stops": stops}


@app.get("/api/railpaths")
async def railpath_stats():
    trains = darwin.national_trains()
    snapped = sum(1 for t in trains if t.get("path"))
    st = railpath.stats()
    st.update({"trains": len(trains), "snapped": snapped, "railnet": railnet.status()})
    return st


@app.get("/api/ghostcount")
async def ghost_count(lat: float, lon: float):
    """Scheduled-vehicle count near a city centre (for country-view chips)."""
    region = gtfs.region_for(lat, lon)
    if not region or gtfs.status(region) not in ("ready", "on-disk"):
        return {"count": 0}
    gtfs._conn(region)
    live = await bods.trip_positions(app.state.client) if bods.enabled() else {}
    gs = await asyncio.to_thread(
        gtfs.ghosts, region, lon - 0.14, lat - 0.09, lon + 0.14, lat + 0.09, set(live.keys()), 300)
    return {"count": len(gs)}


@app.get("/api/ghosts")
async def ghost_vehicles(minLon: float, minLat: float, maxLon: float, maxLat: float):
    """Timetable-positioned vehicles for areas without live GPS (translucent
    on the map). Live-tracked trips are excluded so nothing shows twice."""
    if (maxLon - minLon) * (maxLat - minLat) > 1.2:
        return []   # viewport too wide for ghost detail
    regions = set()
    for lat, lon in ((minLat, minLon), (minLat, maxLon), (maxLat, minLon),
                     (maxLat, maxLon), ((minLat + maxLat) / 2, (minLon + maxLon) / 2)):
        r = gtfs.region_for(lat, lon)
        if r:
            regions.add(r)
    live = await bods.trip_positions(app.state.client) if bods.enabled() else {}
    exclude = set(live.keys())
    out = []
    for r in regions:
        if gtfs.status(r) in ("ready", "on-disk"):
            gtfs._conn(r)
            out.extend(await asyncio.to_thread(
                gtfs.ghosts, r, minLon, minLat, maxLon, maxLat, exclude, 200))
    return out[:300]


@app.get("/api/eta")
async def eta(lat: float, lon: float):
    if not bods.enabled():
        raise HTTPException(503, "BODS not configured")
    if not tfl._in_uk(lat, lon):
        return []
    return await bods.eta_estimates(app.state.client, lat, lon)


@app.get("/api/stops")
async def stops(minLon: float, minLat: float, maxLon: float, maxLat: float):
    data = naptan.in_bbox(minLon, minLat, maxLon, maxLat)
    if data is None:
        return {"ready": False, "state": naptan.status()["state"], "stops": []}
    return {"ready": True, "stops": data}


@app.get("/api/bussearch/{query}")
async def bussearch(query: str):
    return await tfl.search_bus_route(app.state.client, query)


@app.get("/api/rail/stations")
async def rail_stations():
    return await darwin.stations(app.state.client)


@app.get("/api/vehicle/{vehicle_id}")
async def vehicle(vehicle_id: str, line: str | None = None):
    return await tfl.vehicle_arrivals(app.state.client, vehicle_id, line)


@app.get("/api/stopinfo/{stop_id}")
async def stopinfo(stop_id: str):
    return await tfl.stop_info(app.state.client, stop_id)


@app.get("/api/rail/train/{sid}")
async def rail_train(sid: str):
    import re as _re
    if not _re.fullmatch(r"[A-Za-z0-9_-]{1,40}", sid):
        raise HTTPException(400, "bad train id")
    d = darwin.train_detail(sid)
    if d is None:
        raise HTTPException(404, "train no longer tracked")
    return d


@app.get("/api/rail/trains")
async def rail_trains():
    if not darwin.enabled():
        raise HTTPException(503, "Darwin not configured — add DARWIN_API_KEY to .env")
    return darwin.national_trains()


@app.get("/api/rail/board/{crs}")
async def rail_board(crs: str):
    if not darwin.enabled():
        raise HTTPException(503, "Darwin not configured — add DARWIN_API_KEY to .env")
    try:
        return await darwin.board(app.state.client, crs)
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f"Darwin: {e.response.text[:200]}")


@app.get("/api/buses")
async def buses(minLon: float, minLat: float, maxLon: float, maxLat: float):
    if not bods.enabled():
        raise HTTPException(503, "BODS not configured — add BODS_API_KEY to .env")
    try:
        return await bods.vehicles(app.state.client, minLon, minLat, maxLon, maxLat)
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f"BODS: {e.response.text[:200]}")


@app.get("/api/buses/national")
async def buses_national():
    # Uses BODS's open bulk GTFS-RT download — works without any key.
    return await bods.national(app.state.client)


@app.get("/")
async def index():
    return FileResponse(ROOT / "static" / "index.html")


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

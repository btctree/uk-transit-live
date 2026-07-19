# UK Transit Live

Free, open-data live UK transport map: London Underground / Overground / DLR /
Elizabeth line / Trams / buses with live arrivals, delays and platforms —
plus National Rail departure boards and England-wide live bus GPS when you add
the free keys.

## Run

```bash
cd uk_transit_live
pip install -r requirements.txt
python -m uvicorn server:app --port 8620
# open http://localhost:8620
```

Works immediately with **zero keys** (TfL anonymous tier):

- **Whole-UK map view** by default: the entire GB rail network drawn
  (OpenRailwayMap overlay) + all 2,606 National Rail stations (zoom ≥ 9)
- All London rail lines drawn on the map (official colours), toggle per line
- Live line status with disruption reasons, auto-refresh 60s
- Click any station dot → live arrivals board (destination, due time, platform,
  current train location), refresh 30s
- **Continuously moving vehicles**: London trains/trams/DLR glide along their
  lines in real time (interpolated between live arrival predictions — the same
  trick the classic live tube maps use); searched London bus routes animate too
- London bus route search + per-stop live arrivals (click map at zoom ≥ 15)

With the free **Darwin key**, live National Rail trains move across the whole
UK map (positions estimated from calling-point ETAs polled at ~55 major hubs
every 90s) and every station gets a live departure board. With the free
**BODS key**, every in-scope English bus appears as real moving GPS dots.

## Optional free upgrades (.env)

Copy `.env.example` → `.env`, add any of:

| Key | Unlocks | Register at |
|---|---|---|
| `DARWIN_API_KEY` | National Rail live boards for every GB station: platforms, delays, cancellations with reasons | raildata.org.uk → "Live Departure Board" product (free, 5M req/4wk) |
| `BODS_API_KEY` | Live GPS of every in-scope bus in England, 10s refresh (orange dots, toggle in Buses tab) | data.bus-data.dft.gov.uk (free signup) |
| `TFL_APP_KEY` | Raises TfL rate limit 50 → 500 req/min | api-portal.tfl.gov.uk |

Restart the server after editing `.env`.

## Architecture

- `server.py` — FastAPI; every browser poll hits a server-side TTL cache so
  upstream rate limits are consumed once per interval, not per viewer.
  Line geometry is cached to disk permanently (`data/`).
- `adapters/tfl.py` — TfL Unified API (status / geometry / arrivals batched
  into single upstream calls)
- `adapters/darwin.py` — National Rail LDBWS via Rail Data Marketplace REST
- `adapters/bods.py` — DfT Bus Open Data SIRI-VM vehicle positions (XML → JSON)
- `static/` — Leaflet single-page app, no build step

## Known limits (see UK_TRANSPORT_LIVE_DATA.md in repo root)

- Train positions are estimates — no open GPS feed exists for UK rail
- Trams outside London mostly have no open live feeds (West Midlands is the
  exception); Scotland bus mandate lands ~2028; Northern Ireland has none
- Fares intentionally out of scope (kept free)

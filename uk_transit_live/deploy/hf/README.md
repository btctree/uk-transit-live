---
title: UK Transit Live
emoji: 🚆
colorFrom: red
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
license: mit
---

<!--
BLOCKED as of 2026-08-02: creating a Docker or Gradio Space now requires a PRO
subscription ($9/month). The new-Space page states "Gradio and Docker Spaces
require a paid plan. Static Spaces stay free for everyone." Only Static
(client-side) Spaces are free, and this app needs a Python server process.

Note the trap: huggingface.co/pricing still advertises CPU Basic (2 vCPU,
16 GB) as free, which is true of the *hardware tier* - but creating a
compute-backed Space is gated behind PRO regardless. The pricing page and the
creation page disagree; the creation page is what binds.

This kit is kept because it is not HF-specific: the Dockerfile and boot.sh
run on any Docker host, including the Oracle A1 instance when the hunt wins.
-->

# UK Transit Live

Free, open-data live UK transport map: London Underground / Overground / DLR /
Elizabeth line / trams and buses with live arrivals, delays and platforms, plus
National Rail departure boards and England-wide live bus GPS.

Trains move along real OpenStreetMap track geometry using a prebuilt GB rail
graph (615,932 nodes), so vehicles follow the actual line rather than
straight-line hops.

## Hosting notes

This Space runs the FastAPI app under the Docker SDK. Two things differ from a
normal VM deployment:

- **The filesystem is ephemeral.** `deploy/hf/boot.sh` restores ~101 MB of
  prebuilt caches (rail graph, NaPTAN stop index, track tiles) from a Dataset
  repo on every cold start. Rebuilding them from Overpass instead would take
  hours.
- **GTFS timetable prebuilding is off** (`SKIP_GTFS_PREBUILD=1`). Those
  sqlites are 2.7 GB and cannot be shipped in the bundle, so scheduled-vehicle
  ("ghost") coverage outside London builds on demand rather than at boot.

Free CPU Spaces sleep after 48 hours without traffic; the next visitor
triggers a cold start of roughly a minute while the caches restore.

## Configuration

| Kind | Name | Purpose |
|---|---|---|
| Variable | `CACHE_BUNDLE_URL` | Public Dataset URL of the cache tarball |
| Secret | `TFL_APP_KEY` | Raises the TfL rate limit 50 → 500 req/min |
| Secret | `DARWIN_API_KEY` | National Rail live departure boards |
| Secret | `BODS_API_KEY` | Live England bus GPS |

The app runs with no keys at all on the TfL anonymous tier; each key unlocks
more of the map.

## Data sources & attribution

- **Powered by TfL Open Data** — contains OS data © Crown copyright and
  database rights 2016, and Geomni UK Map data © and database rights 2019.
- Rail data from **National Rail Enquiries / Rail Delivery Group (Darwin)**.
- Bus, coach and timetable data © Crown copyright — **DfT Bus Open Data
  Service (BODS)**, Open Government Licence v3.
- Stop data from **NaPTAN** © Crown copyright, OGL v3.
- Map tiles © OpenStreetMap contributors, © CARTO.
- Rail track geometry © OpenStreetMap contributors (ODbL).

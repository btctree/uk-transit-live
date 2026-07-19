# UK Transport Live Data — Feasibility & API Reference

**Question:** Can we track every UK train / tram / underground / bus line on a map, with live schedules, arrivals, delays, cancellations, platforms and fares?

**Verdict: YES for ~90% of it, using free open data — but it is 8+ separate APIs, not one.** The UK has arguably the best open transport data in the world (bustimes.org, traksy.uk and opentraintimes.com are single-developer proof it works in production). The genuine holes: fares (hard everywhere except London), trams outside London (regressed badly in 2025–26), Scottish live buses (mandate not in force until ~2028), and Northern Ireland buses (no live data at all).

Research method: 12 agents on 2026-07-14 — 6 domain researchers + 6 adversarial fact-checkers hitting official docs and live endpoints. Several claims below were **verified by live API calls on 14 Jul 2026** (marked ✓live).

---

## Capability matrix

| Capability | National Rail | London (TfL) | Buses England | Buses Sco/Wal/NI | Trams/Metros (non-London) |
|---|---|---|---|---|---|
| Lines on a map | ✅ NR track model (OGL) / OSM | ✅ lineStrings in API ✓live | ✅ BODS GTFS shapes | ✅ TNDS/TfW (NI: GIS layers) | ✅ GIS portals / OSM |
| Live vehicle positions | ⚠️ berth-level (TD feed), no GPS | ⚠️ inferred (buses: GPS via BODS) | ✅ GPS every 10s (BODS) | ⚠️ Wales yes, Scotland partial, NI ❌ | ⚠️ West Midlands only |
| Live arrivals at stops | ✅ Darwin (canonical) | ✅ /Arrivals ✓live | ⚠️ build own ETA from GPS | ⚠️ NextBuses now paid | ⚠️ TfWM only self-serve |
| Delays + cancellations | ✅ Darwin + TRUST, with reasons | ✅ line status + reasons ✓live | ⚠️ thin (new Mar 2026 feed) | ❌ mostly | ❌ web pages only |
| Platform numbers | ✅ Darwin (some suppressed) | ✅ platformName ✓live | n/a (stand letters in NaPTAN) | n/a | ⚠️ T&W Metro only (now locked) |
| Fares | ⚠️ free flat files, hard; O-D APIs paid | ✅ FareTo endpoint ✓live | ⚠️ NeTEx patchy | ❌ | ❌ |

---

## 1. National Rail (GB heavy rail) — GRADE: A

The best-served domain. Everything except GPS and fares is free.

### Darwin — passenger predictions (arrivals, departures, delays, cancels, platforms)
- **LDBWS REST API** — registration moved to the **Rail Data Marketplace (raildata.org.uk)**. Free up to **5M requests per 4-week railway period**. Auth: RDM consumer key as `x-apikey` header against `api1.raildata.org.uk`. Old NRE SOAP tokens don't work on the new endpoints — most pre-2024 tutorials/libraries (nre-darwin-py, Huxley2) are broken.
- Gives per-station boards: expected arrival AND departure times, **platform numbers** (suppressed at some stations by TOC policy), delay estimates, cancellations **with reason codes**.
- **Darwin Push Port** — full national streaming firehose (every forecast, platform change, cancellation, formation). Legacy STOMP/XML v16 via opendata.nationalrail.co.uk still live; new RDM product is **Kafka-only, schema v17, JSON** — had real teething problems 2024–25 (blank credentials, suspended subscriptions). Check product status before designing around it.

### Network Rail open feeds — operational ground truth
- **publicdatafeeds.networkrail.co.uk** — free, but ~1,000 active-account cap (sign-ups genuinely refused when hit; RDM is the suggested workaround). No SLA.
- **TD (Train Describer)**: berth-level signalling positions, seconds latency, ~1.5–2M msgs/day over STOMP. The finest-grained open position data — **no open GPS feed exists for GB rail** (confirmed). Live maps (OpenTrainTimes, Traksy) interpolate berth steps along track geometry.
- **TRUST**: actual movement events, cancellations, variance vs schedule (~30s granularity; some manual entries amended later).
- **SCHEDULE** (daily CIF timetable), **VSTP** (<48h schedules), **RTPPM** (punctuality, ~1min), CORPUS/SMART/BPLAN reference data for geolocation (approximate — community datasets fill the gap).

### Shortcut: Realtime Trains Next Generation API (launched 27 Mar 2026)
- Pre-joined Darwin + TRUST/TD. Free personal/non-commercial: **30/min, 750/hr, 9,000/day, 30,000/wk**. Shows some platforms Darwin suppresses.
- ⚠️ Legacy `api.rtt.io` shuts **30 Sep 2026**; `secure.realtimetrains.co.uk` shuts 31 Mar 2027. Build only on the new api-portal.rtt.io.

---

## 2. London — TfL Unified API — GRADE: A

One free REST API (`api.tfl.gov.uk`) covers Underground, all ~700 bus routes, DLR, Overground, Elizabeth line, Trams. Register at api-portal.tfl.gov.uk → single "500 Requests per min" product, `app_key` query param (app_id retired). Anonymous = 50 req/min. Accounts idle 12 months are deleted.

- **Route geometry**: `/Line/{id}/Route/Sequence/{dir}` returns ready-to-plot lineStrings ✓live.
- **Arrivals**: `/StopPoint/{id}/Arrivals`, `/Line/{id}/Arrivals` — timeToStation, expectedArrival, platformName, vehicleId. ~30s server cache, poll-only (no push). Elizabeth line + Overground work on the standard pipeline ✓live (ArrivalDepartures endpoint is complementary, not required).
- **Delays**: `/Line/Mode/.../Status?detail=true` — severity scale + plain-English reasons ✓live; future date-range for planned works.
- **Fares**: `/Stoppoint/{from}/FareTo/{to}` ✓live (KGX→Bank: cash £7.00, PAYG £3.00/£3.10, validity to Jul 2027). No caps/Travelcards/railcards.
- **Positions**: no GPS in the Unified API — tube trains tracked via vehicleId + free-text currentLocation ("Between Seven Sisters and Finsbury Park"). Tube vehicleIds NOT unique across lines ✓live. **But London bus GPS IS free via BODS SIRI-VM** (`operatorRef=TFLO`) — pair the two sources.
- **Breaking change**: "london-overground" id replaced by six lines: lioness, mildmay, windrush, weaver, suffragette, liberty ✓live.
- Reliability: Sept 2024 cyber incident took Tube arrivals down for weeks; build graceful degradation.

---

## 3. Buses — GRADE: A (England) / C (Scotland) / B (Wales) / F (NI)

### England outside London: BODS (data.bus-data.dft.gov.uk) — legally mandated, free, email-registration API key
- **Timetables**: TransXChange + processed national GTFS (shapes.txt for map drawing), refreshed 2×/day.
- **Live positions**: SIRI-VM + GTFS-RT, **10-second server cache**, GPS lat/lon + bearing + route refs. Mandated since Jan 2021.
- **The catch (confirmed)**: BODS gives **positions only — no arrival predictions, no GTFS-RT TripUpdates**. You must match AVL to timetables and compute ETAs yourself. This is the single biggest engineering task in the whole project. Known issues: ~70% operator compliance (2023), ghost/stale vehicles, overnight matching failures.
- **Disruptions**: SIRI-SX feed (1-min refresh, coverage depends on local-authority diligence); operator cancellations only added **March 2026**, adoption early.
- **NextBuses** (per-stop departures, GB-wide) moved to TransportAPI on **1 May 2026** — free tier now 30 req/day; no longer a viable free source.

### Scotland — voluntary until ~2028
Consultation closed Jun 2025, analysis Nov 2025, regulations being laid ~Jan 2026, but the **real-time (AVL) duty phases in ~18 months after in-force → mandated Scottish live data is realistically 2028**. Today: big operators voluntarily on BODS, Lothian/Edinburgh via council Travel Tracker (on request), rest timetable-only via TNDS.

### Wales — good but not self-serve
Welsh Bus Data Service (TfW/PTI Cymru): all-Wales timetables + live SIRI, arranged by email (data@tfw.wales). Powers bustimes.org's Welsh coverage.

### Northern Ireland — hard stop
Translink publishes only ATCO-CIF timetables, stop lists, route GIS. **No open bus real-time at all.** Only open live feed is rail arrivals (2-min cache). (Beware: "Translink GTFS-RT" search hits are Translink Queensland, Australia.)

---

## 4. Trams / metros outside London — GRADE: D (regressed 2025–26)

Trams are outside the BODS mandate (2020 Regulations cover PSV local bus services only) — everything is voluntary, and three feeds closed recently:

| System | Live data? | Notes |
|---|---|---|
| **West Midlands Metro** | ✅ only fully open one | TfWM portal (api-portal.tfwm.org.uk): GTFS + GTFS-RT "all vehicles", free, 10k hits/day ✓live-docs |
| Manchester Metrolink | ❌ closed | TfGM portal shut; no new keys; "exploring options", no timeline ✓live |
| Tyne & Wear Metro | ❌ locked Mar 2026 | metro-rti.nexus.org.uk (positions + per-platform times) now returns 401 Bearer-required on every endpoint ✓live |
| Edinburgh Trams | ⚠️ on request | old TfE API closed ✓live; successor = council Travel Tracker, apply by email |
| Sheffield Supertram | ❌ | only via commercial TransportAPI |
| Nottingham NET | ❌ | old endpoint NXDOMAIN ✓live; displays live but feed unexposed |
| Glasgow Subway | ❌ | status webpage + TNDS timetable only |
| Blackpool | ⚠️ timetable only | on BODS (dataset 14058); no live tracking |

Geometry for all: council ArcGIS portals, NaPTAN, GTFS shapes, OSM.

---

## 5. Fares — GRADE: C (the hardest requirement)

- **TfL**: solved — FareTo endpoint, free ✓live. Missing: caps, Travelcards, railcards.
- **National Rail**: raw data is free (RSPS5045 flat files, 3 releases/yr, via RDM — data.atoc.org closed end-2024, NRDP retiring early 2026) but computing a correct fare = flows, station clusters, non-derivable fares, railcards, routeing-guide validity — **a months-long engineering job with rules "not written down anywhere"**. Practical O-D APIs are paid: **BR Fares** on RDM (100-call free demo/30 days, then £50 per 1,000 calls) or **OJP/SilverRail** (cost-recovery licence, quarterly onboarding, no retailing). Advance ticket availability needs retail APIs (Trainline Partner = B2B only).
- **Contactless PAYG**: Project Oval now ~96–100 SE England stations (47 live Feb 2025, +30 Dec 2025, +~20 incl. Stansted/Southend live 8 Mar 2026). Cap-dependent charging means quoted single ≠ amount charged; **no public API exposes cap state**; PAYG fares diverge from the static fares feed.
- **Buses**: BODS NeTEx (mandated England; simple since 2021, complex since 2023) — patchy, painful to parse, Traveline calls it "not sufficiently comprehensive and consistent". Scotland/Wales/NI: none.

---

## 6. Map building blocks & aggregators

- **NaPTAN/NPTG**: every GB stop/station (~400k+), free, OGL, **no registration** ✓live, CSV/XML + Swagger API (beta-naptan.dft.gov.uk). Not NI.
- **Rail track geometry**: Network Rail geospatial track model, OGL — migrated from archived GitHub (Aug 2024) to Rail Data Marketplace ✓. Or OSM/OpenRailwayMap (rail/tram near-complete).
- **Bus geometry**: BODS GTFS shapes (uneven; map-match coarse TransXChange with pfaedle/OSRM against OSM).
- **Aggregators**: **Transitous** (free hosted MOTIS 2, ingests BODS GTFS+RT, non-commercial, mandatory User-Agent); **TransportAPI** (commercial: 30/day free, £5/mo home 300/day, PAYG business); **bustimes.org** API (hobbyist, undocumented terms — reference only).
- **Existence proofs**: bustimes.org (all GB+NI+IE buses, one developer), traksy.uk / opentraintimes.com (live rail maps from TD/TRUST), tynemetro.live.

---

## What an MVP would look like

1. **Static layer** (weekly refresh): NaPTAN stops + TfL lineStrings + BODS GTFS shapes + NR track model + OSM tram/metro relations → vector tiles.
2. **Rail engine**: Darwin LDBWS polling (or Push Port STOMP consumer) for boards/delays/platforms; optional NR TD/TRUST consumer for live train dots (biggest lift: berth→coordinate mapping).
3. **Bus engine**: BODS SIRI-VM poll every 10s → match to GTFS trips → own ETA model. TfL /Arrivals for London.
4. **Status layer**: TfL line status + BODS SIRI-SX + Darwin cancellations.
5. **Fares v1**: TfL FareTo only; add BR Fares paid tier if rail fares needed; skip bus fares.
6. **Skip at v1**: NI buses, trams except West Midlands, Advance ticket pricing, cap simulation.

Registrations needed (all free): Rail Data Marketplace, Network Rail publicdatafeeds (account cap!), BODS, TfL api-portal, optionally RTT + TfWM.

---

*Compiled 2026-07-14 from a 12-agent verified research sweep (6 researchers + 6 adversarial fact-checkers; live endpoint tests where marked ✓live). Corrections applied where fact-checkers refuted researcher claims (T&W Metro lockdown, Project Oval station counts, Elizabeth-line arrivals pipeline, London bus GPS via BODS, Scottish regulation timeline).*

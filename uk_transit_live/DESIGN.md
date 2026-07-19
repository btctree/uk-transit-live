# UK Transit Live — design review (user × designer)

## The session

**USER:** I open the app and see… Britain, buried under two thousand tiny buses.
I can't read a single city name. What is this map telling me?

**DESIGNER:** Nothing — that's the problem. It answers "where is every bus?"
which no human ever asks. Real questions are: *when is MY bus coming? Is my
line running? What's near me?* The national bus blanket is engineering pride,
not user value.

**USER:** But I asked for "whole UK on the map"…

**DESIGNER:** And you should get it — as *capability*, not as a poster. The way
every good map product handles this is **progressive disclosure**: each zoom
level answers a different question.

| Zoom | Question it answers | What we show |
|---|---|---|
| 5–8 (country) | "Where is there activity? Where do I look?" | Clean base map with big place names + **live city chips** ("Manchester · 1,204 live 🚌") that zoom you in. No individual vehicles. |
| 9–12 (city) | "How is my city moving?" | Lines, stations, vehicles as *small* markers. |
| 13–14 (district) | "What's happening on my street?" | Bigger icons, stops visible, everything clickable. |
| 15+ (street) | "That exact bus" | Full detailed icons, stop letters, boards. |

**USER:** The base map also felt unreadable — I couldn't see street names.

**DESIGNER:** Two separate causes. One: the Esri tiles label UK towns weakly at
mid-zoom — CARTO Voyager (Google-like styling, strong label hierarchy at every
zoom) is the best free choice; keyless Google itself isn't available. Two: nothing
was wrong with street names at high zoom — you could never GET to high zoom
usefully, because the vehicle blanket made you give up before zooming. Fix the
disclosure and the tiles both.

**USER:** How does a user even start? I don't want to pan from space every time.

**DESIGNER:** Products start with intent, not geography: a **search box**
("street, town, postcode…") and a **📍 Near me** button front and centre.
Nobody browses to their bus stop from national zoom.

**USER:** And when I click a bus, the popup is nice, but tiny.

**DESIGNER:** Keep the popup for now (it carries the journey + ETAs); the v2
upgrade is: selecting a vehicle highlights its route and dims the rest. Also:
one icon size fits nobody — icons must scale by zoom, and the pretty
double-decker earns its detail only when a bus is ~a street tall on screen.

**USER:** What do we cut?

**DESIGNER:** Rail-network overlay stays opt-in. London line polylines hide at
country zoom (they're a coloured smudge from space). Counter text moves to a
status chip. And a small **legend** so a first-time user knows what the shapes
mean without asking.

## Decisions applied (wave 1)
1. Base map → CARTO Voyager (best free label readability; Google needs a billed key).
2. Progressive disclosure by zoom — vehicles/lines/stations render from zoom 9;
   below that, live **city chips** with counts (click = fly there).
3. Search box (Nominatim, free) + 📍 Near me geolocation in the header.
4. Vehicle icons scale: 12 px (city) → 18 px (district) → 28 px (street),
   detailed bus art reserved for close zoom.
5. Legend chip on the map; counter kept but quieter.

## Next waves (not yet built)
- Select-a-vehicle → highlight its route, dim others, side journey panel.
- Marker clustering / density heat between zoom 9–11 in the densest cities.
- Route search that works nationally (needs a timetable index — BODS TransXChange).
- Nationwide stop-level ETAs (requires building an AVL↔timetable matching
  engine; England's open feed has positions only — significant, separate project).
- PWA wrapper (add-to-homescreen, offline shell).

---

# Session 2 — "I just want to catch my bus" (end-user × designer)

**END USER:** I don't care about maps. I need to know: will I make my 9am
meeting? When's the next bus from MY stop? I know nothing about transit data.

**DESIGNER:** Then stops are the product, not vehicles. A commuter's loop is:
find my stop → see the next 2-3 times per route → decide walk/run/coffee.
Today stops are invisible until you click the map — a hidden feature is a
missing feature. Fix: stops appear automatically at street zoom.

**END USER:** My stop serves four routes. I only care about the 73 and the 141.

**DESIGNER:** So a stop board must group by route: each route one row,
next two times side by side — "73 → Stoke Newington: 3 min, 11 min" — not one
mixed chronological list.

**END USER:** When I clicked a bus I got its stop list — good — but I wanted
to jump to one of those stops and see everything passing there.

**DESIGNER:** Agreed: every stop name anywhere in the UI is a link. Click →
fly to the stop, open its board. Vehicles link to stops, stops link to
vehicles' routes — navigation becomes a loop, not a dead end.

**END USER:** Where are the trains and ferries? And do other cities work?

**DESIGNER:** Honest state: every English city already has live buses (we
verified Birmingham 653, Leeds 293, Bristol 289 at this moment) — the user just
needs the map to say so (city chips do). London has trains/trams live; national
trains are one pending free key away; London river buses (Thames Clippers) are
in the same TfL feed and cost nothing to add — add them now with a boat icon.
Scotland/Wales buses are legally voluntary until ~2028: show what exists,
never pretend.

**END USER:** When I click a bus I want to see where it's going — the line.

**DESIGNER:** That's selection: click a vehicle → its whole route lights up,
everything else fades. One glance answers "does this bus go my way?"

## Decisions applied (wave 2)
1. Stops auto-appear at street zoom (London: full live boards; clickable, lettered).
2. Stop boards group by route → next 2 times per route.
3. Every stop name in a vehicle journey popup is clickable → fly + open board.
4. Click a vehicle → its route highlighted, all other lines dimmed (restores on close).
5. London river buses (ferries ⛴) added — same live pipeline, boat icon.
6. City chips stay as the "does my city work?" answer; England = yes everywhere.

## Explicitly out (kept honest)
- Stop-level live times outside London: England's open feed has no predictions;
  needs our own timetable-matching engine (wave 3 candidate, big).
- Scotland/Wales/NI gaps are upstream data policy, not app bugs.


---

# Session 3 — panels: what next + wider market (Jul 2026)

## End user × designer

USER: I open the app and get a map of the whole UK. I'm standing at my stop in the rain — I don't care about Aberdeen, where's MY bus?
DESIGNER: So launch shouldn't be a map at all. Geolocate instantly and show a "near me" board — nearest stops, next departures — with the map behind it.
USER: I take the same 192 every morning, same direction. Favouriting the stop shows twenty routes I never use.
DESIGNER: Favourites are the wrong grain — you commute on route+direction, not a stop. "192 towards Stockport from Stand B." Morning view shows just that: next three, with delay.
USER: Tuesday it said "4 min" and nothing came for 15. Now I trust nothing.
DESIGNER: We blend live, GPS-estimate and pure timetable and render them identically. Every time needs a plain word — Live / Estimated / Timetable only — and where operators give us nothing, say so instead of looking broken.
USER: When it says 6 min, can I tap it and watch the actual bus come?
DESIGNER: We already animate every vehicle; we just never linked board row to vehicle. One tap should fly the map to it. Cheap and huge.
USER: Two stops share one name across the road. I've boarded the wrong direction twice.
DESIGNER: NaPTAN has stand letters and bearings — "Stand B · towards City Centre" everywhere.
USER: Real ask: tell me when to LEAVE. Ping me at breakfast if the 07:42 is cancelled.
DESIGNER: No accounts needed — the PWA can do local push for favourites, and compute "leave by 07:31" from your walking distance.
USER: Trains — I sprint to the station board for the platform. You know it?
DESIGNER: Darwin gives us platforms and cancel reasons; they're buried in the journey view. Promote them to the board row.
USER: Night out — when's the LAST train home? Every app hides it.
DESIGNER: A "last one tonight 23:42" flag on boards. Small, loved.
USER: Your disruptions tab is everyone's problems. I want mine.
DESIGNER: Default it to favourites plus current area, toggle for all-UK.
USER: Phone use is one thumb on a moving platform. The sidebar buries the map, times are clock-times I have to do maths on.
DESIGNER: Bottom-sheet boards, thumb-size rows, "3 min" countdowns — that's the PWA pass.
USER: And honestly I just want "get me to my mate's place".
DESIGNER: Full journey planning is the big bet. Interim: pick a destination and we highlight which nearby stops reach it with no change — direct-services only. Multi-leg comes after the core loop is trustworthy.
USER: If opening it at my stop shows my bus, live, with a number I believe — I delete the other apps.

### Prioritised recommendations
1. **Launch to a geolocated 'Near me now' departures board** (medium) — The commuter's first question is 'when's my next one', not 'show me Britain'. Opening on a UK-level map costs taps and seconds every single use; nearest-stops board over a mini-map makes the daily loop instant and makes the map a supporting layer.
2. **Label every time with its source: Live / Estimated / Timetable** (small) — TfL-live, GPS-delay-adjusted and GPS-only-estimate times currently look identical, so one ghost bus destroys trust in all numbers. A plain-word chip per row, plus an honest banner in sparse Scotland/Wales regions ('operators here don't publish live tracking'), converts a perceived bug into understood behaviour.
3. **Tap a departure row to track that exact vehicle** (small) — The vehicle animation and the stop board are the product's two strengths but they aren't linked. 'It says 6 min — show me the bus' is the highest-emotion moment; the data already exists, it only needs a fly-to and an 'arriving in X' follow mode.
4. **Favourite at commute grain: route + direction + stop, with a morning dashboard** (medium) — Commuters repeat one exact service daily; stop-level favourites drown it in irrelevant routes. 'My 192 towards Stockport' showing the next three with delay status is the retention feature — the thing checked every day before leaving the house.
5. **Disambiguate paired stops: stand letter + 'towards X' everywhere** (small) — With 400k stops, same-name pairs across a road cause wrong-direction boardings — a catastrophic failure for the user. NaPTAN indicators and bearings are already ingested; surfacing them in search results, boards and map popups is cheap insurance.
6. **Promote platform and cancellation reason onto rail board rows** (small) — Darwin already supplies platforms and cancel reasons but they're buried in the per-journey view. Platform-at-a-glance is the number-one thing rail passengers sprint to station screens for; it should be on the departure row itself.
7. **Mobile bottom-sheet boards, thumb-size targets, minutes countdown** (medium) — The PWA pass must change interaction, not just viewport: sidebar and click-popups don't survive one-handed use on a platform. Bottom sheets for stop/vehicle detail and '3 min' countdowns (with clock time secondary) are the mobile-native grammar of every transit app users compare against.
8. **'Last one tonight' flag on boards and journey views** (small) — Missing the last train/bus is the highest-stakes moment in public transport and almost no app surfaces it proactively. GTFS timetables already contain it; a small badge after ~21:00 earns disproportionate loyalty.
9. **Default the disruptions tab to favourites + current area** (small) — A whole-UK disruption list is noise that trains users to ignore the tab. Filtering to saved services and the visible map area (with an all-UK toggle) makes it a personally relevant pre-departure check.
10. **'Leave by' time computed from walking distance to the stop** (medium) — Turns arrival data into the actual decision the user must make. With geolocation already granted, walking time at ~80m/min against the tracked vehicle's ETA yields 'leave by 07:31' — the single line that answers 'will I catch it'.
11. **PWA push alerts for favourite services (no account needed)** (large) — 'Ping me if my 07:42 is cancelled or 8+ min late' is the top unmet ask and pairs naturally with commute-grain favourites; service-worker push with local subscriptions preserves the no-accounts principle. Needs a small server-side checker, hence the effort.
12. **Planner-lite: pick a destination, highlight direct services to it** (large) — A full multi-leg A-to-B planner is the obvious gap but a huge build. Direct-services-only ('which stops near me reach Piccadilly with no change, next departures') covers most daily trips, reuses the GTFS data already loaded, and stakes the ground before committing to full routing.

## Marketing panel

**Positioning:** UK Transit Live is the free live map of Britain where every bus, train, tram and ferry visibly moves in its real colours and you can click any of them — or any of 400,000 stops — to see exactly where it is and how late it honestly is, no app, no account, no ads.

### Segments
- **Transport enthusiasts (train/bus spotters, network watchers)** — Watch the whole network move and identify specific vehicles — livery, formation, line — not just get an ETA → Whole-UK animated map with direction-facing SVG icons, real city livery colours (incl. Bee Network yellow), multi-car trains drawn at real formation length, and the collapsible network tree sidebar
- **People meeting someone off a bus or train (parents, carers, lift-givers)** — Know when the actual vehicle their person is on will reach a specific stop, without guessing from a scheduled time → Click-any-vehicle full journey view with per-stop expected times and a delay badge, plus shareable live stop boards
- **Tourists and domestic visitors in an unfamiliar city** — Understand what transport exists around them right now, with zero setup, app install, or account → Progressive-zoom whole-UK map with city chips, place search + geolocate, Thames ferries and trams visible alongside buses/trains — free, no accounts, no ads
- **Rural and small-town bus riders** — Confidence at low-frequency stops where missing one bus costs an hour and there is no live display at the stop → Live boards at all 400k NaPTAN stops: timetable + GPS-delay-adjusted times, with GPS-only estimate fallback when the feed is thin
- **Anxious or neurodivergent travellers who need certainty** — Visible proof the vehicle is really coming and honest warning when something is wrong, reducing wait-time stress → Watching the actual vehicle animate toward your stop, delay badges computed against the real GTFS timetable, and the disruptions-only tab with stated reasons
- **Rail regulars on disruption days** — Fast triage: which trains are cancelled, why, and which platform the survivor leaves from → Darwin-fed boards with platforms and cancellation reasons, disruptions-only tab, favourites dashboard refreshing every 30s
- **Transit advocates, local journalists, and council/bus-user-group people** — Evidence of how a route actually performs versus its published timetable → Per-stop delay computed against the actual GTFS timetable (not an opaque ETA), observable across every tracked vehicle
- **Ambient watchers: classrooms, model-rail clubs, office wall screens** — A beautiful live national picture to leave running — education and background fascination rather than a journey → Country-level view where the whole of Britain's transport animates at once with real liveries and line colours

### vs Google Maps
- **A-to-B journey planning** — Google: Core strength: multimodal routing, fares on some modes, walking legs, alternatives — best in class / Us: None (known gap) — we deliberately answer 'where is my vehicle' not 'how do I get there'
- **Live bus data in England** — Google: Parity on raw data since the April 2026 DfT deal put BODS live bus locations into Google Maps England-wide — shown inside directions/stop views / Us: Same BODS SIRI/GTFS-RT source, but every vehicle is visible and animated on an open map, not locked inside a routing flow
- **Whole-network live map** — Google: No free-roam vehicle map: you see live info only for the route/journey you asked about / Us: Genuine win: pan anywhere in GB and watch every tracked bus, coach, train, tram and ferry moving with direction-facing icons
- **Vehicle identity and detail** — Google: Generic transit icons; no liveries, no train length, no formation / Us: Real city livery colours, grey coaches, multi-car trains at true formation length, Tube line colours — the vehicle on screen looks like the one at the platform
- **Delay honesty** — Google: Black-box ETA; you cannot see what the delay is measured against / Us: Delay badge computed per stop against the actual GTFS timetable, with the full journey and expected times laid out
- **Rail departure boards** — Google: Live UK train times, but platform info is patchy and cancellation reasons rarely surfaced / Us: Darwin feed with platforms and cancellation reasons; TfL live boards in London; GPS-delay-adjusted timetable elsewhere
- **Disruption overview** — Google: Per-route alerts only, discovered when you plan a journey / Us: Dedicated disruptions-only tab with reasons — scan the whole network's problems in one place
- **Watching multiple stops at once** — Google: Saved places exist but no unified live board / Us: Favourites dashboard with 30s auto-refresh across all your stops and lines
- **Mobile experience** — Google: Polished native apps, offline maps, deep OS integration / Us: Honest weakness: desktop-first web app; mobile PWA in progress, no offline
- **Notifications and alerts** — Google: Departure and disruption notifications on supported trips / Us: None yet (known gap)
- **Coverage breadth** — Google: Global, plus everything else Maps does (places, driving, reviews) / Us: GB only; Scotland/Wales live buses sparse for both products (upstream data law, not a Google advantage)
- **Privacy and business model** — Google: Account-linked, location history fuels an ads business / Us: Free, no accounts, no ads, no tracking — nothing to sign up for and nothing sold

### Growth ideas
- Ship the mobile PWA with an 'Add to Home Screen' nudge — the product's natural viral moment is someone showing their phone at a bus stop, which desktop-first currently blocks
- Shareable deep links to a live vehicle or stop board ('track my bus' / 'my train, live') so people meeting someone can send one URL — every share recruits exactly the right next user
- Free embeddable live-board widget (iframe) for any stop, pitched to cafes, unis, village halls, community rail partnerships and parish council sites — each embed is distribution plus a backlink
- SEO the 400k NaPTAN stops as lightweight server-rendered 'live departures at [stop]' pages — long-tail stop-name search is precisely how bustimes.org built its audience
- Seed the enthusiast communities (RailUK forums, r/uktrains, r/transit, bustimes users, model-rail clubs) with the country-level 'watch all of Britain move' view — enthusiasts are the evangelists Google can never serve
- Add a one-click 'big screen / ambient mode' (auto-panning national view, no chrome) and market it as a wall display for offices, pubs, classrooms and stream backgrounds — screenshots of it are inherently shareable on social
- Storm/strike-day content: on major disruption days post a short capture of the disruptions tab and the map thinning out — timely, newsworthy, and demonstrates the product's unique view in 10 seconds
- Write up the data engineering (taming BODS SIRI, Darwin quirks, GTFS-RT delay computation, 400k-stop rendering) for Hacker News / dev blogs — hobby-product traffic spikes and potential contributors come from build-in-public posts
- Zero-infra notifications: per-favourite RSS/iCal feed or a small Telegram/Discord bot for delay alerts — plugs the notifications gap without running push infrastructure
- A 'this week on the network' auto-generated stats page (most delayed routes, punctuality by operator, computed from the GTFS-vs-actual data already collected) — journalists and advocates will cite and link it

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

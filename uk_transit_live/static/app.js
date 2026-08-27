/* UK Transit Live — frontend with continuous live vehicle motion.
 *
 * Motion model: TfL arrivals tell us, per vehicle, its next stop and the
 * seconds until it gets there. We place the vehicle on the segment
 * (previous stop -> next stop) and, every animation frame, advance it toward
 * the next stop using the wall clock — so it glides between the ~25s polls
 * instead of teleporting. Each poll re-targets it. Trains, trams, DLR,
 * Overground, Elizabeth line and (per selected route) buses all use this one
 * pipeline. Live GPS buses (BODS) are a separate real-coordinate layer.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const LONDON = [51.507, -0.118];
const UK = [54.4, -2.8];
const clock = () => performance.now();

const state = {
  config: { tflKeyed: false, darwin: false, bods: false },
  lines: [],                 // [{id,name,mode,colour}] London rail lines
  visible: new Set(),        // London rail line ids drawn + tracked
  tracked: new Map(),        // lineId -> geometry (all animated lines incl. bus routes)
  geomLayers: {},            // lineId -> L.LayerGroup (paths + station dots)
  vehicles: new Map(),       // "lineId|vehicleId" -> vehicle anim state + marker
  vehicleLayer: null,
  busLines: new Set(),       // selected bus route line ids (tracked + drawn)
  busRouteLayer: null,
  busStopLayer: null,
  bodsLayer: null,
  bodsOn: true,              // whole-UK buses on by default (national feed is keyless)
  busTotal: 0,
  busShown: 0,
  modeByLine: {},            // lineId -> mode (tube/tram/...)
  seqs: { tfl: 0, nr: 0, bods: 0, ghost: 0 },   // per-family poll counters for vehicle cleanup
  nrOn: true,                // national rail trains (works once Darwin key added)
  railStationLayer: null,
  ormLayer: null,            // OpenRailwayMap overlay
  board: { stopId: null, timer: null },
  railCrs: null,
  railTimer: null,
  stations: [],
};

/* ---------- touch sizing ----------
   Leaflet hit-tests a circleMarker against its drawn radius, so a 3px dot that
   is fine with a mouse is essentially untappable with a fingertip. Scale every
   marker radius up on touch devices - the dots read slightly larger, which is
   the right trade on a phone. */
const TOUCH = window.matchMedia("(pointer: coarse)").matches;
const tapR = (r) => (TOUCH ? r * 2.1 : r);

/* ---------- map ---------- */
const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView(UK, 6);

// Popups auto-pan into view, but Leaflet knows nothing about the Dynamic
// Island or the floating map bar, so a long calling-point list would open
// underneath both. Reserve that space.
(function safeAreaPopups() {
  const css = getComputedStyle(document.documentElement);
  const safeTop = parseInt(css.getPropertyValue("--safe-top")) || 0;
  const topPad = TOUCH ? 74 + safeTop : 20;
  L.Popup.mergeOptions({
    autoPanPaddingTopLeft: L.point(14, topPad),
    autoPanPaddingBottomRight: L.point(14, TOUCH ? 90 : 30),
  });
})();
// CARTO Voyager: Google-like styling with the strongest free label hierarchy
// (city/region names readable at every zoom; Google's own tiles need a billed key).
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 19,
}).addTo(map);

// Progressive disclosure: below this zoom we show live city chips, not vehicles.
const DETAIL_ZOOM = 9;
const cityChipLayer = L.layerGroup().addTo(map);
const CITIES = [
  ["London", 51.507, -0.118], ["Birmingham", 52.480, -1.902], ["Manchester", 53.481, -2.242],
  ["Leeds", 53.800, -1.549], ["Sheffield", 53.381, -1.470], ["Liverpool", 53.408, -2.992],
  ["Newcastle", 54.978, -1.617], ["Bristol", 51.454, -2.588], ["Nottingham", 52.955, -1.149],
  ["Leicester", 52.637, -1.140], ["Southampton", 50.910, -1.404], ["Brighton", 50.823, -0.138],
  ["Plymouth", 50.376, -4.143], ["Norwich", 52.628, 1.297], ["Hull", 53.746, -0.336],
  ["Cardiff", 51.482, -3.179], ["Glasgow", 55.864, -4.252], ["Edinburgh", 55.953, -3.189],
];

// Whole-GB rail network overlay (keyless, OpenRailwayMap). OFF by default —
// it adds a lot of ink; toggle it on from the National Rail tab.
state.ormLayer = L.tileLayer("https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
  attribution: '<a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC-BY-SA)',
  maxZoom: 19, opacity: 0.55,
});

// Mobile drawer: the sidebar slides in/out behind a hamburger button.
// body.navopen hides the floating map bar while the sidebar is over it -
// otherwise the ☰ button sits on top of the sidebar's own heading.
function setNav(open) {
  document.getElementById("sidebar").classList.toggle("open", open);
  document.body.classList.toggle("navopen", open);
}
$("menubtn").onclick = () => setNav(!document.getElementById("sidebar").classList.contains("open"));
if ($("sideclose")) $("sideclose").onclick = () => setNav(false);
// Tapping the map auto-closes the drawer. This MUST go through setNav:
// removing .open directly leaves body.navopen set, which keeps the floating
// map bar hidden - the menu button and search box vanish with no way back.
// If you pan or zoom yourself, the pending background GPS fix must not
// snatch the map back - a map that moves under your finger is worse than
// one that opens in the wrong place.
map.on("dragstart zoomstart", () => { state._userMoved = true; });

map.on("click popupopen", () => {
  if (window.innerWidth <= 480) setNav(false);
});

$("ukbtn").onclick = () => map.setView(UK, 6);
$("londonbtn").onclick = () => map.setView(LONDON, 12);

// Progressive disclosure: what renders depends on zoom.
//   < 9   country view — city chips only, no vehicles/lines
//   9-12  city view    — small icons (12px)
//   13-14 district     — medium icons (18px)
//   15+   street       — full-detail icons (28px)
const LONDON_ZONES = [
  ["Westminster", 51.4975, -0.1357], ["City of London", 51.5155, -0.092],
  ["Camden", 51.539, -0.142], ["Hackney", 51.545, -0.055],
  ["Stratford", 51.541, -0.003], ["Greenwich", 51.482, 0.005],
  ["Southwark", 51.475, -0.08], ["Brixton", 51.462, -0.115],
  ["Wandsworth", 51.457, -0.192], ["Hammersmith", 51.492, -0.223],
  ["Ealing", 51.513, -0.305], ["Wembley", 51.556, -0.28],
  ["Islington", 51.545, -0.105], ["Ilford", 51.559, 0.08],
  ["Croydon", 51.372, -0.098], ["Kingston", 51.412, -0.30],
  ["Wimbledon", 51.421, -0.207], ["Lewisham", 51.462, -0.01],
];
const inLondonBox = (lat, lon) => lat > 51.25 && lat < 51.72 && lon > -0.6 && lon < 0.35;

function londonMidView() {
  const z = map.getZoom();
  if (z < DETAIL_ZOOM || z >= 13) return false;
  const b = map.getBounds();
  return b.getSouth() < 51.72 && b.getNorth() > 51.25 && b.getWest() < 0.35 && b.getEast() > -0.6;
}

// Borough-level summary chips: London at mid zoom is thousands of vehicles —
// summarise per area (like the country view) and reveal individuals from z13.
function renderLondonZones() {
  cityChipLayer.clearLayers();
  const t0 = clock();
  const counts = LONDON_ZONES.map(() => ({ bus: 0, train: 0, tram: 0, boat: 0 }));
  for (const v of state.vehicles.values()) {
    const pos = positionOf(v, t0);
    if (!inLondonBox(pos[0], pos[1])) continue;
    let bi = -1, bd = 0.05;
    for (let i = 0; i < LONDON_ZONES.length; i++) {
      const d = Math.hypot(pos[0] - LONDON_ZONES[i][1], (pos[1] - LONDON_ZONES[i][2]) * 0.62);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi < 0) continue;
    const k = v.kind === "coach" ? "bus" : (v.kind || "train");
    if (counts[bi][k] != null) counts[bi][k]++;
  }
  LONDON_ZONES.forEach(([name, la, lo], i) => {
    const c = counts[i];
    const parts = [c.bus ? `${c.bus} 🚌` : "", c.train ? `${c.train} 🚆` : "",
                   c.tram ? `${c.tram} 🚊` : "", c.boat ? `${c.boat} ⛴` : ""].filter(Boolean).join(" ");
    if (!parts) return;
    const m = L.marker([la, lo], {
      icon: L.divIcon({ className: "chipwrap",
        html: `<div class="citychip">${escapeHtml(name)}<span>${parts}</span></div>`, iconSize: null }),
      keyboard: false,
    });
    m.on("click", () => map.setView([la, lo], 14));
    m.addTo(cityChipLayer);
  });
}

function toggleLayer(l, want) {
  if (!l) return;
  const has = map.hasLayer(l);
  if (want && !has) l.addTo(map);
  if (!want && has) map.removeLayer(l);
}

function syncZoomUI() {
  const z = map.getZoom();
  document.body.classList.toggle("zl-s", z >= DETAIL_ZOOM && z < 13);
  document.body.classList.toggle("zl-m", z >= 13 && z < 15);
  const detail = z >= DETAIL_ZOOM;
  toggleLayer(state.vehicleLayer, detail);
  toggleLayer(state.busRouteLayer, detail);
  toggleLayer(state.busStopLayer, detail);
  if (detail && !londonMidView()) cityChipLayer.clearLayers();
  if (londonMidView()) renderLondonZones();
  syncMarkers();
  updateCounter();
}
map.on("zoomend", syncZoomUI);
syncZoomUI();

// Place search (Nominatim, free) + geolocation — users start from intent,
// not from panning across Britain.
$("placesearch").addEventListener("keydown", (e) => { if (e.key === "Enter") searchPlace(); });
$("placego").onclick = searchPlace;
/* ---------- "where am I": a live blue dot, like Google Maps ----------
   getCurrentPosition alone jumps the map once and forgets you. watchPosition
   keeps the dot following you, which is what makes it useful while actually
   travelling. The accuracy ring is drawn from the browser's own estimate, so
   a poor GPS fix looks uncertain rather than falsely precise. */
let _userDot = null, _userRing = null, _watchId = null;

// Remember where you were, so the next visit can open there instantly without
// waiting on - or re-prompting for - GPS. iOS re-asks permission per session in
// a normal Safari tab, which is what made it feel like it "keeps asking".
const LAST_POS_KEY = "ukt.lastpos";
function saveLastPos(lat, lon) {
  try { localStorage.setItem(LAST_POS_KEY, JSON.stringify({ lat, lon, t: Date.now() })); }
  catch {}
}
function loadLastPos() {
  try {
    const p = JSON.parse(localStorage.getItem(LAST_POS_KEY) || "null");
    // A month-old fix is still a better first view than the whole of Britain.
    if (p && Date.now() - p.t < 30 * 864e5) return p;
  } catch {}
  return null;
}

function drawUserPos(lat, lon, accuracy) {
  state.userPos = [lat, lon];
  saveLastPos(lat, lon);
  if (!_userDot) {
    _userRing = L.circle([lat, lon], {
      radius: accuracy || 0, color: "#1a73e8", weight: 1,
      fillColor: "#1a73e8", fillOpacity: 0.12, interactive: false,
    }).addTo(map);
    _userDot = L.marker([lat, lon], {
      icon: L.divIcon({ className: "userdot-wrap", html: '<div class="userdot"></div>',
                        iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false, zIndexOffset: 10000,
    }).addTo(map);
  } else {
    _userDot.setLatLng([lat, lon]);
    _userRing.setLatLng([lat, lon]).setRadius(accuracy || 0);
  }
}

function locateMe(el) {
  if (!navigator.geolocation) {
    showLocError("This browser has no location support.");
    return;
  }
  if (el) el.classList.add("on");
  navigator.geolocation.getCurrentPosition(
    (p) => {
      drawUserPos(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
      // Locate zoom: the user tried 17/16/15/14 and settled on 12 - the
      // whole-town view. (Tile scale runs ~12 town, 14 district, 15
      // neighbourhood, 16 streets, 17+ buildings.)
      map.setView(state.userPos, Math.max(map.getZoom(), 12));
      if (_watchId === null) {
        _watchId = navigator.geolocation.watchPosition(
          (q) => drawUserPos(q.coords.latitude, q.coords.longitude, q.coords.accuracy),
          () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
      }
    },
    (err) => {
      if (el) el.classList.remove("on");
      showLocError(err && err.code === 1
        ? "Location permission denied — enable it in Settings ▸ Safari ▸ Location."
        : "Couldn't get your location.");
    },
    { timeout: 10000, enableHighAccuracy: true });
}

function showLocError(msg) {
  const html = `<div class="empty">${msg}</div>`;
  const m = $("mapresults"); if (m) { m.innerHTML = html; setTimeout(() => { m.innerHTML = ""; }, 5000); }
  const p = $("placeresults"); if (p) p.innerHTML = html;
}

$("locbtn").onclick = () => locateMe($("locbtn"));

// Shared by the sidebar search and the floating map bar, so both behave
// identically instead of drifting apart.
async function searchPlace(inputId = "placesearch", outId = "placeresults") {
  const q = $(inputId).value.trim();
  if (!q) return;
  const el = $(outId);
  el.innerHTML = '<div class="empty">Searching…</div>';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=gb&limit=5&q=${encodeURIComponent(q)}`);
    const res = await r.json();
    el.innerHTML = "";
    if (!res.length) { el.innerHTML = '<div class="empty">No matches in the UK.</div>'; return; }
    for (const m of res) {
      const d = document.createElement("div");
      d.className = "busmatch";
      d.textContent = m.display_name.split(",").slice(0, 3).join(",");
      d.onclick = () => {
        map.setView([+m.lat, +m.lon], 15);
        el.innerHTML = "";
        $(inputId).blur();          // dismiss the iOS keyboard so the map is visible
      };
      el.appendChild(d);
    }
  } catch { el.innerHTML = '<div class="empty">Search failed — try again.</div>'; }
}

/* ---------- floating map bar (mobile) ---------- */
if ($("mapsearch")) {
  $("mapsearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { searchPlace("mapsearch", "mapresults"); $("mapsearch").blur(); }
  });
  $("maploc").onclick = () => locateMe($("maploc"));
  // Tapping the map should clear a stale result list rather than leaving it
  // floating over the thing you just tried to look at.
  map.on("click", () => { const m = $("mapresults"); if (m) m.innerHTML = ""; });
}

// Leaflet can measure the flex container as 0x0 if it lays out before CSS
// settles — re-measure on load and whenever the pane resizes.
window.addEventListener("load", () => map.invalidateSize());
requestAnimationFrame(() => map.invalidateSize());
new ResizeObserver(() => map.invalidateSize()).observe($("map"));

state.vehicleLayer = L.layerGroup().addTo(map);
state.busRouteLayer = L.layerGroup().addTo(map);
state.busStopLayer = L.layerGroup().addTo(map);
state.bodsLayer = L.layerGroup().addTo(map);

/* ---------- helpers ---------- */
async function api(path) {
  const r = await fetch(path);
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
// Dense-city discipline: buses are capped by zoom (stable sample, no flicker);
// trains/trams/boats always render in full — they are few and load-bearing.
function busCapForZoom(z) { return z >= 13 ? Infinity : z >= 11 ? 600 : 250; }
function nowSecsLondon() {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return g("hour") * 3600 + g("minute") * 60 + g("second");
}
function dueText(sec) {
  if (sec == null) return "—";
  if (sec < 45) return "due";
  return `${Math.round(sec / 60)} min`;
}
function sevClass(sev) {
  if (sev === 10) return "good";
  if (sev >= 8 || sev === 0) return "minor";
  return "bad";
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------- London line status list ---------- */
async function loadStatus() {
  const status = await api("/api/status");
  state.lines = status;
  for (const l of status) state.modeByLine[l.id] = l.mode;
  renderLineList(status);
  renderDisruptions();
}

// Problems-only view: the most reassuring screen in a transit app is an empty one.
function renderDisruptions() {
  const el = $("disrlist");
  if (!el) return;
  const bad = state.lines.filter((l) => l.severity !== 10);
  const badge = document.querySelector('.tab[data-tab="disr"]');
  if (badge) badge.textContent = bad.length ? `⚠ ${bad.length}` : "⚠";
  if (!bad.length) {
    el.innerHTML = '<div class="okmsg">✅ No reported disruptions on the London network right now.</div>';
    return;
  }
  bad.sort((a, b) => a.severity - b.severity);
  el.innerHTML = bad.map((l) => `
    <div class="linerow" style="cursor:default">
      <div class="chip" style="background:${escapeHtml(l.colour)}"></div>
      <div class="linemeta">
        <div class="linename">${escapeHtml(l.name)}</div>
        ${l.reason ? `<div class="reason">${escapeHtml(l.reason)}</div>` : ""}
      </div>
      <div class="sev ${sevClass(l.severity)}">${escapeHtml(l.severityText)}</div>
    </div>`).join("");
}

/* The sidebar network tree: collapsible groups per system/mode.
 *   National Rail (tracked-train count)
 *   London network -> Metro / Train / Tram / Ferry (line rows with status)
 *   Cities - live buses (fly-to rows with live counts)
 * Click a group header to open/close; click a line row to show its route. */
state.treeOpen = state.treeOpen || new Set(["nr", "cities", "london", "tube"]);

function renderLineList(status) {
  const el = $("linelist");
  if (!el) return;
  status.sort((a, b) => a.name.localeCompare(b.name));

  const rowH = (l) => {
    const starred = state.favs && state.favs.lines.includes(l.id);
    return `
      <div class="linerow" data-line="${escapeHtml(l.id)}">
        <div class="chip" style="background:${escapeHtml(l.colour)}"></div>
        <div class="linemeta">
          <div class="linename">${escapeHtml(l.name)}</div>
          ${l.reason ? `<div class="reason">${escapeHtml(l.reason)}</div>` : ""}
        </div>
        <div class="sev ${sevClass(l.severity)}">${escapeHtml(l.severityText)}</div>
        <span class="star ${starred ? "on" : ""}" data-star="${escapeHtml(l.id)}">${starred ? "\u2605" : "\u2606"}</span>
      </div>`;
  };
  const grpH = (key, title, inner, badge) => {
    const open = state.treeOpen.has(key);
    return `<div class="tgroup${open ? " open" : ""}" data-grp="${escapeHtml(key)}">
      <div class="thead"><span class="tarrow">${open ? "\u25be" : "\u25b8"}</span><span class="ttitle">${title}</span>${badge || ""}</div>
      <div class="tbody">${inner}</div></div>`;
  };
  const mk = (key, title, modes) => {
    const ls = status.filter((l) => modes.includes(l.mode));
    const bad = ls.filter((x) => x.severity !== 10).length;
    return grpH(key, `${title} (${ls.length})`,
      ls.map(rowH).join(""),
      bad ? ` <span class="sev bad" style="margin-left:6px">\u26a0 ${bad}</span>` : "");
  };

  let nr = 0;
  for (const k of state.vehicles.keys()) if (k.startsWith("nr|")) nr++;
  // live vs scheduled (non-GPS) — honest split, counted from the live model
  let liveBus = 0, ghostBus = 0;
  for (const v of state.vehicles.values()) {
    if (v.family === "bods") liveBus++;
    else if (v.family === "ghost") ghostBus++;
  }
  const natLive = state.busTotal || 0;
  const cityRows = CITIES.map(([name, la, lo]) => {
    const n = state.cityCounts && state.cityCounts[name];
    return `<div class="linerow cityrow" data-city="${la},${lo}">
      <div class="linemeta"><div class="linename">${escapeHtml(name)}</div></div>
      <div class="citycount">${n ? "≈" + n.toLocaleString() + " 🚌" : ""}</div></div>`;
  }).join("");

  const TOC_COLOURS = { "Avanti West Coast": "#00494f", "LNER": "#ce0e2d", "Great Western Railway": "#0a493e",
    "CrossCountry": "#b7245c", "Northern": "#262262", "ScotRail": "#1e4d8c", "TransPennine Express": "#09a4ec",
    "East Midlands Railway": "#703e6f", "West Midlands Trains": "#9d6812", "LNR & WMR": "#9d6812",
    "Southeastern": "#389cff", "Southern": "#8cc63e", "Thameslink": "#e9438d", "Great Northern": "#0099a9",
    "Greater Anglia": "#d70428", "c2c": "#b7007c", "Chiltern Railways": "#00bfff", "South Western Railway": "#24398c",
    "Transport for Wales": "#ff4500", "Caledonian Sleeper": "#1d2e5b", "Merseyrail": "#fff200", "Elizabeth Line": "#6950a1",
    "London Overground": "#ee7623", "Heathrow Express": "#532e63", "Grand Central": "#1f1a17", "Hull Trains": "#de005c",
    "Lumo": "#2b6ef5", "Island Line": "#24398c" };
  const opCounts = new Map();
  for (const v of state.vehicles.values()) {
    if (v.family === "nr") opCounts.set(v.label, (opCounts.get(v.label) || 0) + 1);
  }
  const opsSorted = [...opCounts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = state.showAllOps ? opsSorted : opsSorted.slice(0, 6);
  const opRows = shown.map(([op, n]) => `
    <div class="linerow oprow${state.opDim === op ? " opsel" : ""}" data-op="${escapeHtml(op)}">
      <div class="chip" style="background:${escapeHtml(TOC_COLOURS[op] || "#5b6773")}"></div>
      <div class="linemeta"><div class="linename">${escapeHtml(op)}</div></div>
      <div class="citycount">${n}</div>
    </div>`).join("") +
    (opsSorted.length > 6 && !state.showAllOps
      ? `<div class="linerow" data-allops="1"><div class="linemeta"><div class="reason">Show all ${opsSorted.length} operators…</div></div></div>` : "");

  el.innerHTML =
    grpH("nr", `\🚄 National Rail — ${nr} trains · live data`,

      '<div class="hint" style="padding:4px 8px 6px">Click any train for its route, calling points and delay. Solid = live data (position estimated between stations — the railway publishes no GPS).</div>'
      + '<div class="hint" style="padding:0 8px 4px;font-weight:600">By operator</div>' + opRows) +
    grpH("cities", "🌇 Cities — Bus / Tram / Metro",
      `<div class="gpsline"><span class="livechip">● live GPS</span> ${natLive.toLocaleString()} buses across England` +
      (liveBus + ghostBus ? `<br><span style="opacity:.75">in current view: ${liveBus.toLocaleString()} live · ${ghostBus.toLocaleString()} scheduled (translucent — no GPS published)</span>` : "") + "</div>" +
      grpH("london", "London — full network",
        mk("tube", "Ⓜ Metro — Underground", ["tube"]) +
        mk("lrail", "🚆 Train — Elizabeth · DLR · Overground", ["elizabeth-line", "dlr", "overground"]) +
        mk("tram", "🚊 Tram", ["tram"]) +
        mk("ferry", "⛴ Ferry — river bus", ["river-bus"])) +
      '<div class="hint" style="padding:6px 8px 4px">Other cities — tap to fly there:</div>' + cityRows);
}

// One delegated handler wires the whole tree.
$("linelist").addEventListener("click", (ev) => {
  const star = ev.target.closest("[data-star]");
  if (star) {
    const id = star.dataset.star;
    state.favs.lines = state.favs.lines.includes(id)
      ? state.favs.lines.filter((x) => x !== id)
      : [...state.favs.lines, id];
    saveFavs();
    return;
  }
  const head = ev.target.closest(".thead");
  if (head) {
    const g = head.parentElement.dataset.grp;
    if (state.treeOpen.has(g)) state.treeOpen.delete(g);
    else state.treeOpen.add(g);
    renderLineList(state.lines);
    return;
  }
  const allops = ev.target.closest("[data-allops]");
  if (allops) { state.showAllOps = true; renderLineList(state.lines); return; }
  const oprow = ev.target.closest(".oprow");
  if (oprow) {
    const op = oprow.dataset.op;
    state.opDim = state.opDim === op ? null : op;
    const pts = [];
    for (const v of state.vehicles.values()) {
      if (v.family !== "nr") continue;
      const el2 = v.marker && v.marker.getElement();
      if (el2) el2.style.opacity = (!state.opDim || v.label === state.opDim) ? "" : "0.14";
      if (state.opDim && v.label === state.opDim) pts.push([v.b.lat, v.b.lon]);
    }
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { animate: false });
    renderLineList(state.lines);
    return;
  }
  const city = ev.target.closest(".cityrow");
  if (city) {
    const [la, lo] = city.dataset.city.split(",");
    map.setView([+la, +lo], 12);
    return;
  }
  const row = ev.target.closest(".linerow[data-line]");
  if (row) {
    const id = row.dataset.line;
    if (highlighted === id) clearHighlight();
    else highlightRoute(id);
  }
});

async function toggleLine(id) {
  if (state.visible.has(id)) {
    state.visible.delete(id);
    await untrack(id);
    if (state.geomLayers[id]) { map.removeLayer(state.geomLayers[id]); delete state.geomLayers[id]; }
  } else {
    state.visible.add(id);
    await track(id, false);
  }
  renderLineList(state.lines);
  pollVehicles();
}

/* ---------- geometry + tracking ---------- */
async function track(id, isBus) {
  if (!state.tracked.has(id)) {
    const g = await api(`/api/geometry/${id}`).catch(() => null);
    if (!g) return;
    state.tracked.set(id, g);
  }
  drawGeometry(id, isBus);
}

async function untrack(id) {
  state.tracked.delete(id);
  for (const [key, v] of state.vehicles) {
    if (key.startsWith(`tfl|${id}|`)) { state.vehicleLayer.removeLayer(v.marker); state.vehicles.delete(key); }
  }
}

function drawGeometry(id, isBus) {
  if (state.geomLayers[id]) { state.geomLayers[id].addTo(map); return; }
  const g = state.tracked.get(id);
  const grp = L.layerGroup();
  for (const path of g.paths) {
    L.polyline(path, { color: g.colour, weight: isBus ? 4 : 3, opacity: 0.8 }).addTo(grp);
  }
  for (const s of g.stations) {
    if (s.lat == null) continue;
    const m = L.circleMarker([s.lat, s.lon], {
      radius: tapR(isBus ? 3 : 3.5), color: "#fff", weight: 1, fillColor: g.colour, fillOpacity: 1,
    }).addTo(grp);
    m.bindTooltip(escapeHtml(s.name), { direction: "top", opacity: 0.9 });
    m.on("click", () => openBoard(s.naptan || s.id, s.name, s.lat, s.lon));
  }
  state.geomLayers[id] = grp;
  // Lines are never shown by default — a route appears only when the user
  // clicks a vehicle (or a line row / bus-route search) via highlightRoute.
}

async function initialLines() {
  const ids = state.lines.map((l) => l.id);
  for (const id of ids) state.visible.add(id);
  const chunk = 5;
  for (let i = 0; i < ids.length; i += chunk) {
    await Promise.all(ids.slice(i, i + chunk).map((id) => track(id, false).catch(() => {})));
  }
  renderLineList(state.lines);
}

/* ---------- vehicle position model ---------- */
function stationOf(geom, id) {
  return geom.stations.find((s) => s.id === id || s.naptan === id);
}

function prevStation(geom, stationId, direction) {
  // Prefer a sequence matching the reported direction; fall back to any.
  const seqs = geom.sequences.filter((s) => !direction || !s.direction || s.direction === direction);
  for (const seq of (seqs.length ? seqs : geom.sequences)) {
    const i = seq.stops.indexOf(stationId);
    if (i > 0) {
      const p = stationOf(geom, seq.stops[i - 1]);
      if (p && p.lat != null) return p;
    }
  }
  return null;
}

// One animation pipeline, three data families: "tfl" (London arrivals-derived),
// "nr" (national Darwin calling-point-derived) and "bods" (bus GPS). Families
// are polled and cleaned up independently so one feed's gap never wipes the
// other's markers. Vehicles render as small mode icons (🚇🚆🚊🚌) that glide.
// --- vehicle glyphs: little side-view vehicles with shadow + two-tone body ---
function shade(hex, f) {
  // f > 0 lightens toward white, f < 0 darkens toward black
  const n = parseInt(hex.slice(1), 16);
  const ch = (x) => Math.max(0, Math.min(255, Math.round(f > 0 ? x + (255 - x) * f : x * (1 + f))));
  const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function busSvg(colour) {
  const c = colour || "#c8102e";
  // Light liveries (Bee Network yellow etc.) get black skirt/outline — like the
  // real paint scheme, and it keeps the icon readable on pale map roads.
  const light = luminance(c) > 0.6;
  const trim = light ? "#1a1a1a" : shade(c, -0.35);
  const roof = light ? shade(c, -0.10) : shade(c, 0.28);
  return `<svg class="vsvg" viewBox="0 0 40 22">
    <ellipse cx="20" cy="19.6" rx="15" ry="2" fill="rgba(0,0,0,.30)"/>
    <rect x="2" y="1.5" width="36" height="16" rx="2.5" fill="${c}" stroke="${light ? "#1a1a1a" : "rgba(0,0,0,.35)"}" stroke-width="0.9"/>
    <path d="M2 4 a2.5 2.5 0 0 1 2.5-2.5 h31 a2.5 2.5 0 0 1 2.5 2.5 v5 h-36 z" fill="${roof}"/>
    <rect x="4.5" y="3.2" width="5" height="4" rx="0.8" fill="#cfe8fa"/>
    <rect x="11" y="3.2" width="5" height="4" rx="0.8" fill="#cfe8fa"/>
    <rect x="17.5" y="3.2" width="5" height="4" rx="0.8" fill="#cfe8fa"/>
    <rect x="24" y="3.2" width="5" height="4" rx="0.8" fill="#cfe8fa"/>
    <rect x="4.5" y="10" width="5" height="4.5" rx="0.8" fill="#cfe8fa"/>
    <rect x="11" y="10" width="5" height="4.5" rx="0.8" fill="#cfe8fa"/>
    <rect x="17.5" y="10" width="5" height="4.5" rx="0.8" fill="#cfe8fa"/>
    <rect x="30.5" y="9.5" width="6" height="5.5" rx="0.8" fill="#cfe8fa"/>
    <rect x="2" y="15.6" width="36" height="1.9" fill="${trim}"/>
    <circle cx="10" cy="18" r="2.5" fill="#1a1a1a"/><circle cx="10" cy="18" r="1" fill="#8a8a8a"/>
    <circle cx="29" cy="18" r="2.5" fill="#1a1a1a"/><circle cx="29" cy="18" r="1" fill="#8a8a8a"/>
  </svg>`;
}

// Trains render car-by-car: real formation length where the data provides it
// (Darwin publishes coach counts), sensible defaults otherwise.
function trainSvg(colour, cars) {
  const n = clamp(cars || 4, 2, 9);
  const CW = 18, GAP = 1.5;
  const w = n * CW + (n - 1) * GAP + 8;
  let body = "";
  for (let i = 0; i < n; i++) {
    const x = 4 + i * (CW + GAP);
    const nose = i === n - 1
      ? `<path d="M${x + CW - 4} 3.2 h2.2 q3.2 0 4.4 4.4 l0.8 3.4 h-7.4 z" fill="${colour}" stroke="#6E7880" stroke-width="0.7"/>`
      : "";
    body += `
      ${i > 0 ? `<rect x="${x - GAP - 0.4}" y="7" width="${GAP + 0.8}" height="2.4" fill="#5c646c"/>` : ""}
      <rect x="${x}" y="3" width="${CW - (i === n - 1 ? 3 : 0)}" height="8.4" rx="1.8" fill="${colour}" stroke="#6E7880" stroke-width="0.9"/>
      ${nose}
      <rect x="${x + 2}" y="5" width="${CW - (i === n - 1 ? 8 : 4.5)}" height="2.6" rx="0.8" fill="#3A424A"/>
      <circle cx="${x + 4}" cy="12.6" r="1.7" fill="#23282d"/>
      <circle cx="${x + CW - (i === n - 1 ? 7 : 4.5)}" cy="12.6" r="1.7" fill="#23282d"/>`;
  }
  return `<svg class="vsvg vsvg-train" style="--cars:${n}" viewBox="0 0 ${w} 16">
    <ellipse cx="${w / 2}" cy="14.3" rx="${w / 2 - 3}" ry="1.6" fill="rgba(0,0,0,.28)"/>${body}
  </svg>`;
}

// Coaches (National Express, Megabus, Flixbus…): long single-decker in grey.
function coachSvg(colour) {
  const c = colour || "#7C8690";
  return `<svg class="vsvg" viewBox="0 0 44 20">
    <ellipse cx="22" cy="18" rx="17" ry="1.8" fill="rgba(0,0,0,.28)"/>
    <rect x="2" y="3" width="40" height="13" rx="3" fill="${c}" stroke="#4e565e" stroke-width="0.8"/>
    <path d="M2 6 a3 3 0 0 1 3-3 h34 a3 3 0 0 1 3 3 v2 h-40 z" fill="${shade(c, 0.25)}"/>
    <rect x="4.5" y="4.8" width="6" height="4" rx="0.9" fill="#cfe8fa"/>
    <rect x="12" y="4.8" width="6" height="4" rx="0.9" fill="#cfe8fa"/>
    <rect x="19.5" y="4.8" width="6" height="4" rx="0.9" fill="#cfe8fa"/>
    <rect x="27" y="4.8" width="6" height="4" rx="0.9" fill="#cfe8fa"/>
    <rect x="35" y="4.8" width="5" height="6.5" rx="0.9" fill="#cfe8fa"/>
    <rect x="4" y="10.5" width="29" height="3.4" rx="0.7" fill="${shade(c, -0.25)}"/>
    <circle cx="10" cy="16.3" r="2.3" fill="#1a1a1a"/><circle cx="33" cy="16.3" r="2.3" fill="#1a1a1a"/>
  </svg>`;
}

function tramSvg(colour) {
  return `<svg class="vsvg" viewBox="0 0 36 19">
    <ellipse cx="18" cy="17" rx="14" ry="1.7" fill="rgba(0,0,0,.30)"/>
    <path d="M13 4 L20 1 L20 4" fill="none" stroke="#555" stroke-width="1"/>
    <rect x="3" y="4" width="30" height="11.5" rx="3" fill="${colour}"/>
    <rect x="3" y="4" width="30" height="4.5" rx="3" fill="rgba(255,255,255,.28)"/>
    <rect x="5.5" y="6.5" width="6" height="4.5" rx="1" fill="#eaf4fb"/>
    <rect x="14" y="6.5" width="6" height="4.5" rx="1" fill="#eaf4fb"/>
    <rect x="22.5" y="6.5" width="8" height="4.5" rx="1" fill="#eaf4fb"/>
    <circle cx="10" cy="15.7" r="1.8" fill="#1a1a1a"/><circle cx="26" cy="15.7" r="1.8" fill="#1a1a1a"/>
  </svg>`;
}

function boatSvg(colour) {
  return `<svg class="vsvg" viewBox="0 0 40 20">
    <ellipse cx="20" cy="18" rx="15" ry="1.8" fill="rgba(0,0,0,.25)"/>
    <path d="M4 11 h32 l-4 5 q-1 1.2-2.6 1.2 h-19 q-1.6 0-2.6-1.2 z" fill="${colour}"/>
    <rect x="10" y="5.5" width="19" height="5.5" rx="1.5" fill="#f4f8fb"/>
    <rect x="12" y="7" width="3.6" height="2.6" rx="0.6" fill="#9fc4dd"/>
    <rect x="17.4" y="7" width="3.6" height="2.6" rx="0.6" fill="#9fc4dd"/>
    <rect x="22.8" y="7" width="3.6" height="2.6" rx="0.6" fill="#9fc4dd"/>
    <path d="M29 5.5 l4 5.5 h-4 z" fill="#e6eef4"/>
    <path d="M2 17 q4 2 8 0 q4 2 8 0 q4 2 8 0 q4 2 8 0" fill="none" stroke="#7db8dc" stroke-width="1.3"/>
  </svg>`;
}

const _iconCache = new Map();
function vehIcon(kind, colour, flip, cars, ghost) {
  const ck = `${kind}|${colour}|${flip ? 1 : 0}|${cars || 0}|${ghost ? 1 : 0}`;
  let ic = _iconCache.get(ck);
  if (ic) return ic;
  const svg = kind === "bus" ? busSvg(colour) : kind === "tram" ? tramSvg(colour)
    : kind === "boat" ? boatSvg(colour) : kind === "coach" ? coachSvg(colour)
    : trainSvg(colour, cars);
  const w = kind === "train" ? clamp(cars || 4, 2, 9) * 11 : 28;
  ic = L.divIcon({
    className: "vehwrap",
    html: `<div class="vbox${flip ? " flip" : ""}${ghost ? " ghost" : ""}">${svg}</div>`,
    iconSize: [w, 16],
    iconAnchor: [w / 2, 10],
  });
  _iconCache.set(ck, ic);
  return ic;
}

// Perf: vehicle data is kept for everything we track, but DOM markers are
// materialised only inside the (padded) viewport — panning re-syncs them.
// This is what keeps zoom/pan smooth with thousands of live vehicles.
function inViewPad(lat, lon) {
  return map.getBounds().pad(0.25).contains([lat, lon]);
}

// Mode filter driven by the clickable legend chips (bus/train/tram/boat).
state.modeFilter = new Set(["bus", "coach", "train", "tram", "boat"]);
for (const chip of document.querySelectorAll(".lchip")) {
  chip.onclick = () => {
    const k = chip.dataset.kind;
    if (state.modeFilter.has(k)) state.modeFilter.delete(k);
    else state.modeFilter.add(k);
    chip.classList.toggle("off", !state.modeFilter.has(k));
    syncMarkers();
    updateCounter();
  };
}

// Rotate long vehicles to face their direction of travel. The SVGs face east
// (nose right); when heading west we mirror first so wheels stay down.
const ROTATE_KINDS = new Set(["train", "tram", "boat"]);

function applyHeading(v) {
  if (!v.marker || !ROTATE_KINDS.has(v.kind)) return;
  let p1 = v.a, p2 = v.b;
  if (v.path && v.path.length > 1) {
    const i = clamp(v._segIdx || 1, 1, v.path.length - 1);
    p1 = { lat: v.path[i - 1][0], lon: v.path[i - 1][1] };
    p2 = { lat: v.path[i][0], lon: v.path[i][1] };
  }
  const dx = (p2.lon - p1.lon) * Math.cos(((p1.lat + p2.lat) / 2) * Math.PI / 180);
  const dy = p2.lat - p1.lat;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;   // stationary: keep last heading
  const el = v.marker.getElement();
  if (!el || !el.firstChild) return;
  let deg = Math.atan2(-dy, dx) * 180 / Math.PI;            // CSS clockwise, 0° = east
  el.firstChild.style.transform = deg > 90 || deg < -90
    ? `rotate(${(deg - 180).toFixed(1)}deg) scaleX(-1)`
    : `rotate(${deg.toFixed(1)}deg)`;
}

function ensureMarker(key, v) {
  const pos = positionOf(v, clock());
  let want = inViewPad(pos[0], pos[1]) && state.modeFilter.has(v.kind || "train");
  if (want && v.kind === "train" && (state.trainStep || 1) > 1 && strHash(key) % state.trainStep !== 0) want = false;
  if (want && map.getZoom() < 13 && inLondonBox(pos[0], pos[1])) want = false;   // London summarised until z13
  if (want && !v.marker) {
    const marker = L.marker(pos, {
      icon: vehIcon(v.kind || "train", v.colour, v.flip, v.cars, v.ghost),
      keyboard: false,
    }).addTo(state.vehicleLayer);
    v.marker = marker;
    v._iconKey = `${v.kind}|${v.colour}|${v.flip ? 1 : 0}|${v.cars || 0}`;
    marker.on("click", async () => {
      const vv = state.vehicles.get(key);
      if (!vv) return;
      marker.bindPopup('<div class="pop">Loading live details…</div>', { maxWidth: 300 }).openPopup();
      const html = await vehicleDetailHtml(vv.family, vv);
      const pop = marker.getPopup();
      if (pop && pop.isOpen()) pop.setContent(html);
    });
  } else if (!want && v.marker) {
    state.vehicleLayer.removeLayer(v.marker);
    v.marker = null;
  } else if (v.marker) {
    const ik = `${v.kind}|${v.colour}|${v.flip ? 1 : 0}|${v.cars || 0}|${v.ghost ? 1 : 0}`;
    if (v._iconKey !== ik) { v.marker.setIcon(vehIcon(v.kind, v.colour, v.flip, v.cars, v.ghost)); v._iconKey = ik; }
  }
  applyHeading(v);
}

function syncMarkers() {
  const z = map.getZoom();
  const cap = z >= 13 ? Infinity : z >= 11 ? 250 : 120;
  let trains = 0;
  const b = map.getBounds().pad(0.25);
  for (const v of state.vehicles.values()) {
    if (v.kind === "train" && v.b && b.contains([v.b.lat, v.b.lon])) trains++;
  }
  state.trainStep = trains > cap ? Math.ceil(trains / cap) : 1;
  for (const [key, v] of state.vehicles) ensureMarker(key, v);
}
map.on("moveend", syncMarkers);

function applyTargets(family, targets) {
  const seq = ++state.seqs[family];
  const t0 = clock();
  for (const tg of targets) {
    const key = `${family}|${tg.key}`;
    let v = state.vehicles.get(key);
    if (!v) { v = { marker: null }; state.vehicles.set(key, v); }
    Object.assign(v, tg, { pollAt: t0, lastSeen: seq, family });
    ensureMarker(key, v);
  }
  for (const [key, v] of state.vehicles) {
    if (key.startsWith(family + "|") && seq - v.lastSeen >= 2) {
      if (v.marker) state.vehicleLayer.removeLayer(v.marker);
      state.vehicles.delete(key);
    }
  }
  updateCounter();
  syncMarkers();
}

/* Rich click-through detail per vehicle: onward stops + expected times where
 * the data exists (TfL vehicles + London buses + national trains); honest
 * fallback where it doesn't (non-London buses: England publishes GPS only). */
function popRow(name, right, terminal, stopId, crs) {
  const nameHtml = stopId
    ? `<span class="jump" data-stop="${escapeHtml(stopId)}">${escapeHtml(name)}</span>`
    : crs
      ? `<span class="jump" data-crs="${escapeHtml(crs)}">${escapeHtml(name)}</span>`
      : `<span>${escapeHtml(name)}</span>`;
  return `<div class="poprow${terminal ? " term" : ""}">${nameHtml}<span>${escapeHtml(right)}</span></div>`;
}

// Fly to a rail station named in a train's calling-point list. Unlike
// jumpToStop (which opens a bus-stop board), this just takes the map there
// and blinks the spot - the Train plate is then one tap from its board.
function jumpToStation(crs, name) {
  const st = (state.stations || []).find((x) => x.crs === crs);
  if (!st || st.lat == null) return;
  map.closePopup();
  // Jumps can start from the sidebar's departure board too; on a phone that
  // board is the open drawer, which would cover the very map we just moved.
  if (window.innerWidth <= 480) setNav(false);
  map.setView([st.lat, st.lon], Math.max(map.getZoom(), 12));
  pulseAt(st.lat, st.lon);
}

// The station departure board lives in the sidebar (not a popup), so it needs
// its own delegated listener for destination jumps.
$("railboard").addEventListener("click", (ev) => {
  const j = ev.target.closest(".jump");
  if (j && j.dataset.crs) jumpToStation(j.dataset.crs, j.textContent);
});

// Fly to a stop mentioned in a journey popup, then open its live board.
async function jumpToStop(stopId, fallbackName) {
  // Try coordinates we already hold (line geometries), else ask the server.
  let st = null;
  for (const g of state.tracked.values()) {
    st = g.stations.find((s) => s.naptan === stopId || s.id === stopId);
    if (st && st.lat != null) break;
    st = null;
  }
  if (!st) st = await api(`/api/stopname/${stopId}`).catch(() => null);   // any GB stop (NaPTAN)
  if (!st) st = await api(`/api/stopinfo/${stopId}`).catch(() => null);   // TfL fallback
  if (!st || st.lat == null) return;
  map.closePopup();
  map.setView([st.lat, st.lon], Math.max(map.getZoom(), 15));
  // Blink the destination. Jumping the map is disorienting otherwise: you
  // land somewhere new with no idea which of the stops on screen you asked
  // for. pulseAt() already existed but nothing on this path ever called it.
  pulseAt(st.lat, st.lon);
  openBoard(stopId, st.name || fallbackName || "Stop", st.lat, st.lon);
}

// One delegated listener: any .jump element inside any popup flies to its stop.
map.on("popupopen", (e) => {
  const node = e.popup.getElement();
  if (!node) return;
  node.addEventListener("click", (ev) => {
    const j = ev.target.closest(".jump");
    if (j && j.dataset.stop) jumpToStop(j.dataset.stop, j.textContent);
    else if (j && j.dataset.crs) jumpToStation(j.dataset.crs, j.textContent);
  });
});

/* Wave 2 — selection: clicking a vehicle highlights its route, dims the rest. */
let highlighted = null;
let highlightLayer = null;

function setLineEmphasis(exceptId) {
  for (const [id, grp] of Object.entries(state.geomLayers)) {
    const on = exceptId == null || id === exceptId;
    grp.eachLayer((l) => {
      if (l instanceof L.Polyline && !(l instanceof L.Polygon)) {
        l.setStyle({ opacity: on ? 0.85 : 0.10, weight: id === exceptId ? 5 : 3 });
      } else if (l.setStyle) {
        l.setStyle({ opacity: on ? 1 : 0.15, fillOpacity: on ? 1 : 0.15 });
      }
    });
  }
}

async function highlightRoute(lineId) {
  if (!lineId || highlighted === lineId) return;
  clearHighlight();
  highlighted = lineId;
  setLineEmphasis(lineId);
  if (!state.geomLayers[lineId] || !map.hasLayer(state.geomLayers[lineId])) {
    // Route not on the map (e.g. a bus route) — draw a dedicated overlay,
    // WITHOUT registering it for vehicle polling (that would duplicate buses).
    const g = state.tracked.get(lineId) || await api(`/api/geometry/${lineId}`).catch(() => null);
    if (!g || highlighted !== lineId) return;
    highlightLayer = L.layerGroup();
    for (const p of g.paths) L.polyline(p, { color: g.colour, weight: 5, opacity: 0.9 }).addTo(highlightLayer);
    for (const s of g.stations) {
      if (s.lat == null) continue;
      const m = L.circleMarker([s.lat, s.lon], {
        radius: tapR(4), color: "#fff", weight: 1.2, fillColor: g.colour, fillOpacity: 1,
      }).addTo(highlightLayer);
      m.bindTooltip(escapeHtml(s.name), { direction: "top" });
      m.on("click", () => openBoard(s.naptan || s.id, s.name, s.lat, s.lon));
    }
    highlightLayer.addTo(map);
  }
}

let journeyLayer = null;
function drawJourney(route, dots) {
  clearJourney();
  if (!route || route.length < 2) return;
  journeyLayer = L.layerGroup();
  L.polyline(route, { color: "#20262e", weight: 6, opacity: 0.55 }).addTo(journeyLayer);
  L.polyline(route, { color: "#F5C518", weight: 3, opacity: 0.95 }).addTo(journeyLayer);
  for (const p of (dots || [])) {
    L.circleMarker([p.lat, p.lon], {
      radius: tapR(4.5), color: "#20262e", weight: 1.5,
      fillColor: p.passed ? "#8b96a5" : "#ffffff", fillOpacity: 1,
    }).addTo(journeyLayer).bindTooltip(escapeHtml(p.name), { direction: "top" });
  }
  journeyLayer.addTo(map);
}
function clearJourney() {
  if (journeyLayer) { map.removeLayer(journeyLayer); journeyLayer = null; }
}

function clearHighlight() {
  if (highlightLayer) { map.removeLayer(highlightLayer); highlightLayer = null; }
  if (highlighted) { highlighted = null; setLineEmphasis(null); }
  clearJourney();
}
map.on("popupclose", clearHighlight);

async function vehicleDetailHtml(family, v) {
  let head = `<b>${escapeHtml(v.label || "")}</b>${v.dest ? " → " + escapeHtml(v.dest) : ""}`;
  let rows = "";
  try {
    if (family === "nr" && v.id) {
      const d = await api(`/api/rail/train/${v.id}`);
      drawJourney(d.route, d.callingPoints);
      head = `<b>${escapeHtml(d.operator || "Train")}</b> → ${escapeHtml(d.dest || "?")}`;
      rows = d.stops.map((s, i) =>
        popRow(s.name, s.mins <= 0 ? "now" : `${s.mins} min`, i === d.stops.length - 1, null, s.crs)).join("");
    } else if (family === "tfl" && v.vehId) {
      highlightRoute(v.line);
      const arr = await api(`/api/vehicle/${v.vehId}?line=${encodeURIComponent(v.line || "")}`);
      rows = arr.slice(0, 14).map((s, i) => popRow(s.stop, dueText(s.tts), i === arr.length - 1, s.stopId)).join("");
      if (!rows) rows = '<div class="popnote">No onward predictions right now.</div>';
    } else if (family === "ghost") {
      rows = popRow("Scheduled service", (v.dest || "").replace(/_/g, " "), true) +
        '<div class="popnote">Timetable position — this operator does not publish live GPS here yet, so the bus is drawn where the schedule says it should be.</div>';
    } else if (family === "bods") {
      if (v.operator === "TFLO" && v.vehId) {
        const reg = v.vehId.split("|").pop();
        const arr = await api(`/api/vehicle/${reg}`).catch(() => []);
        if (arr.length) {
          head = `<b>Bus ${escapeHtml(arr[0].line || v.route || "")}</b> → ${escapeHtml(arr[0].destination || v.dest || "?")}`;
          rows = arr.slice(0, 14).map((s, i) => popRow(s.stop, dueText(s.tts), i === arr.length - 1, s.stopId)).join("");
          if (arr[0].lineId) highlightRoute(arr[0].lineId);
        }
      } else if (v.journey && v.journey.originRef && v.journey.originDep && v.route) {
        // v2: match this vehicle to its scheduled trip -> full stop list + delay
        const pos = v.marker ? v.marker.getLatLng() : { lat: v.b.lat, lng: v.b.lon };
        const j = await api(`/api/journey?line=${encodeURIComponent(v.route)}&origin=${encodeURIComponent(v.journey.originRef)}&dep=${encodeURIComponent(v.journey.originDep)}&lat=${pos.lat}&lon=${pos.lng}`).catch(() => null);
        // >90 min "late" means a parked bus still broadcasting its finished
        // journey — fall through to the schedule summary instead.
        if (j && j.matched && j.stops.length && (j.delaySecs == null || j.delaySecs < 5400)) {
          const delay = j.delaySecs;
          const badge = delay == null ? ""
            : Math.abs(delay) < 120 ? '<span class="dbadge ok">on time</span>'
            : delay > 0 ? `<span class="dbadge late">+${Math.round(delay / 60)} min late</span>`
            : `<span class="dbadge early">${Math.round(-delay / 60)} min early</span>`;
          head = `<b>Bus ${escapeHtml(v.route)}</b> → ${escapeHtml((v.dest || "").replace(/_/g, " "))} ${badge}`;
          const nowS = nowSecsLondon();
          const hhmm = (s) => `${String(Math.floor((s % 86400) / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
          const upcoming = j.stops.filter((s) => (s.dep ?? s.arr) + (delay || 0) > nowS - 60);
          const shown = upcoming.length ? upcoming : j.stops.slice(-3);
          rows = shown.slice(0, 16).map((s, i) => {
            const exp = (s.arr ?? s.dep) + (delay || 0);
            return popRow(s.name || s.stopId, hhmm(exp), i === shown.length - 1, s.stopId);
          }).join("");
          if (upcoming.length > 16) rows += `<div class="popnote">…and ${upcoming.length - 16} more stops to ${escapeHtml((v.dest || "").replace(/_/g, " "))}.</div>`;
          rows += '<div class="popnote">Times = timetable adjusted by this bus\'s live delay.</div>';
        }
      }
      if (!rows) {
        const j = v.journey || {};
        const bits = [];
        const hhmm = (iso) => {
          const d = iso ? new Date(iso) : null;
          return d && !isNaN(d) ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : null;
        };
        if (j.originName) {
          const dep = hhmm(j.originDep);
          bits.push(popRow(`From: ${j.originName.replace(/_/g, " ")}`, dep ? `dep ${dep}` : "", false));
        }
        if (v.dest) {
          const arrIso = j.destArrival ? new Date(j.destArrival) : null;
          let right = "";
          if (arrIso && !isNaN(arrIso)) {
            const mins = Math.round((arrIso - Date.now()) / 60000);
            right = `arr ${hhmm(j.destArrival)}${mins > 0 ? ` (~${mins} min)` : ""}`;
          }
          const destName = v.dest.replace(/_/g, " ");
          bits.push(j.destRef
            ? `<div class="poprow term"><span class="jump" data-stop="${escapeHtml(j.destRef)}">To: ${escapeHtml(destName)}</span><span>${escapeHtml(right)}</span></div>`
            : popRow(`To: ${destName}`, right, true));
        }
        if (v.operator) bits.push(popRow("Operator", v.operator, false));
        // SIRI VehicleRef: whatever the operator chooses to publish. Usually a
        // fleet number, sometimes the registration plate, occasionally opaque.
        // Labelled "Vehicle" rather than "Plate" because it is not reliably one.
        if (v.vehId && v.vehId.includes("|")) {
          const ref = v.vehId.split("|").pop();
          if (ref && ref !== "?") bits.push(popRow("Vehicle", ref, false));
        }
        bits.push('<div class="popnote">Times are the operator’s schedule from the live feed. Full stop-by-stop lists need timetable matching — planned as v2.</div>');
        rows = bits.join("");
      }
    }
  } catch (e) {
    rows = `<div class="popnote">Couldn't load details (${escapeHtml(e.message)})</div>`;
  }
  return `<div class="pop"><div class="pophead">${head}</div>${rows}</div>`;
}

function updateGpsLine() {
  const gl = document.querySelector(".gpsline");
  if (!gl) return;
  let liveBus = 0, ghostBus = 0;
  for (const v of state.vehicles.values()) {
    if (v.family === "bods") liveBus++;
    else if (v.family === "ghost") ghostBus++;
  }
  const natLive = state.busTotal || 0;
  gl.innerHTML = `<span class="livechip">● live GPS</span> ${natLive.toLocaleString()} buses across England` +
    (liveBus + ghostBus ? `<br><span style="opacity:.75">in current view: ${liveBus.toLocaleString()} live · ${ghostBus.toLocaleString()} scheduled (translucent — no GPS published)</span>` : "");
}

let _lzAt = 0;
function updateCounter() {
  updateGpsLine();
  if (londonMidView() && clock() - _lzAt > 5000) { _lzAt = clock(); renderLondonZones(); }
  const z = map.getZoom();
  if (londonMidView()) {
    $("livecount").textContent = `${state.vehicles.size.toLocaleString()} vehicles live — London summarised by area · zoom in for individual vehicles`;
    return;
  }
  if (z < DETAIL_ZOOM) {
    // Country view: whole-UK live totals per mode (data keeps polling even
    // while the markers themselves are hidden at this zoom).
    let trains = 0, trams = 0, boats = 0, coaches = 0;
    for (const [k, v] of state.vehicles) {
      if (k.startsWith("nr|")) trains++;
      else if (v.kind === "tram") trams++;
      else if (v.kind === "boat") boats++;
      else if (v.kind === "coach") coaches++;
    }
    const bits = [];
    if (state.busTotal) bits.push(`${state.busTotal.toLocaleString()} buses`);
    if (trains) bits.push(`${trains} trains`);
    if (coaches) bits.push(`${coaches} coaches`);
    if (trams) bits.push(`${trams} trams`);
    if (boats) bits.push(`${boats} ferries`);
    $("livecount").textContent = bits.length
      ? `Live now: ${bits.join(" · ")} — zoom in or tap a city`
      : "";
    return;
  }
  const n = state.vehicles.size;
  const hint = z >= DETAIL_ZOOM && z < 14 ? " · zoom closer for stops" : "";
  const samp = state.busTotal > state.busShown && z >= DETAIL_ZOOM
    ? ` · ${state.busShown.toLocaleString()} of ${state.busTotal.toLocaleString()} buses shown — zoom in for all`
    : "";
  $("livecount").textContent = n ? `${n.toLocaleString()} vehicles on map${hint}${samp}` : "";
}

function tflTargets(arrivals) {
  const byVeh = new Map();
  for (const a of arrivals) {
    if (!a.vehicleId || a.vehicleId === "000" || a.timeToStation == null) continue;
    const k = `${a.lineId}|${a.vehicleId}`;
    if (!byVeh.has(k)) byVeh.set(k, []);
    byVeh.get(k).push(a);
  }
  const targets = [];
  for (const [key, arrs] of byVeh) {
    const lineId = key.slice(0, key.indexOf("|"));
    const geom = state.tracked.get(lineId);
    if (!geom) continue;
    arrs.sort((x, y) => x.timeToStation - y.timeToStation);
    const n0 = arrs[0];
    if (n0.timeToStation > 600) continue; // too far out to place meaningfully
    const sNext = stationOf(geom, n0.stationId);
    if (!sNext || sNext.lat == null) continue;
    const prev = prevStation(geom, sNext.id, n0.direction);
    const n1 = arrs[1];
    const mode = state.busLines.has(lineId) ? "bus" : (state.modeByLine[lineId] || "rail");
    targets.push({
      key,
      a: prev || sNext,
      b: sNext,
      segDur: n1 ? clamp(n1.timeToStation - n0.timeToStation, 25, 240) : 90,
      tAtPoll: n0.timeToStation,
      colour: geom.colour,
      kind: mode === "tram" ? "tram" : mode === "bus" ? "bus" : mode === "river-bus" ? "boat" : "train",
      cars: mode === "tube" ? 4 : mode === "dlr" ? 3 : 5,
      vehId: n0.vehicleId,
      line: lineId,
      label: lineId,
      dest: n0.destination,
      nextName: n0.stationName,
      currentLocation: n0.currentLocation,
    });
  }
  return targets;
}

function nrTargets(trains) {
  return trains.map((t) => ({
    key: t.id,
    id: t.id,
    a: t.a,
    b: t.b,
    path: t.path || null,
    _cum: null,
    segDur: t.segDur,
    tAtPoll: t.tts,
    colour: "#F5C518",           // yellow cars, grey surround (drawn by trainSvg)
    kind: "train",
    cars: t.cars || 4,
    label: t.operator || "National Rail",
    dest: t.dest,
    nextName: t.nextName,
    currentLocation: null,
  }));
}


async function pollNR() {
  if (!state.nrOn || !state.config.darwin) return;
  let trains;
  try { trains = await api("/api/rail/trains"); }
  catch { return; }
  applyTargets("nr", nrTargets(trains));
}

function positionOf(v, now) {
  const elapsed = (now - v.pollAt) / 1000;
  const remain = v.tAtPoll - elapsed;
  const f = clamp(1 - remain / v.segDur, 0, 1);
  if (v.path && v.path.length > 1) {
    // travel along the real track polyline (cumulative-length lookup)
    if (!v._cum) {
      v._cum = [0];
      for (let i = 1; i < v.path.length; i++) {
        const [la1, lo1] = v.path[i - 1], [la2, lo2] = v.path[i];
        v._cum.push(v._cum[i - 1] + Math.hypot((la2 - la1) * 111, (lo2 - lo1) * 111 * Math.cos(la1 * Math.PI / 180)));
      }
    }
    const target = f * v._cum[v._cum.length - 1];
    let i = 1;
    while (i < v._cum.length - 1 && v._cum[i] < target) i++;
    const span = v._cum[i] - v._cum[i - 1] || 1e-9;
    const g = clamp((target - v._cum[i - 1]) / span, 0, 1);
    const [la1, lo1] = v.path[i - 1], [la2, lo2] = v.path[i];
    v._segIdx = i;
    return [la1 + (la2 - la1) * g, lo1 + (lo2 - lo1) * g];
  }
  return [v.a.lat + (v.b.lat - v.a.lat) * f, v.a.lon + (v.b.lon - v.a.lon) * f];
}

function animateTick() {
  if (!map.hasLayer(state.vehicleLayer)) return;   // country view: nothing to animate
  const t = clock();
  for (const v of state.vehicles.values()) {
    if (!v.marker) continue;
    v.marker.setLatLng(positionOf(v, t));
    if (v.path && v._segIdx !== v._lastSegIdx) { v._lastSegIdx = v._segIdx; applyHeading(v); }
  }
}
// setInterval (not requestAnimationFrame) so motion keeps running even when the
// tab is backgrounded/unpainted; ~100ms is smooth for transit speeds.
setInterval(animateTick, 100);

// Browsers throttle page timers on hidden/background tabs (down to ~1/min),
// which froze polling. Web Worker timers are exempt, so a tiny inline worker
// heartbeats every second and `pump` runs whatever is due.
const _due = { status: 0, tfl: 0, nr: 0, bus: 0, favs: 0 };
function pump() {
  const now = Date.now();
  if (now - _due.status >= 60000) { _due.status = now; loadStatus().catch(() => {}); }
  if (now - _due.tfl >= 25000) { _due.tfl = now; pollVehicles(); }
  if (now - _due.nr >= 30000) { _due.nr = now; pollNR(); }
  if (now - _due.bus >= BUS_POLL_S * 1000) { _due.bus = now; refreshBuses(); }
  if (now - _due.favs >= 30000) {
    _due.favs = now;
    if ($("tab-favs").classList.contains("active")) renderFavs();
  }
  animateTick();
}
try {
  const blob = new Blob(["setInterval(() => postMessage(0), 1000)"], { type: "text/javascript" });
  new Worker(URL.createObjectURL(blob)).onmessage = pump;
} catch { /* worker blocked — the plain intervals below still cover foreground use */ }

async function pollVehicles() {
  const ids = [...state.tracked.keys()];
  if (!ids.length) { applyTargets("tfl", []); return; }
  const all = [];
  for (let i = 0; i < ids.length; i += 20) {
    const grp = ids.slice(i, i + 20);
    try { all.push(...await api(`/api/trains?lines=${grp.join(",")}`)); }
    catch { /* skip this chunk this round */ }
  }
  applyTargets("tfl", tflTargets(all));
}

/* ---------- arrivals board (any TfL stop) ---------- */
async function openBoard(stopId, name, lat, lon) {
  Object.assign(state.board, { stopId, name, lat, lon });
  $("board-title").textContent = name;
  syncBoardStar();
  $("board-body").innerHTML = '<div class="empty">Loading live arrivals…</div>';
  $("board").classList.remove("hidden");
  clearInterval(state.board.timer);
  await renderBoard();
  state.board.timer = setInterval(renderBoard, 30000);
}

async function renderBoard() {
  if (!state.board.stopId) return;
  const rows = await boardRowsFor(state.board.stopId, state.board.lat, state.board.lon, 14, state.board.name);
  $("board-body").innerHTML = walkLine() + rows;
}

// "Leave by" — turns arrival data into the decision the user actually makes.
function walkLine() {
  const b = state.board;
  if (!state.userPos || b.lat == null) return "";
  const dm = Math.hypot((b.lat - state.userPos[0]) * 111000,
    (b.lon - state.userPos[1]) * 111000 * Math.cos(b.lat * Math.PI / 180));
  if (dm > 3000) return "";
  const walk = Math.max(1, Math.round(dm / 80));
  let advice = "";
  if (state._firstMins != null && state._firstMins < 900) {
    const spare = state._firstMins - walk;
    advice = spare <= 0 ? " · <b>leave NOW to catch the next one</b>"
      : ` · leave within <b>${spare} min</b> to catch it`;
  }
  return `<div class="walkline">🚶 ${walk} min walk from your location${advice}</div>`;
}

// Live times where they exist (London/TfL); GPS-based ESTIMATES elsewhere in
// England (v1 of our own prediction engine: an approaching bus's heading +
// distance at urban speed). Timetable-matched v2 is on the roadmap.
async function boardRowsFor(stopId, lat, lon, maxRows, stopName) {
  const isLondon = LONDON_STOP_RE.test(stopId);
  state._firstMins = null;
  let arrs = [];
  try { arrs = await api(`/api/arrivals/${stopId}`); } catch {}
  if (arrs.length) {
    state._firstMins = Math.round(Math.min(...arrs.map((a) => a.timeToStation ?? 1e9)) / 60);
    return '<div class="estnote ok">Live times (TfL)</div>' + groupRowsHtml(arrs, maxRows, { stopId, stopName, lat, lon });
  }

  if (!isLondon) {
    // v2: real timetable departures with live delay adjustment.
    let d = null;
    try { d = await api(`/api/departures/${stopId}`); } catch {}
    if (d && d.state === "ready" && d.departures.length) {
      const groups = new Map();
      for (const x of d.departures) {
        const k = `${x.line}|${x.headsign}`;
        if (!groups.has(k)) groups.set(k, { line: x.line, headsign: x.headsign, entries: [] });
        if (groups.get(k).entries.length < 2) groups.get(k).entries.push(x);
      }
      const hhmm = (s) => `${String(Math.floor((s % 86400) / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
      const sorted = [...groups.values()]
        .sort((a, b) => a.entries[0].expectedSecs - b.entries[0].expectedSecs)
        .slice(0, maxRows);
      state._firstMins = sorted.length ? sorted[0].entries[0].mins : null;
      const rows = sorted.map((g) => {
          const e0 = g.entries[0];
          const times = g.entries.map((x) => {
            const chip = x.delayMin == null ? "" : Math.abs(x.delayMin) < 2 ? "•" : x.delayMin > 0 ? `+${x.delayMin}` : `${x.delayMin}`;
            return `${x.mins <= 0 ? "due" : x.mins + " min"}${x.live ? ` <span class="livechip${x.delayMin > 1 ? " late" : ""}">${chip || "live"}</span>` : ""}`;
          }).join(", ");
          const flyAttr = e0.live && e0.vpos ? ` data-vpos="${e0.vpos[0]},${e0.vpos[1]}" title="Show this bus on the map"` : "";
          const svc = escapeHtml(JSON.stringify({ stop: stopId, name: stopName || "", line: g.line, dest: g.headsign, lat, lon }));
          const starred = (state.favs.services || []).some((s) => s.stop === stopId && s.line === g.line && s.dest === g.headsign);
          return `
            <div class="arr${e0.live && e0.vpos ? " flyable" : ""}"${flyAttr}>
              <div class="routeno">${escapeHtml(g.line || "?")}</div>
              <div class="dest">${escapeHtml(g.headsign || "?")}${e0.isLast ? ' <span class="lastchip">LAST tonight</span>' : ""}
                <div class="sub">${g.entries.map((x) => hhmm(x.expectedSecs)).join(", ")}${e0.live && e0.vpos ? ' · <span class="flyhint">tap row = see the bus</span>' : ""}</div>
              </div>
              <div class="due">${times}</div>
              <span class="rowstar${starred ? " on" : ""}" data-svc="${svc}">${starred ? "★" : "☆"}</span>
            </div>`;
        }).join("");
      const natNote = (d.region === "scotland" || d.region === "wales")
        ? '<div class="popnote">Operators here are not yet required to publish live GPS (mandates land 2027-28) — most times are timetable-only.</div>' : "";
      return '<div class="estnote ok">Timetable departures · <b>live</b>-tagged rows are delay-adjusted from GPS.</div>' + rows + natNote;
    }
    if (d && (d.state === "downloading" || d.state === "building")) {
      const est = await gpsEstimateRows(lat, lon, maxRows);
      return `<div class="estnote">Preparing ${escapeHtml(d.region || "regional")} timetables (one-time, a few minutes)… showing GPS estimates meanwhile.</div>` + (est || "");
    }
  }

  if (!isLondon) {
    const est = await gpsEstimateRows(lat, lon, maxRows);
    if (est) return est;
    return '<div class="empty">No scheduled or approaching buses found for this stop right now. ☆ star it and check back.</div>';
  }
  return '<div class="empty">No arrivals in the next 30 min.</div>';
}

// GPS-heuristic fallback rows (v1 estimator) — used while a region's
// timetable DB is still building, or when the schedule has no matches.
async function gpsEstimateRows(lat, lon, maxRows) {
  if (lat == null || !state.config.bods) return null;
  let est = [];
  try { est = await api(`/api/eta?lat=${lat}&lon=${lon}`); } catch {}
  if (!est.length) return null;
  const g = new Map();
  for (const e of est) {
    const k = `${e.line || "?"}|${e.destination || ""}`;
    if (!g.has(k)) g.set(k, { line: e.line, dest: e.destination, times: [] });
    if (g.get(k).times.length < 2) g.get(k).times.push(e.etaMin);
  }
  const est_sorted = [...g.values()].sort((x, y) => x.times[0] - y.times[0]).slice(0, maxRows);
  state._firstMins = est_sorted.length ? est_sorted[0].times[0] : null;
  const rows = est_sorted.map((r) => `
    <div class="arr">
      <div class="routeno">${escapeHtml(r.line || "?")}</div>
      <div class="dest">${escapeHtml((r.dest || "?").replace(/_/g, " "))}</div>
      <div class="due">${r.times.map((t) => `~${t} min`).join(", ")}</div>
    </div>`).join("");
  return '<div class="estnote">≈ Estimated from live GPS (bus heading &amp; distance).</div>' + rows;
}

// Group by route + destination: one row per service, next two times together —
// a commuter reads "73 → Stoke Newington: 3 min, 11 min" at a glance.
function groupRowsHtml(arrs, maxRows, ctx) {
  const groups = new Map();
  for (const a of arrs) {
    const gk = `${a.lineName || "?"}|${a.destination || ""}`;
    if (!groups.has(gk)) groups.set(gk, { line: a.lineName, lineId: a.lineId, dest: a.destination, platform: a.platform, veh: a.vehicleId, times: [] });
    const g = groups.get(gk);
    if (g.times.length < 2 && a.timeToStation != null) g.times.push(a.timeToStation);
  }
  const rows = [...groups.values()].sort((x, y) => (x.times[0] ?? 1e9) - (y.times[0] ?? 1e9));
  return rows.slice(0, maxRows).map((g) => {
    const canFly = ctx && g.veh && g.veh !== "000" && g.lineId;
    const vehAttr = canFly ? ` data-veh="${escapeHtml(g.lineId)}|${escapeHtml(g.veh)}" title="Show this vehicle on the map"` : "";
    let star = "";
    if (ctx) {
      const svc = escapeHtml(JSON.stringify({ stop: ctx.stopId, name: ctx.stopName || "", line: g.line, dest: g.dest, lat: ctx.lat, lon: ctx.lon }));
      const on = (state.favs.services || []).some((s) => s.stop === ctx.stopId && s.line === g.line && s.dest === g.dest);
      star = `<span class="rowstar${on ? " on" : ""}" data-svc="${svc}">${on ? "★" : "☆"}</span>`;
    }
    return `
    <div class="arr${canFly ? " flyable" : ""}"${vehAttr}>
      <div class="routeno">${escapeHtml(g.line || "?")}</div>
      <div class="dest">
        ${escapeHtml(g.dest || "?")}
        ${g.platform ? `<div class="sub">${escapeHtml(g.platform)}</div>` : ""}
      </div>
      <div class="due">${g.times.map(dueText).join(", ") || "—"}</div>
      ${star}
    </div>`;
  }).join("");
}


/* ---------- favourites: starred stops + lines -> live dashboard ---------- */
state.favs = (() => {
  try { const f = JSON.parse(localStorage.getItem("ukt_favs")) || {}; return { stops: f.stops || [], lines: f.lines || [], services: f.services || [] }; }
  catch { return { stops: [], lines: [], services: [] }; }
})();
function saveFavs() {
  localStorage.setItem("ukt_favs", JSON.stringify(state.favs));
  syncBoardStar();
  renderLineList(state.lines);
  renderFavs();
}
const isFavStop = (id) => state.favs.stops.some((s) => s.id === id);

function syncBoardStar() {
  $("board-star").textContent = state.board.stopId && isFavStop(state.board.stopId) ? "★" : "☆";
}

$("board-star").onclick = () => {
  const b = state.board;
  if (!b.stopId) return;
  if (isFavStop(b.stopId)) state.favs.stops = state.favs.stops.filter((s) => s.id !== b.stopId);
  else state.favs.stops.push({ id: b.stopId, name: b.name, lat: b.lat, lon: b.lon });
  saveFavs();
};

async function renderFavs() {
  const el = $("favlist");
  if (!el) return;
  if (!state.favs.lines.length && !state.favs.stops.length && !(state.favs.services || []).length) {
    el.innerHTML = '<div class="empty">Nothing starred yet. Open any stop board and tap ☆, or star a line in the London tab.</div>';
    return;
  }
  let linesHtml = "";
  for (const id of state.favs.lines) {
    const l = state.lines.find((x) => x.id === id);
    if (!l) continue;
    linesHtml += `
      <div class="linerow" style="cursor:default">
        <div class="chip" style="background:${escapeHtml(l.colour)}"></div>
        <div class="linemeta"><div class="linename">${escapeHtml(l.name)}</div>
        ${l.reason ? `<div class="reason">${escapeHtml(l.reason)}</div>` : ""}</div>
        <div class="sev ${sevClass(l.severity)}">${escapeHtml(l.severityText)}</div>
      </div>`;
  }
  // "My services" — commute-grain favourites: one route+direction at one stop.
  let svcHtml = "";
  for (const svc of (state.favs.services || [])) {
    svcHtml += `<div class="favstop">
      <div class="favname"><span class="jumpfav" data-id="${escapeHtml(svc.stop)}">${escapeHtml(svc.line)} → ${escapeHtml(svc.dest || "")}</span>
      <span class="unstar" data-svc-del="${escapeHtml(svc.stop)}|${escapeHtml(svc.line)}|${escapeHtml(svc.dest || "")}" title="Remove">★</span></div>
      <div class="sub" style="padding:0 2px 4px">${escapeHtml(svc.name || "")}</div>
      <div class="svc-times" data-svc-key="${escapeHtml(svc.stop)}|${escapeHtml(svc.line)}|${escapeHtml(svc.dest || "")}"><div class="empty">loading…</div></div>
    </div>`;
  }
  // The starred-stop boards load asynchronously into their own container.
  // They used to finish by overwriting el.innerHTML wholesale, which erased
  // the services/lines sections rendered above and orphaned the svcTimes
  // fills - starred services visibly vanished a second after appearing.
  el.innerHTML = svcHtml + linesHtml + (state.favs.stops.length ? '<div id="favstopblocks"><div class="empty">Loading live times…</div></div>' : "");
  // fill service times asynchronously
  for (const svc of (state.favs.services || [])) {
    svcTimes(svc).then((html) => {
      const slot = el.querySelector(`[data-svc-key="${CSS.escape(svc.stop + "|" + svc.line + "|" + (svc.dest || ""))}"]`);
      if (slot) slot.innerHTML = html;
    });
  }
  if (!state.favs.stops.length) { return; }
  const blocks = await Promise.all(state.favs.stops.map(async (s) => {
    let rows;
    try { rows = await boardRowsFor(s.id, s.lat, s.lon, 4, s.name); }
    catch (e) { rows = `<div class="empty">${escapeHtml(e.message)}</div>`; }
    return `<div class="favstop">
      <div class="favname"><span class="jumpfav" data-id="${escapeHtml(s.id)}">${escapeHtml(s.name)}</span>
      <span class="unstar" data-id="${escapeHtml(s.id)}" title="Remove">★</span></div>${rows}</div>`;
  }));
  const holder = el.querySelector("#favstopblocks");
  if (holder) holder.innerHTML = blocks.join("");
}

// Next two times for one favourite service (route+direction at a stop).
async function svcTimes(svc) {
  try {
    if (LONDON_STOP_RE.test(svc.stop)) {
      const arrs = await api(`/api/arrivals/${svc.stop}`);
      const mine = arrs.filter((a) => a.lineName === svc.line && (a.destination || "") === (svc.dest || "")).slice(0, 2);
      if (mine.length) return `<div class="due" style="font-size:13px">${mine.map((a) => dueText(a.timeToStation)).join(", ")} <span class="livechip">live</span></div>`;
    } else {
      const d = await api(`/api/departures/${svc.stop}`);
      if (d.state === "ready") {
        const mine = d.departures.filter((x) => x.line === svc.line && (x.headsign || "") === (svc.dest || "")).slice(0, 2);
        if (mine.length) return `<div class="due" style="font-size:13px">${mine.map((x) => (x.mins <= 0 ? "due" : x.mins + " min") + (x.live ? ' <span class="livechip">live</span>' : "")).join(", ")}${mine[0].isLast ? ' <span class="lastchip">LAST tonight</span>' : ""}</div>`;
      }
    }
  } catch {}
  return '<div class="empty">no departures found in the next hour</div>';
}

$("favlist").addEventListener("click", (ev) => {
  const und = ev.target.closest("[data-svc-del]");
  if (und) {
    const [stop, line, dest] = und.dataset.svcDel.split("|");
    state.favs.services = (state.favs.services || []).filter((s) => !(s.stop === stop && s.line === line && (s.dest || "") === dest));
    saveFavs();
    return;
  }
  const un = ev.target.closest(".unstar");
  if (un) { state.favs.stops = state.favs.stops.filter((s) => s.id !== un.dataset.id); saveFavs(); return; }
  const j = ev.target.closest(".jumpfav");
  if (j) jumpToStop(j.dataset.id, j.textContent);
});

// Board rows are doors, not dead ends: tap = see the actual vehicle; star = save the service.
let _pulse = null, _pulseTimer = null;
function pulseAt(lat, lon) {
  if (_pulse) map.removeLayer(_pulse);
  if (_pulseTimer) clearTimeout(_pulseTimer);
  // Blinks for ~2s (4 x 0.5s) then removes itself, so it pulls the eye without
  // becoming permanent map furniture. interactive:false so it never swallows a
  // tap meant for the stop underneath it.
  // A divIcon, not a circleMarker: the map runs preferCanvas:true, so
  // circleMarkers are painted into a canvas and their `className` never
  // becomes a DOM node - the CSS animation simply never runs. That is why the
  // original pulse was invisible even where it was called.
  _pulse = L.marker([lat, lon], {
    icon: L.divIcon({ className: "blinkwrap", html: '<div class="blinkring"></div>',
                      iconSize: [44, 44], iconAnchor: [22, 22] }),
    interactive: false, zIndexOffset: 9000,
  }).addTo(map);
  _pulseTimer = setTimeout(() => {
    if (_pulse) { map.removeLayer(_pulse); _pulse = null; }
    _pulseTimer = null;
  }, 2100);
}
$("board-body").addEventListener("click", (ev) => {
  const star = ev.target.closest(".rowstar");
  if (star) {
    const svc = JSON.parse(star.dataset.svc.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    state.favs.services = state.favs.services || [];
    const i = state.favs.services.findIndex((s) => s.stop === svc.stop && s.line === svc.line && s.dest === svc.dest);
    if (i >= 0) state.favs.services.splice(i, 1); else state.favs.services.push(svc);
    saveFavs();
    renderBoard();
    return;
  }
  const row = ev.target.closest(".arr[data-vpos]");
  if (row) {
    const [la, lo] = row.dataset.vpos.split(",").map(Number);
    map.setView([la, lo], Math.max(map.getZoom(), 15));
    pulseAt(la, lo);
    return;
  }
  const vrow = ev.target.closest(".arr[data-veh]");
  if (vrow) {
    const [lineId, veh] = vrow.dataset.veh.split("|");
    const v = state.vehicles.get(`tfl|${lineId}|${veh}`);
    if (v) {
      const pos = positionOf(v, clock());
      map.setView(pos, Math.max(map.getZoom(), 14));
      pulseAt(pos[0], pos[1]);
      syncMarkers();
      if (v.marker) v.marker.fire("click");
    }
  }
});

$("board-close").onclick = () => {
  $("board").classList.add("hidden");
  clearInterval(state.board.timer);
  state.board.stopId = null;
};

/* ---------- stops: every GB bus/tram stop (NaPTAN), visible at street zoom ---------- */
// London ATCO prefixes get full live boards via TfL; elsewhere England's open
// feed has vehicle GPS but no stop predictions — the board says so honestly.
const LONDON_STOP_RE = /^(490|940G|930G|910G)/;

async function refreshBusStops() {
  if (map.getZoom() < 14) { state.busStopLayer.clearLayers(); return; }
  const b = map.getBounds();
  let d;
  try { d = await api(`/api/stops?minLon=${b.getWest()}&minLat=${b.getSouth()}&maxLon=${b.getEast()}&maxLat=${b.getNorth()}`); }
  catch { return; }
  state.busStopLayer.clearLayers();
  if (!d.ready) {
    $("livecount").textContent = "Preparing the GB stop database (one-time download) — stops appear shortly…";
    return;
  }
  for (const s of d.stops) {
    const [id, name, indicator, lat, lon] = s;
    const label = indicator ? `${name} (${indicator})` : name;
    const m = L.marker([lat, lon], {
      icon: L.divIcon({ className: "stoplabel-wrap",
        html: '<span class="stoplabel stoplabel-bus">B</span>',
        iconSize: null }),
    }).addTo(state.busStopLayer);
    m.bindTooltip(escapeHtml(label), { direction: "top" });
    m.on("click", () => openBoard(id, label, lat, lon));
  }
}
map.on("moveend", refreshBusStops);

/* ---------- bus route search -> track + animate ---------- */
$("busgo").onclick = searchBus;
$("bussearch").addEventListener("keydown", (e) => { if (e.key === "Enter") searchBus(); });

async function searchBus() {
  const q = $("bussearch").value.trim();
  if (!q) return;
  const el = $("busresults");
  el.innerHTML = '<div class="empty">Searching…</div>';
  let matches;
  try { matches = await api(`/api/bussearch/${encodeURIComponent(q)}`); }
  catch (e) { el.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  if (!matches.length) { el.innerHTML = '<div class="empty">No London bus route found.</div>'; return; }
  el.innerHTML = "";
  for (const mch of matches) {
    const d = document.createElement("div");
    d.className = "busmatch";
    d.textContent = `Route ${mch.name} — show live buses`;
    d.onclick = () => selectBusRoute(mch.id, mch.name);
    el.appendChild(d);
  }
}

async function selectBusRoute(id, name) {
  // One route at a time keeps the map legible; London rail keeps animating.
  for (const old of state.busLines) {
    await untrack(old);
    if (state.geomLayers[old]) { map.removeLayer(state.geomLayers[old]); delete state.geomLayers[old]; }
  }
  state.busLines.clear();
  state.busLines.add(id);
  await track(id, true);
  const g = state.tracked.get(id);
  if (g) {
    const pts = g.stations.filter((s) => s.lat != null).map((s) => [s.lat, s.lon]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }
  $("busresults").innerHTML = `<div class="busmatch" style="cursor:default">Tracking route ${escapeHtml(name)} — buses now moving on the map.</div>`;
  pollVehicles();
}

/* ---------- live buses, whole UK ----------
 * Two free sources feed one gliding-icon family:
 *  - zoomed out: national bulk GTFS-RT (keyless, all ~25-30k English buses,
 *    stable-sampled server-side so the browser can animate them)
 *  - zoomed in (>= 10): SIRI-VM bounding-box feed (needs BODS key; richer —
 *    route number, destination, operator)
 * GPS fixes arrive every poll; each bus glides from its current on-screen
 * position to the new fix over the poll interval. */
const BUS_POLL_S = 15;

$("bodstoggle").onchange = function () {
  state.bodsOn = this.checked;
  if (!state.bodsOn) { applyTargets("bods", []); state.busTotal = state.busShown = 0; updateCounter(); }
  else refreshBuses();
};

// Dominant street livery per city/region (web-researched July 2026: TfL red is
// statutory; Bee Network yellow since Jan 2025; NXWM crimson; Lothian madder;
// First-dominated cities purple; NCT green; Cardiff Bus green; Arriva aqua on
// Merseyside until the Oct 2026 franchise). Default: generic UK bus red.
const BUS_LIVERIES = [
  [51.507, -0.118, 28, "#DA291C"],  // London — TfL red
  [53.480, -2.240, 22, "#FFCD00"],  // Greater Manchester — Bee Network yellow
  [52.480, -1.902, 22, "#9E1B32"],  // West Midlands — NXWM crimson
  [53.408, -2.992, 18, "#00A99D"],  // Liverpool City Region — Arriva aqua
  [53.800, -1.549, 18, "#280071"],  // West Yorkshire — First Bus purple (official brand)
  [54.978, -1.617, 18, "#C8102E"],  // Tyne & Wear — Go North East red
  [53.381, -1.470, 15, "#280071"],  // South Yorkshire — First Bus purple
  [52.955, -1.149, 12, "#007A33"],  // Nottingham — NCT green
  [51.454, -2.588, 14, "#280071"],  // Bristol — First Bus purple
  [55.953, -3.189, 15, "#76232F"],  // Edinburgh — Lothian madder
  [55.864, -4.252, 18, "#280071"],  // Glasgow — First Bus purple
  [51.482, -3.179, 12, "#F47B20"],  // Cardiff — Cardiff Bus orange (2021 rebrand)
];
const DEFAULT_BUS = "#C8102E";

// Long-distance coach operators (NOC codes) — drawn as grey coaches, not buses.
const COACH_OPS = new Set(["NATX", "NXSH", "NXAP", "MEGA", "MEGX", "FLIX", "EMBR", "CLNK", "SCLK", "OXBC"]);
const COACH_GREY = "#7C8690";

function busColour(lat, lon) {
  for (const [clat, clon, rKm, hex] of BUS_LIVERIES) {
    const dKm = Math.hypot((lat - clat) * 111, (lon - clon) * 111 * Math.cos(lat * Math.PI / 180));
    if (dKm <= rKm) return hex;
  }
  return DEFAULT_BUS;
}

function busTarget(id, lat, lon, label, dest, operator, bearing, route, journey) {
  const existing = state.vehicles.get(`bods|${id}`);
  const from = existing ? posToObj(positionOf(existing, clock())) : { lat, lon };
  const brg = bearing != null ? Number(bearing) : null;
  const isCoach = operator && COACH_OPS.has(operator);

  // Dead reckoning. Animating toward the REPORTED point means the marker
  // arrives where the bus WAS one poll ago, on top of the feed's own 10-60s
  // staleness - which is why a bus you are watching on the street is visibly
  // ahead of its dot. Instead, aim one poll interval ahead along the line the
  // bus actually moved between its last two reports. Guards: only when a
  // previous RAW report exists (projections must never compound off other
  // projections), only at sane speeds (1-25 m/s), lead capped at 200m so a
  // bus that stops or turns is wrong only briefly and by a bounded amount.
  let target = { lat, lon };
  const prev = existing && existing.rawB;
  if (prev) {
    const cosLat = Math.cos(lat * Math.PI / 180);
    const dKm = Math.hypot((lat - prev.lat) * 111, (lon - prev.lon) * 111 * cosLat);
    const speedMs = dKm * 1000 / BUS_POLL_S;
    if (speedMs >= 1 && speedMs <= 25) {
      const scale = Math.min(dKm, 0.2) / dKm;   // lead = min(last hop, 200m)
      target = { lat: lat + (lat - prev.lat) * scale,
                 lon: lon + (lon - prev.lon) * scale };
    }
  }

  return {
    key: id,
    vehId: id,
    a: from,
    b: target,
    rawB: { lat, lon },
    segDur: BUS_POLL_S,
    tAtPoll: BUS_POLL_S,
    colour: isCoach ? COACH_GREY : busColour(lat, lon),
    kind: isCoach ? "coach" : "bus",
    flip: brg != null && brg > 180,   // face the way it's heading (E/W)
    label,
    dest,
    operator: operator || null,
    route: route || null,
    journey: journey || null,        // {originName, originDep, destRef, destArrival}
    nextName: null,
    currentLocation: null,
  };
}
const posToObj = (ll) => ({ lat: ll[0], lon: ll[1] });

function renderCityChips(d) {
  cityChipLayer.clearLayers();
  const scale = d.shown ? d.total / d.shown : 1;
  for (const [name, clat, clon] of CITIES) {
    let n = 0;
    for (const v of d.vehicles) {
      if (Math.abs(v.lat - clat) < 0.22 && Math.abs(v.lon - clon) < 0.34) n++;
    }
    const est = Math.round((n * scale) / 10) * 10;
    state.cityCounts = state.cityCounts || {};
    state.cityCounts[name] = est;
    // trains / trams / ferries near this city, from the live vehicle model
    let tr = 0, tm = 0, bo = 0;
    for (const v of state.vehicles.values()) {
      if (v.b && Math.abs(v.b.lat - clat) < 0.3 && Math.abs(v.b.lon - clon) < 0.45) {
        if (v.kind === "train") tr++;
        else if (v.kind === "tram") tm++;
        else if (v.kind === "boat") bo++;
      }
    }
    state.ghostCounts = state.ghostCounts || {};
    if (est < 60) {
      const gc = state.ghostCounts;
      if (!gc["t:" + name] || Date.now() - gc["t:" + name] > 60000) {
        gc["t:" + name] = Date.now();
        api(`/api/ghostcount?lat=${clat}&lon=${clon}`).then((d) => { gc[name] = d.count; }).catch(() => {});
      }
    }
    const sched = state.ghostCounts[name];
    const parts = [est ? `≈${est.toLocaleString()} 🚌` : "", tr ? `${tr} 🚆` : "",
                   tm ? `${tm} 🚊` : "", bo ? `${bo} ⛴` : "",
                   est < 60 && sched ? `${sched}${sched >= 300 ? "+" : ""} scheduled` : ""]
                  .filter(Boolean).join(" · ");
    if (!parts) continue;
    const m = L.marker([clat, clon], {
      icon: L.divIcon({
        className: "chipwrap",
        html: `<div class="citychip">${escapeHtml(name)}<span>${parts}</span></div>`,
        iconSize: null,
      }),
      keyboard: false,
    });
    m.on("click", () => map.setView([clat, clon], 12));
    m.addTo(cityChipLayer);
  }
}

async function refreshBuses() {
  if (!state.bodsOn) { cityChipLayer.clearLayers(); return; }
  const z = map.getZoom();

  if (z < DETAIL_ZOOM) {
    // Country view: no individual vehicles — live city chips instead.
    let d;
    try { d = await api("/api/buses/national"); } catch { return; }
    state.busTotal = d.total;
    state.busShown = 0;
    applyTargets("bods", []);
    renderCityChips(d);
    return;
  }

  let targets = [];
  try {
    if (state.config.bods) {
      const b = map.getBounds();
      const vs = await api(`/api/buses?minLon=${b.getWest()}&minLat=${b.getSouth()}&maxLon=${b.getEast()}&maxLat=${b.getNorth()}`);
      state.busTotal = vs.length;
      const cap = busCapForZoom(z);
      let picked = vs;
      if (vs.length > cap) {
        const step = Math.ceil(vs.length / cap);
        picked = vs.filter((v) => strHash(v.id) % step === 0);
      }
      state.busShown = picked.length;
      targets = picked.map((v) => busTarget(v.id, v.lat, v.lon, `Bus ${v.line || ""}`.trim(), v.destination, v.operator, v.bearing, v.line,
        { originName: v.originName, originRef: v.originRef, originDep: v.originDep, destRef: v.destRef, destArrival: v.destArrival }));
    } else {
      // Keyless fallback: national feed clipped to the viewport.
      const d = await api("/api/buses/national");
      const b = map.getBounds();
      const vs = d.vehicles.filter((v) => b.contains([v.lat, v.lon]));
      state.busTotal = d.total;
      state.busShown = vs.length;
      targets = vs.map((v) => busTarget(v.id, v.lat, v.lon, "Bus", null, null, v.bearing, null));
    }
  } catch { return; }
  applyTargets("bods", targets);
  refreshGhosts();
}

// Timetable "ghost" vehicles: translucent scheduled buses where nobody
// publishes live GPS (Scotland, Wales, small operators). Clearly non-live.
async function refreshGhosts() {
  if (map.getZoom() < DETAIL_ZOOM) { applyTargets("ghost", []); return; }
  if (state.busTotal > busCapForZoom(map.getZoom())) { applyTargets("ghost", []); return; }
  const b = map.getBounds();
  let gs = [];
  try { gs = await api(`/api/ghosts?minLon=${b.getWest()}&minLat=${b.getSouth()}&maxLon=${b.getEast()}&maxLat=${b.getNorth()}`); }
  catch { return; }
  applyTargets("ghost", gs.map((g) => ({
    key: g.id,
    a: g.a,
    b: g.b,
    segDur: g.segDur,
    tAtPoll: g.tts,
    colour: busColour(g.b.lat, g.b.lon),
    kind: g.mode === "tram" ? "tram" : "bus",
    ghost: true,
    label: `Bus ${g.line || ""} (scheduled)`.trim(),
    dest: g.headsign,
    nextName: null,
    currentLocation: null,
  })));
}

/* ---------- National Rail (Darwin) ---------- */
async function loadStations() {
  try { state.stations = await api("/api/rail/stations"); } catch { state.stations = []; }
  $("stationlist").innerHTML = state.stations
    .map((s) => `<option value="${escapeHtml(s.name)} (${escapeHtml(s.crs)})">`).join("");
  buildStationLayer();
}

// GB rail stations (2,606), viewport-culled: only in-view markers exist, so
// zooming stays smooth. Rebuilt on every pan/zoom from the in-memory list.
function buildStationLayer() {
  if (state.railStationLayer || !state.stations.length) return;
  state.railStationLayer = L.layerGroup().addTo(map);
  map.on("moveend", refreshRailStations);
  refreshRailStations();
}

function refreshRailStations() {
  const grp = state.railStationLayer;
  if (!grp) return;
  grp.clearLayers();
  if (map.getZoom() < 10) return;
  const b = map.getBounds().pad(0.2);
  let n = 0;
  for (const s of state.stations) {
    if (s.lat == null || !b.contains([s.lat, s.lon])) continue;
    const m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: "stoplabel-wrap",
        html: '<span class="stoplabel stoplabel-rail">Train</span>',
        iconSize: null }),
    }).addTo(grp);
    m.bindTooltip(`${escapeHtml(s.name)} (${escapeHtml(s.crs)}) — rail`, { direction: "top" });
    m.on("click", () => {
      document.querySelector('.tab[data-tab="rail"]').click();
      $("railsearch").value = `${s.name} (${s.crs})`;
      goRail();
      // The departures board renders in the SIDEBAR. On a phone the sidebar
      // is a closed drawer, so without this the tap did everything invisibly
      // and the station looked dead - open the drawer so the board is seen.
      if (window.innerWidth <= 480) setNav(true);
    });
    if (++n >= 300) break;
  }
}

/* ---------- UK-level toggles ---------- */
$("ormtoggle").onchange = function () {
  if (this.checked) state.ormLayer.addTo(map);
  else map.removeLayer(state.ormLayer);
};

$("nrtoggle").onchange = function () {
  state.nrOn = this.checked;
  if (this.checked && !state.config.darwin) {
    $("nrhint").innerHTML =
      'Needs a free Darwin key: register at <a href="https://raildata.org.uk" target="_blank" rel="noopener">raildata.org.uk</a>, subscribe to the <b>Live Departure Board</b> product, put the Consumer key in <code>uk_transit_live/.env</code> as <code>DARWIN_API_KEY=…</code>, restart the server. Trains then appear across the whole UK map within ~2 minutes.';
    return;
  }
  $("nrhint").innerHTML = "";
  if (!this.checked) applyTargets("nr", []);
  else pollNR();
};

function crsFromInput(v) {
  v = v.trim();
  const m = v.match(/\(([A-Za-z]{3})\)\s*$/);
  if (m) return m[1].toUpperCase();
  if (/^[A-Za-z]{3}$/.test(v)) return v.toUpperCase();
  const hit = state.stations.find((s) => s.name.toLowerCase() === v.toLowerCase());
  return hit ? hit.crs : null;
}

$("railgo").onclick = goRail;
$("railsearch").addEventListener("keydown", (e) => { if (e.key === "Enter") goRail(); });

async function goRail() {
  const crs = crsFromInput($("railsearch").value);
  const el = $("railboard");
  if (!crs) { el.innerHTML = '<div class="empty">Pick a station from the list or type its 3-letter CRS code.</div>'; return; }
  if (!state.config.darwin) {
    el.innerHTML = `<div class="keyhint">National Rail boards need a free Darwin key:<br>
      1. Register at <a href="https://raildata.org.uk" target="_blank" rel="noopener">raildata.org.uk</a><br>
      2. Subscribe to the <b>Live Departure Board</b> product (instant, free to 5M req/4-weeks)<br>
      3. Put the Consumer key in <code>uk_transit_live/.env</code> as <code>DARWIN_API_KEY=…</code><br>
      4. Restart the server.</div>`;
    return;
  }
  state.railCrs = crs;
  clearInterval(state.railTimer);
  await renderRail();
  state.railTimer = setInterval(renderRail, 30000);
}

async function renderRail() {
  if (!state.railCrs) return;
  const el = $("railboard");
  let b;
  try { b = await api(`/api/rail/board/${state.railCrs}`); }
  catch (e) { el.innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`; return; }
  state.railBoard = b;              // kept so the filter re-renders without refetching
  $("railfilterrow").style.display = "";
  renderRailRows();
}

// Which trains from this board call at the station the user typed?
// Matches the destination OR any calling point, by name substring or exact
// CRS code; a matched calling point also shows its arrival time on the row.
function railServiceMatch(s, q) {
  if (!q) return { ok: true };
  const Q = q.toUpperCase();
  if ((s.destination || "").toLowerCase().includes(q) || s.destCrs === Q) return { ok: true };
  const hit = (s.calls || []).find(
    (c) => (c.name || "").toLowerCase().includes(q) || c.crs === Q);
  return hit ? { ok: true, call: hit } : { ok: false };
}

function renderRailRows() {
  const b = state.railBoard;
  if (!b) return;
  const el = $("railboard");
  const q = ($("railfilter").value || "").trim().toLowerCase();
  let shown = 0;
  const rows = b.services.map((s) => {
    const m = railServiceMatch(s, q);
    if (!m.ok) return "";
    shown++;
    const cls = s.cancelled ? "cancelled" : s.delayed ? "delayed" : "";
    const why = s.cancelReason || s.delayReason;
    const callNote = m.call
      ? ` · <b>calls ${escapeHtml(m.call.name)}${m.call.time ? " " + escapeHtml(m.call.time) : ""}</b>`
      : "";
    return `<div class="arr ${cls}">
      <div class="due">${escapeHtml(s.std || "")}</div>
      <div class="dest">${s.destCrs
          ? `<span class="jump" data-crs="${escapeHtml(s.destCrs)}">${escapeHtml(s.destination)}</span>`
          : escapeHtml(s.destination)}
        <div class="sub">${escapeHtml(s.etd || "")}${s.operator ? " · " + escapeHtml(s.operator) : ""}${callNote}${why ? "<br>" + escapeHtml(why) : ""}</div>
      </div>
      ${s.platform ? `<div class="plat">Plat ${escapeHtml(String(s.platform))}</div>` : ""}
    </div>`;
  }).join("");
  el.innerHTML = `
    <h3>${escapeHtml(b.station)}</h3>
    <div class="gen">Live departures · refreshes every 30s</div>
    ${b.messages.map((m) => `<div class="boardmsg">${escapeHtml(m)}</div>`).join("")}
    ${rows || (q
      ? `<div class="empty">None of the next ${b.services.length} departures call at “${escapeHtml($("railfilter").value.trim())}”.</div>`
      : '<div class="empty">No services shown.</div>')}`;
}
$("railfilter").addEventListener("input", renderRailRows);

/* ---------- tabs & sources ---------- */
for (const t of document.querySelectorAll(".tab")) {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tabpane").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $(`tab-${t.dataset.tab}`).classList.add("active");
    if (t.dataset.tab === "favs") renderFavs();
  };
}

function renderSources() {
  const c = state.config;
  $("sources").innerHTML = `
    <span class="source on">TfL ${c.tflKeyed ? "(keyed)" : "(anon)"}</span>
    <span class="source ${c.darwin ? "on" : ""}">National Rail ${c.darwin ? "" : "— add key"}</span>
    <span class="source ${c.bods ? "on" : ""}">Bus GPS ${c.bods ? "" : "— add key"}</span>`;
}

/* ---------- boot ---------- */
(async function boot() {
  try { state.config = await api("/api/config"); } catch {}
  renderSources();
  syncZoomUI();   // layers exist now — apply the zoom-based visibility rules
  try { await loadStatus(); }
  catch (e) { $("linelist").innerHTML = `<div class="empty">Couldn't load line status (${escapeHtml(e.message)}). Retrying…</div>`; }
  try { await initialLines(); } catch {}
  // First data pulls; recurring scheduling is handled by pump() (worker-driven
  // every 1s, immune to background-tab throttling) plus a plain fallback timer.
  _due.status = _due.tfl = _due.nr = Date.now();
  pollVehicles();
  pollNR();
  refreshBuses();
  _due.bus = Date.now();
  loadStations();
  setInterval(pump, 1000);
  map.on("moveend", () => { if (state.bodsOn) { _due.bus = Date.now(); refreshBuses(); } });

  // Open where you are - without the popup, and without a prompt every time.
  //
  // The old behaviour geolocated on launch AND opened the nearest stop's
  // board; the board popping up unasked was the objectionable part, so it
  // stays gone. What returns is only the map centring.
  //
  // Two-stage, which is what removes the "keeps asking" feeling:
  //   1. If we already know roughly where you were, go there immediately.
  //      Instant, offline-safe, and triggers NO permission prompt at all.
  //   2. Then refresh the real fix quietly in the background. On a first ever
  //      visit that is the only stage, so iOS asks exactly once; after that
  //      the map is already correct before the answer arrives.
  const last = loadLastPos();
  if (last) map.setView([last.lat, last.lon], 14);
  // Only fetch a fresh fix when the OS says permission is ALREADY granted -
  // then it is silent. iOS often forgets web geolocation grants between
  // sessions, so an unconditional getCurrentPosition here meant a permission
  // popup on every single open. Now: no silent grant -> no prompt; locating
  // is on demand via the map bar button, and the remembered position above
  // still opens the map in the right place either way.
  let silentOk = false;
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: "geolocation" });
      silentOk = st.state === "granted";
    }
  } catch {}
  if (silentOk && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        drawUserPos(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
        // Don't yank the map if you have already started panning somewhere.
        if (!state._userMoved) map.setView(state.userPos, Math.max(map.getZoom(), 14));
      },
      () => {},                       // denied or unavailable: keep the last view
      { timeout: 8000, maximumAge: 600000 });
  }
})();

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
  seqs: { tfl: 0, nr: 0, bods: 0 },   // per-family poll counters for vehicle cleanup
  nrOn: true,                // national rail trains (works once Darwin key added)
  railStationLayer: null,
  ormLayer: null,            // OpenRailwayMap overlay
  board: { stopId: null, timer: null },
  railCrs: null,
  railTimer: null,
  stations: [],
};

/* ---------- map ---------- */
const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView(UK, 6);
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
$("menubtn").onclick = () => document.getElementById("sidebar").classList.toggle("open");
map.on("click popupopen", () => {
  if (window.innerWidth <= 480) document.getElementById("sidebar").classList.remove("open");
});

$("ukbtn").onclick = () => map.setView(UK, 6);
$("londonbtn").onclick = () => map.setView(LONDON, 12);

// Progressive disclosure: what renders depends on zoom.
//   < 9   country view — city chips only, no vehicles/lines
//   9-12  city view    — small icons (12px)
//   13-14 district     — medium icons (18px)
//   15+   street       — full-detail icons (28px)
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
  if (detail) cityChipLayer.clearLayers();
  updateCounter();
}
map.on("zoomend", syncZoomUI);
syncZoomUI();

// Place search (Nominatim, free) + geolocation — users start from intent,
// not from panning across Britain.
$("placesearch").addEventListener("keydown", (e) => { if (e.key === "Enter") searchPlace(); });
$("placego").onclick = searchPlace;
$("locbtn").onclick = () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (p) => map.setView([p.coords.latitude, p.coords.longitude], 15),
    () => { $("placeresults").innerHTML = '<div class="empty">Couldn\'t get your location.</div>'; },
    { timeout: 8000 });
};

async function searchPlace() {
  const q = $("placesearch").value.trim();
  if (!q) return;
  const el = $("placeresults");
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
      d.onclick = () => { map.setView([+m.lat, +m.lon], 15); el.innerHTML = ""; };
      el.appendChild(d);
    }
  } catch { el.innerHTML = '<div class="empty">Search failed — try again.</div>'; }
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
state.treeOpen = state.treeOpen || new Set(["nr", "london", "tube"]);

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
  const cityRows = CITIES.map(([name, la, lo]) => {
    const n = state.cityCounts && state.cityCounts[name];
    return `<div class="linerow cityrow" data-city="${la},${lo}">
      <div class="linemeta"><div class="linename">${escapeHtml(name)}</div></div>
      <div class="citycount">${n ? "\u2248" + n.toLocaleString() + " \ud83d\ude8c" : ""}</div></div>`;
  }).join("");

  el.innerHTML =
    grpH("nr", `\ud83d\ude84 National Rail \u2014 ${nr} trains tracked`,
      '<div class="hint" style="padding:4px 8px 8px">Yellow trains run across the whole map. Click any train for its calling points and delay.</div>') +
    grpH("london", "London network",
      mk("tube", "\u24c2 Metro \u2014 Underground", ["tube"]) +
      mk("lrail", "\ud83d\ude86 Train \u2014 Elizabeth \u00b7 DLR \u00b7 Overground", ["elizabeth-line", "dlr", "overground"]) +
      mk("tram", "\ud83d\ude8a Tram", ["tram"]) +
      mk("ferry", "\u26f4 Ferry \u2014 river bus", ["river-bus"])) +
    grpH("cities", "Cities \u2014 live buses",
      '<div class="hint" style="padding:4px 8px 4px">Tap a city to fly there. Buses live everywhere in England; Scotland/Wales have timetables + sparse live.</div>' + cityRows);
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
      radius: isBus ? 3 : 3.5, color: "#fff", weight: 1, fillColor: g.colour, fillOpacity: 1,
    }).addTo(grp);
    m.bindTooltip(escapeHtml(s.name), { direction: "top", opacity: 0.9 });
    m.on("click", () => openBoard(s.naptan || s.id, s.name));
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
function vehIcon(kind, colour, flip, cars) {
  const ck = `${kind}|${colour}|${flip ? 1 : 0}|${cars || 0}`;
  let ic = _iconCache.get(ck);
  if (ic) return ic;
  const svg = kind === "bus" ? busSvg(colour) : kind === "tram" ? tramSvg(colour)
    : kind === "boat" ? boatSvg(colour) : kind === "coach" ? coachSvg(colour)
    : trainSvg(colour, cars);
  const w = kind === "train" ? clamp(cars || 4, 2, 9) * 11 : 28;
  ic = L.divIcon({
    className: "vehwrap",
    html: `<div class="vbox${flip ? " flip" : ""}">${svg}</div>`,
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
  const dx = (v.b.lon - v.a.lon) * Math.cos(((v.a.lat + v.b.lat) / 2) * Math.PI / 180);
  const dy = v.b.lat - v.a.lat;
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
  const want = inViewPad(pos[0], pos[1]) && state.modeFilter.has(v.kind || "train");
  if (want && !v.marker) {
    const marker = L.marker(pos, {
      icon: vehIcon(v.kind || "train", v.colour, v.flip, v.cars),
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
    const ik = `${v.kind}|${v.colour}|${v.flip ? 1 : 0}|${v.cars || 0}`;
    if (v._iconKey !== ik) { v.marker.setIcon(vehIcon(v.kind, v.colour, v.flip, v.cars)); v._iconKey = ik; }
  }
  applyHeading(v);
}

function syncMarkers() {
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
}

/* Rich click-through detail per vehicle: onward stops + expected times where
 * the data exists (TfL vehicles + London buses + national trains); honest
 * fallback where it doesn't (non-London buses: England publishes GPS only). */
function popRow(name, right, terminal, stopId) {
  const nameHtml = stopId
    ? `<span class="jump" data-stop="${escapeHtml(stopId)}">${escapeHtml(name)}</span>`
    : `<span>${escapeHtml(name)}</span>`;
  return `<div class="poprow${terminal ? " term" : ""}">${nameHtml}<span>${escapeHtml(right)}</span></div>`;
}

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
  openBoard(stopId, st.name || fallbackName || "Stop", st.lat, st.lon);
}

// One delegated listener: any .jump element inside any popup flies to its stop.
map.on("popupopen", (e) => {
  const node = e.popup.getElement();
  if (!node) return;
  node.addEventListener("click", (ev) => {
    const j = ev.target.closest(".jump");
    if (j && j.dataset.stop) jumpToStop(j.dataset.stop, j.textContent);
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
        radius: 4, color: "#fff", weight: 1.2, fillColor: g.colour, fillOpacity: 1,
      }).addTo(highlightLayer);
      m.bindTooltip(escapeHtml(s.name), { direction: "top" });
      m.on("click", () => openBoard(s.naptan || s.id, s.name, s.lat, s.lon));
    }
    highlightLayer.addTo(map);
  }
}

function clearHighlight() {
  if (highlightLayer) { map.removeLayer(highlightLayer); highlightLayer = null; }
  if (highlighted) { highlighted = null; setLineEmphasis(null); }
}
map.on("popupclose", clearHighlight);

async function vehicleDetailHtml(family, v) {
  let head = `<b>${escapeHtml(v.label || "")}</b>${v.dest ? " → " + escapeHtml(v.dest) : ""}`;
  let rows = "";
  try {
    if (family === "nr" && v.id) {
      const d = await api(`/api/rail/train/${v.id}`);
      head = `<b>${escapeHtml(d.operator || "Train")}</b> → ${escapeHtml(d.dest || "?")}`;
      rows = d.stops.map((s, i) =>
        popRow(s.name, s.mins <= 0 ? "now" : `${s.mins} min`, i === d.stops.length - 1)).join("");
    } else if (family === "tfl" && v.vehId) {
      highlightRoute(v.line);
      const arr = await api(`/api/vehicle/${v.vehId}?line=${encodeURIComponent(v.line || "")}`);
      rows = arr.slice(0, 14).map((s, i) => popRow(s.stop, dueText(s.tts), i === arr.length - 1, s.stopId)).join("");
      if (!rows) rows = '<div class="popnote">No onward predictions right now.</div>';
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
        bits.push('<div class="popnote">Times are the operator’s schedule from the live feed. Full stop-by-stop lists need timetable matching — planned as v2.</div>');
        rows = bits.join("");
      }
    }
  } catch (e) {
    rows = `<div class="popnote">Couldn't load details (${escapeHtml(e.message)})</div>`;
  }
  return `<div class="pop"><div class="pophead">${head}</div>${rows}</div>`;
}

function updateCounter() {
  const z = map.getZoom();
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
  $("livecount").textContent = n ? `${n.toLocaleString()} vehicles on map${hint}` : "";
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
  return [v.a.lat + (v.b.lat - v.a.lat) * f, v.a.lon + (v.b.lon - v.a.lon) * f];
}

function animateTick() {
  if (!map.hasLayer(state.vehicleLayer)) return;   // country view: nothing to animate
  const t = clock();
  for (const v of state.vehicles.values()) {
    if (v.marker) v.marker.setLatLng(positionOf(v, t));
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
  $("board-body").innerHTML = await boardRowsFor(state.board.stopId, state.board.lat, state.board.lon, 14);
}

// Live times where they exist (London/TfL); GPS-based ESTIMATES elsewhere in
// England (v1 of our own prediction engine: an approaching bus's heading +
// distance at urban speed). Timetable-matched v2 is on the roadmap.
async function boardRowsFor(stopId, lat, lon, maxRows) {
  const isLondon = LONDON_STOP_RE.test(stopId);
  let arrs = [];
  try { arrs = await api(`/api/arrivals/${stopId}`); } catch {}
  if (arrs.length) return groupRowsHtml(arrs, maxRows);

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
      const rows = [...groups.values()]
        .sort((a, b) => a.entries[0].expectedSecs - b.entries[0].expectedSecs)
        .slice(0, maxRows).map((g) => {
          const times = g.entries.map((x) => {
            const chip = x.delayMin == null ? "" : Math.abs(x.delayMin) < 2 ? "•" : x.delayMin > 0 ? `+${x.delayMin}` : `${x.delayMin}`;
            return `${x.mins <= 0 ? "due" : x.mins + " min"}${x.live ? ` <span class="livechip${x.delayMin > 1 ? " late" : ""}">${chip || "live"}</span>` : ""}`;
          }).join(", ");
          return `
            <div class="arr">
              <div class="routeno">${escapeHtml(g.line || "?")}</div>
              <div class="dest">${escapeHtml(g.headsign || "?")}
                <div class="sub">${g.entries.map((x) => hhmm(x.expectedSecs)).join(", ")}</div>
              </div>
              <div class="due">${times}</div>
            </div>`;
        }).join("");
      return '<div class="estnote ok">Timetable departures · <b>live</b>-tagged rows are delay-adjusted from the bus\'s GPS.</div>' + rows;
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
  const rows = [...g.values()].sort((x, y) => x.times[0] - y.times[0]).slice(0, maxRows).map((r) => `
    <div class="arr">
      <div class="routeno">${escapeHtml(r.line || "?")}</div>
      <div class="dest">${escapeHtml((r.dest || "?").replace(/_/g, " "))}</div>
      <div class="due">${r.times.map((t) => `~${t} min`).join(", ")}</div>
    </div>`).join("");
  return '<div class="estnote">≈ Estimated from live GPS (bus heading &amp; distance).</div>' + rows;
}

// Group by route + destination: one row per service, next two times together —
// a commuter reads "73 → Stoke Newington: 3 min, 11 min" at a glance.
function groupRowsHtml(arrs, maxRows) {
  const groups = new Map();
  for (const a of arrs) {
    const gk = `${a.lineName || "?"}|${a.destination || ""}`;
    if (!groups.has(gk)) groups.set(gk, { line: a.lineName, dest: a.destination, platform: a.platform, times: [] });
    const g = groups.get(gk);
    if (g.times.length < 2 && a.timeToStation != null) g.times.push(a.timeToStation);
  }
  const rows = [...groups.values()].sort((x, y) => (x.times[0] ?? 1e9) - (y.times[0] ?? 1e9));
  return rows.slice(0, maxRows).map((g) => `
    <div class="arr">
      <div class="routeno">${escapeHtml(g.line || "?")}</div>
      <div class="dest">
        ${escapeHtml(g.dest || "?")}
        ${g.platform ? `<div class="sub">${escapeHtml(g.platform)}</div>` : ""}
      </div>
      <div class="due">${g.times.map(dueText).join(", ") || "—"}</div>
    </div>`).join("");
}

/* ---------- favourites: starred stops + lines -> live dashboard ---------- */
state.favs = (() => {
  try { return JSON.parse(localStorage.getItem("ukt_favs")) || { stops: [], lines: [] }; }
  catch { return { stops: [], lines: [] }; }
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
  if (!state.favs.lines.length && !state.favs.stops.length) {
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
  el.innerHTML = linesHtml + (state.favs.stops.length ? '<div class="empty">Loading live times…</div>' : "");
  if (!state.favs.stops.length) return;
  const blocks = await Promise.all(state.favs.stops.map(async (s) => {
    let rows;
    try { rows = await boardRowsFor(s.id, s.lat, s.lon, 4); }
    catch (e) { rows = `<div class="empty">${escapeHtml(e.message)}</div>`; }
    return `<div class="favstop">
      <div class="favname"><span class="jumpfav" data-id="${escapeHtml(s.id)}">${escapeHtml(s.name)}</span>
      <span class="unstar" data-id="${escapeHtml(s.id)}" title="Remove">★</span></div>${rows}</div>`;
  }));
  el.innerHTML = linesHtml + blocks.join("");
}

$("favlist").addEventListener("click", (ev) => {
  const un = ev.target.closest(".unstar");
  if (un) { state.favs.stops = state.favs.stops.filter((s) => s.id !== un.dataset.id); saveFavs(); return; }
  const j = ev.target.closest(".jumpfav");
  if (j) jumpToStop(j.dataset.id, j.textContent);
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
    const m = L.circleMarker([lat, lon], {
      radius: 3.5, color: "#fff", weight: 1, fillColor: "#DC241F", fillOpacity: 0.95,
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
  return {
    key: id,
    vehId: id,
    a: from,
    b: { lat, lon },
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
    if (!est) continue;
    const m = L.marker([clat, clon], {
      icon: L.divIcon({
        className: "chipwrap",
        html: `<div class="citychip">${escapeHtml(name)}<span>≈${est.toLocaleString()} live 🚌</span></div>`,
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
      state.busTotal = state.busShown = vs.length;
      targets = vs.map((v) => busTarget(v.id, v.lat, v.lon, `Bus ${v.line || ""}`.trim(), v.destination, v.operator, v.bearing, v.line,
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
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 3, color: "#5b6773", weight: 1, fillColor: "#ffffff", fillOpacity: 0.9,
    }).addTo(grp);
    m.bindTooltip(`${escapeHtml(s.name)} (${escapeHtml(s.crs)}) — rail`, { direction: "top" });
    m.on("click", () => {
      document.querySelector('.tab[data-tab="rail"]').click();
      $("railsearch").value = `${s.name} (${s.crs})`;
      goRail();
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
  const rows = b.services.map((s) => {
    const cls = s.cancelled ? "cancelled" : s.delayed ? "delayed" : "";
    const why = s.cancelReason || s.delayReason;
    return `<div class="arr ${cls}">
      <div class="due">${escapeHtml(s.std || "")}</div>
      <div class="dest">${escapeHtml(s.destination)}
        <div class="sub">${escapeHtml(s.etd || "")}${s.operator ? " · " + escapeHtml(s.operator) : ""}${why ? "<br>" + escapeHtml(why) : ""}</div>
      </div>
      ${s.platform ? `<div class="plat">Plat ${escapeHtml(String(s.platform))}</div>` : ""}
    </div>`;
  }).join("");
  el.innerHTML = `
    <h3>${escapeHtml(b.station)}</h3>
    <div class="gen">Live departures · refreshes every 30s</div>
    ${b.messages.map((m) => `<div class="boardmsg">${escapeHtml(m)}</div>`).join("")}
    ${rows || '<div class="empty">No services shown.</div>'}`;
}

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
})();

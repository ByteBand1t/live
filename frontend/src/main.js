import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/main.css";

import { initMap, updateBusMarkers, renderStationsInViewport, showRouteLine, clearRouteLine, flyTo } from "./map/map.js";
import { connectSocket, updateViewport } from "./socket/socket.js";
import { renderStationPanel, renderBusPanel, showLoadingPanel, closePanel } from "./components/panel.js";

let allStations   = [];
let allVehicles   = [];
let stationsLoaded = false;
let searchTimeout  = null;
let viewportDebounce = null;
let selectedBusId  = null;

const map = initMap();

// ─── Viewport ─────────────────────────────────────────────────────────────────

function sendViewport() {
  clearTimeout(viewportDebounce);
  viewportDebounce = setTimeout(() => {
    updateViewport(map.getBounds());
    if (stationsLoaded) renderStationsInViewport(allStations, handleStationClick);
  }, 400);
}

map.on("load", () => {
  updateViewport(map.getBounds());
  fetch("/api/stations")
    .then((r) => r.json())
    .then((d) => { allStations = d.stations || []; stationsLoaded = true; renderStationsInViewport(allStations, handleStationClick); })
    .catch((e) => console.warn("[Stations]", e.message));
});

map.on("moveend", sendViewport);
map.on("zoomend", () => { sendViewport(); if (allVehicles.length) updateBusMarkers(allVehicles, handleBusClick, selectedBusId); });

// ─── WebSocket ────────────────────────────────────────────────────────────────

const statusIndicator = document.getElementById("status-indicator");
const statusText      = document.getElementById("status-text");
const busCountEl      = document.getElementById("bus-count");
const statsUpdate     = document.getElementById("stats-update");

connectSocket({
  onConnect:    () => { statusIndicator.className = "status-connected";  statusText.textContent = "Live";      updateViewport(map.getBounds()); },
  onDisconnect: () => { statusIndicator.className = "status-error";      statusText.textContent = "Getrennt"; },
  onError:      () => { statusIndicator.className = "status-error";      statusText.textContent = "Fehler";   },
  onVehicleUpdate: ({ vehicles, timestamp, count }) => {
    allVehicles = vehicles;
    updateBusMarkers(vehicles, handleBusClick, selectedBusId);
    busCountEl.textContent = count;
    statsUpdate.textContent = `Zuletzt aktualisiert: ${new Date(timestamp).toLocaleTimeString("de-DE")}`;
  },
});

// ─── Bus Click → Course + Route ───────────────────────────────────────────────

async function handleBusClick(bus) {
  selectedBusId = bus.id;
  updateBusMarkers(allVehicles, handleBusClick, selectedBusId);
  flyTo(bus.lon, bus.lat, 15);
  showLoadingPanel(`Linie ${bus.line}`);

  try {
    // departureCourse via lineId + startStationKey aus dem Journey-Segment
    const res = await fetch("/api/bus-course", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lineKey:       bus.lineId,
        stationKey:    bus.startStationKey,
        startDateTime: bus.startDateTime,
      }),
    });
    const course = await res.json();
    renderBusPanel(bus, course);

    // Route auf der Karte zeichnen
    const stopKeys = (course.stopList || []).map((s) => s.stopPointKey || s.stationKey).filter(Boolean);
    if (stopKeys.length >= 2) {
      const tr = await fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopPointKeys: stopKeys }),
      });
      const td = await tr.json();
      // getTrackCoordinates gibt tracks[] zurück – flache [lon,lat] Arrays
      if (td.tracks?.length) {
        const coords = [];
        for (const t of td.tracks) {
          const pts = t.track || [];
          for (let i = 0; i < pts.length - 1; i += 2) {
            coords.push({ x: pts[i], y: pts[i + 1] });
          }
        }
        if (coords.length) showRouteLine(coords, bus.color || "#E2001A");
      }
    }
  } catch (err) {
    console.error("[BusCourse]", err);
    renderBusPanel(bus, null);
  }
}

// ─── Station Click ────────────────────────────────────────────────────────────

async function handleStationClick(station) {
  selectedBusId = null;
  clearRouteLine();
  showLoadingPanel(station.name);
  flyTo(station.coordinate.x, station.coordinate.y, 15);
  try {
    const res = await fetch(`/api/departures/${encodeURIComponent(station.id)}`);
    const data = await res.json();
    renderStationPanel(station, data.departures, (lineKey, stationId) => handleCourseClick(lineKey, stationId));
  } catch (err) { console.error("[Departures]", err); }
}

async function handleCourseClick(lineKey, stationId) {
  try {
    const res  = await fetch("/api/course", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lineKey, stationId }) });
    const data = await res.json();
    const keys = (data.stopList || []).map((s) => s.stationKey).filter(Boolean);
    if (keys.length) {
      const tr = await fetch("/api/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stopPointKeys: keys }) });
      const td = await tr.json();
      if (td.tracks?.length) {
        const coords = [];
        for (const t of td.tracks) { const pts = t.track||[]; for (let i=0;i<pts.length-1;i+=2) coords.push({x:pts[i],y:pts[i+1]}); }
        if (coords.length) showRouteLine(coords);
      }
    }
    renderBusPanel({ line: lineKey, direction: data.direction || "" }, data);
  } catch (err) { console.error("[Course]", err); }
}

// ─── Search ───────────────────────────────────────────────────────────────────

const searchInput   = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.classList.remove("visible"); return; }
  searchTimeout = setTimeout(() => doSearch(q), 300);
});
searchInput.addEventListener("keydown", (e) => { if (e.key === "Escape") { searchResults.classList.remove("visible"); searchInput.blur(); }});
document.addEventListener("click", (e) => { if (!e.target.closest("#search-container")) searchResults.classList.remove("visible"); });

async function doSearch(q) {
  try {
    const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`);
    const data = await res.json();
    const results = data.results || [];
    searchResults.innerHTML = results.length
      ? results.map((r) => `<div class="search-item" data-id="${r.id}" data-type="${r.type}" data-lon="${r.coordinate?.x||""}" data-lat="${r.coordinate?.y||""}" data-name="${r.name}"><div class="item-name">${r.name}</div><div class="item-type">${r.type}${r.city?" · "+r.city:""}</div></div>`).join("")
      : `<div class="search-item"><div class="item-name">Keine Ergebnisse</div></div>`;
    searchResults.classList.add("visible");
    searchResults.querySelectorAll(".search-item[data-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const { id, type, lon, lat, name } = el.dataset;
        searchResults.classList.remove("visible");
        searchInput.value = name;
        if (lon && lat) flyTo(parseFloat(lon), parseFloat(lat), 15);
        if (type === "STATION" && id) handleStationClick({ id, name, coordinate: { x: parseFloat(lon), y: parseFloat(lat) } });
      });
    });
  } catch (err) { console.error("[Search]", err); }
}

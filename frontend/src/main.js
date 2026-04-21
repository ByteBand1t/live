import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/main.css";

import { initMap, updateBusMarkers, renderStationsInViewport, showRouteLine, flyTo, getMap } from "./map/map.js";
import { connectSocket } from "./socket/socket.js";
import { renderStationPanel, renderBusPanel, showLoadingPanel } from "./components/panel.js";

// ─── State ────────────────────────────────────────────────────────────────────

let allStations = [];
let allVehicles = [];
let stationsLoaded = false;
let searchTimeout = null;
let viewportDebounce = null;

// ─── Init Map ─────────────────────────────────────────────────────────────────

const map = initMap();

map.on("load", async () => {
  // Stationen im Hintergrund laden – KEIN Rendern beim Laden
  fetch("/api/stations")
    .then((r) => r.json())
    .then((data) => {
      allStations = data.stations || [];
      stationsLoaded = true;
      console.log(`[Stations] ${allStations.length} Haltestellen geladen`);
      // Erst rendern wenn Karte fertig
      renderStationsDebounced();
    })
    .catch((err) => console.warn("[Stations] Fehler:", err.message));
});

// Neu rendern wenn Karte bewegt oder gezoomt wird – mit Debounce
map.on("moveend", renderStationsDebounced);
map.on("zoomend", () => {
  renderStationsDebounced();
  // Bus-Marker bei Zoom-Änderung neu filtern
  if (allVehicles.length > 0) {
    updateBusMarkers(allVehicles, handleBusClick);
  }
});

function renderStationsDebounced() {
  clearTimeout(viewportDebounce);
  viewportDebounce = setTimeout(() => {
    if (stationsLoaded) {
      renderStationsInViewport(allStations, handleStationClick);
    }
  }, 300); // 300ms nach Ende der Bewegung
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

const statusIndicator = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const busCountEl = document.getElementById("bus-count");
const statsUpdate = document.getElementById("stats-update");

connectSocket({
  onConnect: () => {
    statusIndicator.className = "status-connected";
    statusText.textContent = "Live";
  },
  onDisconnect: () => {
    statusIndicator.className = "status-error";
    statusText.textContent = "Getrennt";
  },
  onError: () => {
    statusIndicator.className = "status-error";
    statusText.textContent = "Fehler";
  },
  onVehicleUpdate: ({ vehicles, timestamp, count }) => {
    allVehicles = vehicles;
    updateBusMarkers(vehicles, handleBusClick);
    busCountEl.textContent = count;
    const t = new Date(timestamp);
    statsUpdate.textContent = `Update: ${t.toLocaleTimeString("de-DE")}`;
  },
});

// ─── Station Click ────────────────────────────────────────────────────────────

async function handleStationClick(station) {
  showLoadingPanel(station.name);
  flyTo(station.coordinate.x, station.coordinate.y, 15);
  try {
    const res = await fetch(`/api/departures/${encodeURIComponent(station.id)}`);
    const data = await res.json();
    renderStationPanel(station, data.departures, (lineKey, stationId) =>
      handleCourseClick(lineKey, stationId)
    );
  } catch (err) {
    console.error("[Departures] Error:", err);
  }
}

// ─── Bus Click ────────────────────────────────────────────────────────────────

function handleBusClick(bus) {
  flyTo(bus.lon, bus.lat, 15);
  renderBusPanel(bus, null);
}

// ─── Course Click ─────────────────────────────────────────────────────────────

async function handleCourseClick(lineKey, stationId) {
  try {
    const res = await fetch("/api/course", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineKey, stationId }),
    });
    const data = await res.json();

    if (data.stopList?.length >= 2) {
      const stopPointKeys = data.stopList.map((s) => s.stationKey).filter(Boolean);
      if (stopPointKeys.length) {
        const trackRes = await fetch("/api/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stopPointKeys }),
        });
        const trackData = await trackRes.json();
        if (trackData.coordinates?.length) showRouteLine(trackData.coordinates);
      }
    }
    renderBusPanel({ line: lineKey, direction: data.direction || "" }, data);
  } catch (err) {
    console.error("[Course] Error:", err);
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────

const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    searchResults.classList.remove("visible");
    return;
  }
  searchTimeout = setTimeout(() => doSearch(q), 300);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { searchResults.classList.remove("visible"); searchInput.blur(); }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-container")) searchResults.classList.remove("visible");
});

async function doSearch(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`);
    const data = await res.json();
    const results = data.results || [];

    searchResults.innerHTML = results.length
      ? results.map((r) => `
          <div class="search-item" data-id="${r.id}" data-type="${r.type}"
               data-lon="${r.coordinate?.x || ""}" data-lat="${r.coordinate?.y || ""}"
               data-name="${r.name}">
            <div class="item-name">${r.name}</div>
            <div class="item-type">${r.type}${r.city ? " · " + r.city : ""}</div>
          </div>`).join("")
      : `<div class="search-item"><div class="item-name">Keine Ergebnisse</div></div>`;

    searchResults.classList.add("visible");

    searchResults.querySelectorAll(".search-item[data-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const { id, type, lon, lat, name } = el.dataset;
        searchResults.classList.remove("visible");
        searchInput.value = name;
        if (lon && lat) flyTo(parseFloat(lon), parseFloat(lat), 15);
        if (type === "STATION" && id) {
          handleStationClick({
            id, name,
            coordinate: { x: parseFloat(lon), y: parseFloat(lat) },
          });
        }
      });
    });
  } catch (err) {
    console.error("[Search] Error:", err);
  }
}

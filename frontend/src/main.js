/**
 * Hamburg Bus Live – Main Entry Point
 * Wires together: Map, Socket, Search, Panel
 */

import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/main.css";

import { initMap, updateBusMarkers, renderStations, showRouteLine, flyTo } from "./map/map.js";
import { connectSocket, requestDepartures } from "./socket/socket.js";
import { renderStationPanel, renderBusPanel, showLoadingPanel, closePanel } from "./components/panel.js";

// ─── State ────────────────────────────────────────────────────────────────────

let allStations = [];
let searchTimeout = null;

// ─── Init Map ─────────────────────────────────────────────────────────────────

const map = initMap();

map.on("load", async () => {
  // Load stations list (cached 24h on backend)
  try {
    const res = await fetch("/api/stations");
    const data = await res.json();
    allStations = data.stations || [];

    // Only show station dots when zoomed in enough
    map.on("zoomend", () => {
      const zoom = map.getZoom();
      if (zoom >= 13) {
        renderStations(allStations, handleStationClick);
      }
    });
  } catch (err) {
    console.warn("[Stations] Could not load stations:", err.message);
  }
});

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
    updateBusMarkers(vehicles, handleBusClick);
    busCountEl.textContent = count;

    const t = new Date(timestamp);
    statsUpdate.textContent = `Update: ${t.toLocaleTimeString("de-DE")}`;
  },
});

// ─── Station Click → Departures ───────────────────────────────────────────────

async function handleStationClick(station) {
  showLoadingPanel(station.name);
  flyTo(station.coordinate.x, station.coordinate.y, 15);

  try {
    const res = await fetch(`/api/departures/${encodeURIComponent(station.id)}`);
    const data = await res.json();

    renderStationPanel(station, data.departures, async (lineKey, stationId) => {
      await handleCourseClick(lineKey, stationId);
    });
  } catch (err) {
    console.error("[Departures] Error:", err);
  }
}

// ─── Bus Click → Bus Detail + Route ──────────────────────────────────────────

async function handleBusClick(bus) {
  showLoadingPanel(`Linie ${bus.line} → ${bus.direction}`);
  flyTo(bus.lon, bus.lat, 14);

  // We don't have a lineKey directly on the vehicle, so show basic info
  // The full course requires a lineKey from departureList
  renderBusPanel(bus, null);
}

// ─── Line Click → Full Course + Route Geometry ───────────────────────────────

async function handleCourseClick(lineKey, stationId) {
  try {
    const res = await fetch("/api/course", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineKey, stationId }),
    });
    const data = await res.json();

    // Draw route line on map
    if (data.stopList?.length >= 2) {
      const stopPointKeys = data.stopList
        .map((s) => s.stationKey)
        .filter(Boolean);

      if (stopPointKeys.length) {
        const trackRes = await fetch("/api/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stopPointKeys }),
        });
        const trackData = await trackRes.json();

        if (trackData.coordinates?.length) {
          showRouteLine(trackData.coordinates);
        }
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
    searchResults.innerHTML = "";
    return;
  }

  searchTimeout = setTimeout(() => doSearch(q), 300);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchResults.classList.remove("visible");
    searchInput.blur();
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-container")) {
    searchResults.classList.remove("visible");
  }
});

async function doSearch(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`);
    const data = await res.json();
    const results = data.results || [];

    if (!results.length) {
      searchResults.innerHTML = `<div class="search-item"><div class="item-name">Keine Ergebnisse</div></div>`;
    } else {
      searchResults.innerHTML = results
        .map(
          (r) => `
        <div class="search-item" data-id="${r.id}" data-type="${r.type}"
             data-lon="${r.coordinate?.x || ""}" data-lat="${r.coordinate?.y || ""}"
             data-name="${r.name}">
          <div class="item-name">${r.name}</div>
          <div class="item-type">${r.type} ${r.city ? "· " + r.city : ""}</div>
        </div>`
        )
        .join("");
    }

    searchResults.classList.add("visible");

    searchResults.querySelectorAll(".search-item").forEach((el) => {
      el.addEventListener("click", () => {
        const { id, type, lon, lat, name } = el.dataset;
        searchResults.classList.remove("visible");
        searchInput.value = name;

        if (lon && lat) flyTo(parseFloat(lon), parseFloat(lat), 15);

        if (type === "STATION" && id) {
          handleStationClick({ id, name, coordinate: { x: parseFloat(lon), y: parseFloat(lat) } });
        }
      });
    });
  } catch (err) {
    console.error("[Search] Error:", err);
  }
}

// KEIN CSS-Import hier – läuft bereits über index.html
import "./styles/main.css";

import { initMap, updateBusMarkers, renderStationsInViewport, showRouteLine, clearRouteLine, flyTo } from "./map/map.js";
import { connectSocket, updateViewport } from "./socket/socket.js";
import { renderStationPanel, renderBusPanel, showLoadingPanel } from "./components/panel.js";

let allStations    = [];
let allVehicles    = [];
let stationsLoaded = false;
let searchTimeout  = null;
let viewportDebounce = null;
let selectedBusId  = null;

const map = initMap();

// ─── Viewport ─────────────────────────────────────────────────────────────────

function sendViewport() {
  clearTimeout(viewportDebounce);
  viewportDebounce = setTimeout(function() {
    updateViewport(map.getBounds());
    if (stationsLoaded) {
      renderStationsInViewport(allStations, handleStationClick);
    }
  }, 400);
}

map.on("load", function() {
  updateViewport(map.getBounds());

  fetch("/api/stations")
    .then(function(r) { return r.json(); })
    .then(function(d) {
      allStations    = d.stations || [];
      stationsLoaded = true;
      renderStationsInViewport(allStations, handleStationClick);
    })
    .catch(function(e) { console.warn("[Stations]", e.message); });
});

map.on("moveend", sendViewport);

map.on("zoomend", function() {
  sendViewport();
  if (allVehicles.length) {
    updateBusMarkers(allVehicles, handleBusClick, selectedBusId);
  }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

var statusIndicator = document.getElementById("status-indicator");
var statusText      = document.getElementById("status-text");
var busCountEl      = document.getElementById("bus-count");
var statsUpdate     = document.getElementById("stats-update");

connectSocket({
  onConnect: function() {
    statusIndicator.className = "status-connected";
    statusText.textContent    = "Live";
    updateViewport(map.getBounds());
  },
  onDisconnect: function() {
    statusIndicator.className = "status-error";
    statusText.textContent    = "Getrennt";
  },
  onError: function() {
    statusIndicator.className = "status-error";
    statusText.textContent    = "Fehler";
  },
  onVehicleUpdate: function(data) {
    allVehicles = data.vehicles;
    updateBusMarkers(data.vehicles, handleBusClick, selectedBusId);
    busCountEl.textContent  = data.count;
    statsUpdate.textContent = "Zuletzt: " + new Date(data.timestamp).toLocaleTimeString("de-DE");
  },
});

// ─── Bus Click ────────────────────────────────────────────────────────────────

async function handleBusClick(bus) {
  selectedBusId = bus.id;
  updateBusMarkers(allVehicles, handleBusClick, selectedBusId);
  flyTo(bus.lon, bus.lat, 15);
  showLoadingPanel("Linie " + bus.line);

  try {
    var res    = await fetch("/api/bus-course", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        lineKey:       bus.lineId,
        stationKey:    bus.startStationKey,
        startDateTime: bus.startDateTime,
      }),
    });
    var course = await res.json();
    renderBusPanel(bus, course);

    var stopKeys = (course.stopList || [])
      .map(function(s) { return s.stopPointKey || s.stationKey; })
      .filter(Boolean);

    if (stopKeys.length >= 2) {
      var tr = await fetch("/api/track", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ stopPointKeys: stopKeys }),
      });
      var td = await tr.json();
      if (td.tracks && td.tracks.length) {
        var coords = [];
        for (var i = 0; i < td.tracks.length; i++) {
          var pts = td.tracks[i].track || [];
          for (var j = 0; j < pts.length - 1; j += 2) {
            coords.push({ x: pts[j], y: pts[j + 1] });
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
    var res  = await fetch("/api/departures/" + encodeURIComponent(station.id));
    var data = await res.json();
    renderStationPanel(station, data.departures, handleCourseClick);
  } catch (err) {
    console.error("[Departures]", err);
  }
}

async function handleCourseClick(lineKey, stationId) {
  try {
    var res  = await fetch("/api/course", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ lineKey: lineKey, stationId: stationId }),
    });
    var data = await res.json();
    var keys = (data.stopList || []).map(function(s) { return s.stationKey; }).filter(Boolean);

    if (keys.length) {
      var tr = await fetch("/api/track", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ stopPointKeys: keys }),
      });
      var td = await tr.json();
      if (td.tracks && td.tracks.length) {
        var coords = [];
        for (var i = 0; i < td.tracks.length; i++) {
          var pts = td.tracks[i].track || [];
          for (var j = 0; j < pts.length - 1; j += 2) {
            coords.push({ x: pts[j], y: pts[j + 1] });
          }
        }
        if (coords.length) showRouteLine(coords);
      }
    }
    renderBusPanel({ line: lineKey, direction: data.direction || "" }, data);
  } catch (err) {
    console.error("[Course]", err);
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────

var searchInput   = document.getElementById("search-input");
var searchResults = document.getElementById("search-results");

searchInput.addEventListener("input", function() {
  clearTimeout(searchTimeout);
  var q = searchInput.value.trim();
  if (q.length < 2) {
    searchResults.classList.remove("visible");
    return;
  }
  searchTimeout = setTimeout(function() { doSearch(q); }, 300);
});

searchInput.addEventListener("keydown", function(e) {
  if (e.key === "Escape") {
    searchResults.classList.remove("visible");
    searchInput.blur();
  }
});

document.addEventListener("click", function(e) {
  if (!e.target.closest("#search-container")) {
    searchResults.classList.remove("visible");
  }
});

async function doSearch(q) {
  try {
    var res     = await fetch("/api/search?q=" + encodeURIComponent(q) + "&limit=8");
    var data    = await res.json();
    var results = data.results || [];

    if (!results.length) {
      searchResults.innerHTML = '<div class="search-item"><div class="item-name">Keine Ergebnisse</div></div>';
    } else {
      var html = "";
      for (var i = 0; i < results.length; i++) {
        var r    = results[i];
        var lon  = (r.coordinate && r.coordinate.x) ? r.coordinate.x : "";
        var lat  = (r.coordinate && r.coordinate.y) ? r.coordinate.y : "";
        var city = r.city ? " &middot; " + r.city : "";
        html += '<div class="search-item" data-id="' + r.id + '" data-type="' + r.type + '" data-lon="' + lon + '" data-lat="' + lat + '" data-name="' + r.name + '">';
        html += '<div class="item-name">' + r.name + '</div>';
        html += '<div class="item-type">' + r.type + city + '</div>';
        html += '</div>';
      }
      searchResults.innerHTML = html;
    }

    searchResults.classList.add("visible");

    searchResults.querySelectorAll(".search-item[data-id]").forEach(function(el) {
      el.addEventListener("click", function() {
        var id   = el.dataset.id;
        var type = el.dataset.type;
        var lon  = el.dataset.lon;
        var lat  = el.dataset.lat;
        var name = el.dataset.name;

        searchResults.classList.remove("visible");
        searchInput.value = name;

        if (lon && lat) flyTo(parseFloat(lon), parseFloat(lat), 15);

        if (type === "STATION" && id) {
          handleStationClick({
            id:         id,
            name:       name,
            coordinate: { x: parseFloat(lon), y: parseFloat(lat) },
          });
        }
      });
    });
  } catch (err) {
    console.error("[Search]", err);
  }
}

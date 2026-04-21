// ─── State ───────────────────────────────────────────────────────────────────
var map            = null;
var socket         = null;
var allStations    = [];
var allVehicles    = [];
var stationsLoaded = false;
var busMarkers     = {};
var stationMarkers = {};
var selectedBusId  = null;
var searchTimeout  = null;
var viewportDebounce = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function() {
  initMap();
  initSocket();
  initSearch();
  document.getElementById("panel-close").addEventListener("click", closePanel);
});

// ─── Map ──────────────────────────────────────────────────────────────────────
function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors",
          maxzoom: 19,
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    },
    center: [10.0060, 53.5530],
    zoom: 14,
    minZoom: 9,
    maxZoom: 18,
  });

  map.addControl(new maplibregl.NavigationControl(), "bottom-right");
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
  }), "bottom-right");

  map.on("load", function() {
    sendViewport();
    fetch("/api/stations")
      .then(function(r) { return r.json(); })
      .then(function(d) {
        allStations    = d.stations || [];
        stationsLoaded = true;
        renderStationsInViewport();
      })
      .catch(function(e) { console.warn("[Stations]", e.message); });
  });

  map.on("moveend", sendViewport);
  map.on("zoomend",  function() { sendViewport(); renderBusMarkersFromCache(); });
}

function sendViewport() {
  clearTimeout(viewportDebounce);
  viewportDebounce = setTimeout(function() {
    if (socket && socket.connected) {
      var b = map.getBounds();
      socket.emit("viewport:update", {
        latMin: b.getSouth(), latMax: b.getNorth(),
        lonMin: b.getWest(),  lonMax: b.getEast(),
      });
    }
    if (stationsLoaded) renderStationsInViewport();
  }, 400);
}

// ─── Bus Markers ──────────────────────────────────────────────────────────────
function renderBusMarkersFromCache() {
  updateBusMarkers(allVehicles);
}

function updateBusMarkers(vehicles) {
  var currentIds = {};
  for (var i = 0; i < vehicles.length; i++) {
    if (vehicles[i].id) currentIds[vehicles[i].id] = true;
  }

  for (var id in busMarkers) {
    if (!currentIds[id]) {
      busMarkers[id].marker.remove();
      delete busMarkers[id];
    }
  }

  var bounds = map.getBounds();

  for (var i = 0; i < vehicles.length; i++) {
    var v = vehicles[i];
    if (!v.id || !v.lat || !v.lon) continue;
    if (!bounds.contains([v.lon, v.lat])) {
      if (busMarkers[v.id]) {
        busMarkers[v.id].marker.remove();
        delete busMarkers[v.id];
      }
      continue;
    }

    if (busMarkers[v.id]) {
      busMarkers[v.id].marker.setLngLat([v.lon, v.lat]);
      var el = busMarkers[v.id].el;
      el.textContent = v.line || "?";
      el.style.background = lineColor(v.line);
      el.classList.toggle("delayed",  v.delay > 120);
      el.classList.toggle("selected", v.id === selectedBusId);
    } else {
      var el = createBusEl(v);
      (function(vehicle, element) {
        element.addEventListener("click", function() { handleBusClick(vehicle); });
      })(v, el);
      var marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([v.lon, v.lat])
        .addTo(map);
      busMarkers[v.id] = { marker: marker, el: el };
    }
  }
}

function createBusEl(v) {
  var el = document.createElement("div");
  el.className = "bus-marker";
  el.style.background = lineColor(v.line);
  el.textContent = v.line || "?";
  el.title = "Linie " + v.line + " → " + v.direction;
  if (v.delay > 120)    el.classList.add("delayed");
  if (v.id === selectedBusId) el.classList.add("selected");
  return el;
}

function lineColor(name) {
  if (!name) return "#2563EB";
  var h = 0;
  for (var i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  var cols = ["#E2001A","#2563EB","#16A34A","#D97706","#7C3AED","#0891B2","#DC2626","#0284C7"];
  return cols[Math.abs(h) % cols.length];
}

// ─── Station Markers ──────────────────────────────────────────────────────────
function renderStationsInViewport() {
  for (var id in stationMarkers) {
    stationMarkers[id].remove();
  }
  stationMarkers = {};

  if (map.getZoom() < 14) return;

  var bounds  = map.getBounds();
  var visible = [];
  for (var i = 0; i < allStations.length; i++) {
    var s = allStations[i];
    if (s.coordinate && bounds.contains([s.coordinate.x, s.coordinate.y])) {
      visible.push(s);
      if (visible.length >= 200) break;
    }
  }

  for (var i = 0; i < visible.length; i++) {
    var station = visible[i];
    var el = document.createElement("div");
    el.className = "station-marker";
    el.title = station.name;
    (function(st, element) {
      element.addEventListener("click", function() {
        document.querySelectorAll(".station-marker.active").forEach(function(m) { m.classList.remove("active"); });
        element.classList.add("active");
        handleStationClick(st);
      });
    })(station, el);
    var m = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat([station.coordinate.x, station.coordinate.y])
      .addTo(map);
    stationMarkers[station.id] = m;
  }
}

// ─── Route Line ───────────────────────────────────────────────────────────────
function showRouteLine(coords, color) {
  clearRouteLine();
  var geojson = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords.map(function(c) { return [c.x, c.y]; }) },
  };
  map.addSource("route", { type: "geojson", data: geojson });
  map.addLayer({ id: "route-line", type: "line", source: "route",
    paint: { "line-color": color || "#E2001A", "line-width": 4, "line-opacity": 0.85 } });
}

function clearRouteLine() {
  if (map.getLayer("route-line")) map.removeLayer("route-line");
  if (map.getSource("route"))    map.removeSource("route");
}

function flyTo(lon, lat, zoom) {
  map.flyTo({ center: [lon, lat], zoom: zoom || 15, speed: 1.5 });
}

// ─── Socket ───────────────────────────────────────────────────────────────────
function initSocket() {
  socket = io({ transports: ["websocket", "polling"] });

  socket.on("connect", function() {
    setStatus("connected", "Live");
    sendViewport();
  });
  socket.on("disconnect", function() { setStatus("error", "Getrennt"); });
  socket.on("connect_error", function() { setStatus("error", "Fehler"); });

  socket.on("vehicles:update", function(data) {
    allVehicles = data.vehicles || [];
    updateBusMarkers(allVehicles);
    document.getElementById("bus-count").textContent  = data.count || 0;
    document.getElementById("stats-update").textContent =
      "Zuletzt: " + new Date(data.timestamp).toLocaleTimeString("de-DE");
  });
}

function setStatus(cls, text) {
  document.getElementById("status-indicator").className = "status-" + cls;
  document.getElementById("status-text").textContent    = text;
}

// ─── Panel ────────────────────────────────────────────────────────────────────
function openPanel(html) {
  document.getElementById("panel-content").innerHTML = html;
  document.getElementById("side-panel").classList.remove("hidden");
}

function closePanel() {
  document.getElementById("side-panel").classList.add("hidden");
  document.querySelectorAll(".station-marker.active").forEach(function(m) { m.classList.remove("active"); });
  document.querySelectorAll(".bus-marker.selected").forEach(function(m) { m.classList.remove("selected"); });
  selectedBusId = null;
  clearRouteLine();
}

function showLoadingPanel(title) {
  openPanel(
    '<div class="panel-chip">Lädt</div>' +
    '<div class="panel-title">' + title + '</div>' +
    '<div class="panel-loading"><div class="spinner"></div>Echtzeit-Daten werden abgerufen…</div>'
  );
}

// ─── Bus Click ────────────────────────────────────────────────────────────────
function handleBusClick(bus) {
  selectedBusId = bus.id;
  updateBusMarkers(allVehicles);
  flyTo(bus.lon, bus.lat, 15);
  showLoadingPanel("Linie " + (bus.line || "?"));

  fetch("/api/bus-course", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lineKey:       bus.lineId,
      stationKey:    bus.startStationKey,
      startDateTime: bus.startDateTime,
    }),
  })
  .then(function(r) { return r.json(); })
  .then(function(course) {
    renderBusPanel(bus, course);
    var stopKeys = (course.stopList || [])
      .map(function(s) { return s.stopPointKey || s.stationKey; })
      .filter(Boolean);
    if (stopKeys.length >= 2) {
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopPointKeys: stopKeys }),
      })
      .then(function(r) { return r.json(); })
      .then(function(td) {
        if (td.tracks && td.tracks.length) {
          var coords = [];
          for (var i = 0; i < td.tracks.length; i++) {
            var pts = td.tracks[i].track || [];
            for (var j = 0; j + 1 < pts.length; j += 2) coords.push({ x: pts[j], y: pts[j+1] });
          }
          if (coords.length) showRouteLine(coords, bus.color || "#E2001A");
        }
      });
    }
  })
  .catch(function(err) {
    console.error("[BusCourse]", err);
    renderBusPanel(bus, null);
  });
}

function renderBusPanel(bus, course) {
  var bg      = bus.color || lineColor(bus.line);
  var delay   = bus.delay || 0;
  var delayed = delay > 60;
  var statusText = delayed
    ? ("+" + Math.round(delay / 60) + " Min Verspätung")
    : "Pünktlich ✓";

  var stopsHtml = "";
  if (course && course.stopList && course.stopList.length) {
    for (var i = 0; i < course.stopList.length; i++) {
      var stop = course.stopList[i];
      var time = (stop.time && stop.time.time) ? stop.time.time : "";
      var name = stop.station ? stop.station.name : (stop.stationName || "–");
      var cls  = stop.isCurrentStop ? "current" : (stop.isPassed ? "passed" : "upcoming");
      stopsHtml +=
        '<div class="stop-item ' + cls + '">' +
        '<div class="stop-time">' + time + '</div>' +
        '<div class="stop-name ' + cls + '">' + name + '</div>' +
        '</div>';
    }
  }

  openPanel(
    '<div class="panel-chip">🚌 Bus</div>' +
    '<div class="bus-header">' +
      '<div class="bus-line-badge" style="background:' + bg + '">' + (bus.line || "?") + '</div>' +
      '<div class="bus-meta">' +
        '<div class="bus-direction">→ ' + (bus.direction || "–") + '</div>' +
        '<div class="bus-type">' + (bus.vehicleType || "Bus") + ' · Echtzeit</div>' +
      '</div>' +
    '</div>' +
    '<div class="bus-status-pill ' + (delayed ? "delayed" : "ontime") + '">' +
      (delayed ? "⚠️ " : "✓ ") + statusText +
    '</div>' +
    (stopsHtml
      ? '<div class="panel-section-label">Streckenverlauf</div><div class="stop-timeline">' + stopsHtml + '</div>'
      : '<div class="panel-loading"><div class="spinner"></div>Keine Haltestellen verfügbar</div>')
  );
}

// ─── Station Click ────────────────────────────────────────────────────────────
function handleStationClick(station) {
  selectedBusId = null;
  clearRouteLine();
  showLoadingPanel(station.name);
  flyTo(station.coordinate.x, station.coordinate.y, 15);

  fetch("/api/departures/" + encodeURIComponent(station.id))
    .then(function(r) { return r.json(); })
    .then(function(data) { renderStationPanel(station, data.departures || []); })
    .catch(function(err) { console.error("[Departures]", err); });
}

function renderStationPanel(station, departures) {
  var itemsHtml = "";
  for (var i = 0; i < departures.length; i++) {
    var dep     = departures[i];
    var delay   = dep.delay || dep.depDelay || 0;
    var delayed = delay > 60;
    var bg      = (dep.line && dep.line.color) ? dep.line.color : lineColor(dep.line && dep.line.name);
    var lineName = (dep.line && dep.line.name) ? dep.line.name : "?";
    var time    = dep.timeOffset || (dep.time && dep.time.time) || "–";
    var dir     = dep.direction || "–";
    var lineKey = (dep.serviceId && dep.serviceId.id) || (dep.line && dep.line.id) || "";

    itemsHtml +=
      '<div class="departure-item" data-linekey="' + lineKey + '" data-station="' + station.id + '">' +
        '<div class="dep-badge" style="background:' + bg + '">' + lineName + '</div>' +
        '<div>' +
          '<div class="dep-direction">' + dir + '</div>' +
          (dep.platform ? '<div class="dep-stop">Steig ' + dep.platform + '</div>' : '') +
        '</div>' +
        '<div class="dep-time-col">' +
          '<div class="dep-time ' + (delayed ? "delayed" : "") + '">' + time + '</div>' +
          (delayed ? '<div class="dep-delay">+' + Math.round(delay/60) + ' min</div>' : '') +
        '</div>' +
      '</div>';
  }

  openPanel(
    '<div class="panel-chip">🚏 Haltestelle</div>' +
    '<div class="panel-title">' + station.name + '</div>' +
    '<div class="panel-section-label">Nächste Abfahrten</div>' +
    '<div class="departures-list">' +
      (itemsHtml || '<div class="panel-loading"><div class="spinner"></div>Keine Abfahrten</div>') +
    '</div>'
  );

  document.querySelectorAll(".departure-item").forEach(function(el) {
    el.addEventListener("click", function() {
      var lineKey   = el.dataset.linekey;
      var stationId = el.dataset.station;
      if (lineKey) handleCourseClick(lineKey, stationId);
    });
  });
}

function handleCourseClick(lineKey, stationId) {
  fetch("/api/course", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lineKey: lineKey, stationId: stationId }),
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var keys = (data.stopList || []).map(function(s) { return s.stationKey; }).filter(Boolean);
    if (keys.length) {
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopPointKeys: keys }),
      })
      .then(function(r) { return r.json(); })
      .then(function(td) {
        if (td.tracks && td.tracks.length) {
          var coords = [];
          for (var i = 0; i < td.tracks.length; i++) {
            var pts = td.tracks[i].track || [];
            for (var j = 0; j + 1 < pts.length; j += 2) coords.push({ x: pts[j], y: pts[j+1] });
          }
          if (coords.length) showRouteLine(coords);
        }
      });
    }
    renderBusPanel({ line: lineKey, direction: data.direction || "" }, data);
  })
  .catch(function(err) { console.error("[Course]", err); });
}

// ─── Search ───────────────────────────────────────────────────────────────────
function initSearch() {
  var searchInput   = document.getElementById("search-input");
  var searchResults = document.getElementById("search-results");

  searchInput.addEventListener("input", function() {
    clearTimeout(searchTimeout);
    var q = searchInput.value.trim();
    if (q.length < 2) { searchResults.classList.remove("visible"); return; }
    searchTimeout = setTimeout(function() { doSearch(q); }, 300);
  });

  searchInput.addEventListener("keydown", function(e) {
    if (e.key === "Escape") { searchResults.classList.remove("visible"); searchInput.blur(); }
  });

  document.addEventListener("click", function(e) {
    if (!e.target.closest("#search-container")) searchResults.classList.remove("visible");
  });

  function doSearch(q) {
    fetch("/api/search?q=" + encodeURIComponent(q) + "&limit=8")
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var results = data.results || [];
        var html    = "";
        if (!results.length) {
          html = '<div class="search-item"><div class="item-name">Keine Ergebnisse</div></div>';
        } else {
          for (var i = 0; i < results.length; i++) {
            var r   = results[i];
            var lon = r.coordinate ? r.coordinate.x : "";
            var lat = r.coordinate ? r.coordinate.y : "";
            html +=
              '<div class="search-item" data-id="' + (r.id||"") +
              '" data-type="' + (r.type||"") +
              '" data-lon="'  + lon +
              '" data-lat="'  + lat +
              '" data-name="' + (r.name||"").replace(/"/g, "&quot;") + '">' +
              '<div class="item-name">' + (r.name||"") + '</div>' +
              '<div class="item-type">' + (r.type||"") + (r.city ? " · " + r.city : "") + '</div>' +
              '</div>';
          }
        }
        searchResults.innerHTML = html;
        searchResults.classList.add("visible");

        searchResults.querySelectorAll(".search-item[data-id]").forEach(function(el) {
          el.addEventListener("click", function() {
            var id   = el.dataset.id;
            var type = el.dataset.type;
            var lon  = parseFloat(el.dataset.lon);
            var lat  = parseFloat(el.dataset.lat);
            var name = el.dataset.name;
            searchResults.classList.remove("visible");
            searchInput.value = name;
            if (lon && lat) flyTo(lon, lat, 15);
            if (type === "STATION" && id) {
              handleStationClick({ id: id, name: name, coordinate: { x: lon, y: lat } });
            }
          });
        });
      })
      .catch(function(err) { console.error("[Search]", err); });
  }
}

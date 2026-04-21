// ─── State ────────────────────────────────────────────────────────────────────
var map            = null;
var socket         = null;
var allStations    = [];
var allVehicles    = {};
var stationsLoaded = false;
var busMarkers     = {};
var stationMarkers = {};
var selectedBusId  = null;
var searchTimeout  = null;
var viewportDebounce = null;
var animationRunning = false;

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
      sources: { osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
        maxzoom: 19,
      }},
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    },
    center: [10.0060, 53.5530],
    zoom: 14, minZoom: 9, maxZoom: 18,
  });

  map.addControl(new maplibregl.NavigationControl(), "bottom-right");

  map.on("load", function() {
    sendViewport();
    startAnimationLoop();
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
  map.on("zoomend", function() { sendViewport(); });
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

// ─── Animation Loop ───────────────────────────────────────────────────────────
// Lerp: gerenderte Position folgt der berechneten sanft.
// Schwellwert: Sprünge > ~300m werden sofort übernommen (Linienende, neue Route)

var LERP_ALPHA     = 0.06;   // 0.06 = ~16 Frames bis 63% des Weges → ~0.5s bei 30fps
var SNAP_THRESHOLD = 0.003;  // ~300m in Grad – größere Sprünge sofort übernehmen

function startAnimationLoop() {
  if (animationRunning) return;
  animationRunning = true;
  requestAnimationFrame(animationTick);
}

function animationTick() {
  if (!map) { requestAnimationFrame(animationTick); return; }

  var now    = Date.now();
  var bounds = map.getBounds();

  for (var id in allVehicles) {
    var v = allVehicles[id];
    if (!v.trackData || v.trackData.length < 2) continue;
    if (!busMarkers[id]) continue;

    // Wo SOLLTE der Bus sein laut Track-Daten
    var target = calcPosition(v.trackData, v.segStartMs, v.segEndMs, now);
    if (!target.lat || !target.lon) continue;

    // Erste Position: direkt setzen
    if (v._renderLon === undefined || v._renderLat === undefined) {
      v._renderLon = target.lon;
      v._renderLat = target.lat;
    } else {
      var dLon = target.lon - v._renderLon;
      var dLat = target.lat - v._renderLat;
      var dist = Math.sqrt(dLon * dLon + dLat * dLat);

      if (dist > SNAP_THRESHOLD) {
        // Großer Sprung (Segmentwechsel, neue Route) → sofort
        v._renderLon = target.lon;
        v._renderLat = target.lat;
      } else {
        // Sanft interpolieren
        v._renderLon += dLon * LERP_ALPHA;
        v._renderLat += dLat * LERP_ALPHA;
      }
    }

    if (bounds.contains([v._renderLon, v._renderLat])) {
      busMarkers[id].marker.setLngLat([v._renderLon, v._renderLat]);
    }
  }

  requestAnimationFrame(animationTick);
}

function calcPosition(track, startMs, endMs, now) {
  if (!track || track.length < 2) return { lat: null, lon: null };

  // Sicherheit: falls startMs in Sekunden statt ms
  if (startMs < 9999999999) startMs = startMs * 1000;
  if (endMs   < 9999999999) endMs   = endMs   * 1000;

  var duration = endMs - startMs;
  if (duration <= 0) return { lon: track[track.length - 2], lat: track[track.length - 1] };

  var progress   = Math.max(0, Math.min(1, (now - startMs) / duration));
  var pointCount = Math.floor(track.length / 2);
  if (pointCount === 1) return { lon: track[0], lat: track[1] };

  var floatIdx = progress * (pointCount - 1);
  var idx      = Math.floor(floatIdx);
  var frac     = floatIdx - idx;
  var next     = Math.min(idx + 1, pointCount - 1);

  return {
    lon: track[idx*2]   + frac * (track[next*2]   - track[idx*2]),
    lat: track[idx*2+1] + frac * (track[next*2+1] - track[idx*2+1]),
  };
}

// ─── Bus Markers ──────────────────────────────────────────────────────────────
function syncBusMarkers(vehicles) {
  var bounds = map.getBounds();
  var newIds = {};

  for (var i = 0; i < vehicles.length; i++) {
    var v = vehicles[i];
    if (!v.id || !v.lat || !v.lon) continue;
    newIds[v.id] = true;

    // Gerenderte Position beim Update NICHT zurücksetzen – verhindert Springen
    if (allVehicles[v.id]) {
      v._renderLon = allVehicles[v.id]._renderLon;
      v._renderLat = allVehicles[v.id]._renderLat;
    }
    allVehicles[v.id] = v;

    if (!bounds.contains([v.lon, v.lat])) {
      if (busMarkers[v.id]) {
        busMarkers[v.id].marker.remove();
        delete busMarkers[v.id];
      }
      continue;
    }

    if (!busMarkers[v.id]) {
      var el     = createBusEl(v);
      var marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([v.lon, v.lat])
        .addTo(map);
      busMarkers[v.id] = { marker: marker, el: el };
      attachBusClick(v.id, el);
    } else {
      updateBusEl(busMarkers[v.id].el, v);
    }
  }

  // Marker entfernen die nicht mehr in der API sind
  for (var id in busMarkers) {
    if (!newIds[id]) {
      busMarkers[id].marker.remove();
      delete busMarkers[id];
      delete allVehicles[id];
    }
  }
}

function attachBusClick(id, el) {
  el.addEventListener("click", function() {
    if (allVehicles[id]) handleBusClick(allVehicles[id]);
  });
}

function createBusEl(v) {
  var el          = document.createElement("div");
  el.className    = "bus-marker";
  el.style.background = lineColor(v.line);
  el.textContent  = v.line || "?";
  el.title        = "Linie " + (v.line||"?") + " → " + (v.direction||"");
  if (v.delay > 120)        el.classList.add("delayed");
  if (v.id === selectedBusId) el.classList.add("selected");
  return el;
}

function updateBusEl(el, v) {
  el.textContent      = v.line || "?";
  el.style.background = lineColor(v.line);
  el.title            = "Linie " + (v.line||"?") + " → " + (v.direction||"");
  el.classList.toggle("delayed",  v.delay > 120);
  el.classList.toggle("selected", v.id === selectedBusId);
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
  for (var id in stationMarkers) stationMarkers[id].remove();
  stationMarkers = {};
  if (map.getZoom() < 14) return;

  var bounds = map.getBounds();
  var count  = 0;
  for (var i = 0; i < allStations.length; i++) {
    var s = allStations[i];
    if (!s.coordinate) continue;
    if (!bounds.contains([s.coordinate.x, s.coordinate.y])) continue;
    if (count++ >= 200) break;

    var el      = document.createElement("div");
    el.className = "station-marker";
    el.title     = s.name;
    (function(station, element) {
      element.addEventListener("click", function() {
        document.querySelectorAll(".station-marker.active")
          .forEach(function(m) { m.classList.remove("active"); });
        element.classList.add("active");
        handleStationClick(station);
      });
    })(s, el);

    stationMarkers[s.id] = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat([s.coordinate.x, s.coordinate.y])
      .addTo(map);
  }
}

// ─── Route Line ───────────────────────────────────────────────────────────────
function showRouteLine(coords, color) {
  clearRouteLine();
  if (!coords || !coords.length) return;
  map.addSource("route", { type: "geojson", data: {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords.map(function(c) { return [c.x, c.y]; }) },
  }});
  map.addLayer({ id: "route-line", type: "line", source: "route",
    paint: { "line-color": color || "#E2001A", "line-width": 4, "line-opacity": 0.85 } });
}

function clearRouteLine() {
  try { if (map.getLayer("route-line")) map.removeLayer("route-line"); } catch(e) {}
  try { if (map.getSource("route"))    map.removeSource("route");     } catch(e) {}
}

function flyTo(lon, lat, zoom) {
  map.flyTo({ center: [lon, lat], zoom: zoom || 15, speed: 1.5 });
}

// ─── Socket ───────────────────────────────────────────────────────────────────
function initSocket() {
  socket = io({ transports: ["websocket", "polling"] });
  socket.on("connect",       function() { setStatus("connected",  "Live");     sendViewport(); });
  socket.on("disconnect",    function() { setStatus("error",      "Getrennt"); });
  socket.on("connect_error", function() { setStatus("error",      "Fehler");   });

  socket.on("vehicles:update", function(data) {
    var vehicles = data.vehicles || [];
    syncBusMarkers(vehicles);
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
  document.querySelectorAll(".station-marker.active")
    .forEach(function(m) { m.classList.remove("active"); });
  document.querySelectorAll(".bus-marker.selected")
    .forEach(function(m) { m.classList.remove("selected"); });
  selectedBusId = null;
  clearRouteLine();
}

function showLoadingPanel(title) {
  openPanel(
    '<div class="panel-chip">Lädt</div>' +
    '<div class="panel-title">' + title + '</div>' +
    '<div class="panel-loading"><div class="spinner"></div>Echtzeit-Daten…</div>'
  );
}

// ─── Bus Click ────────────────────────────────────────────────────────────────
function handleBusClick(bus) {
  selectedBusId = bus.id;
  if (busMarkers[bus.id]) updateBusEl(busMarkers[bus.id].el, bus);

  var renderLon = (bus._renderLon !== undefined) ? bus._renderLon : bus.lon;
  var renderLat = (bus._renderLat !== undefined) ? bus._renderLat : bus.lat;
  flyTo(renderLon, renderLat, 15);
  showLoadingPanel("Linie " + (bus.line || "?"));

  fetch("/api/bus-course", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      lineKey:       bus.lineId,
      stationKey:    bus.startStationKey,
      startDateTime: bus.startDateTime,
    }),
  })
  .then(function(r) {
    if (!r.ok) throw new Error("Status " + r.status);
    return r.json();
  })
  .then(function(course) {
    renderBusPanel(bus, course);
    loadRouteForCourse(course, bus.color || "#E2001A");
  })
  .catch(function(err) {
    console.error("[BusCourse]", err);
    renderBusPanel(bus, null);
  });
}

function loadRouteForCourse(course, color) {
  var stopKeys = (course.stopList || [])
    .map(function(s) { return s.stopPointKey || s.stationKey; })
    .filter(Boolean);
  if (stopKeys.length < 2) return;

  fetch("/api/track", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ stopPointKeys: stopKeys }),
  })
  .then(function(r) { return r.json(); })
  .then(function(td) {
    if (!td.tracks || !td.tracks.length) return;
    var coords = [];
    for (var i = 0; i < td.tracks.length; i++) {
      var pts = td.tracks[i].track || [];
      for (var j = 0; j + 1 < pts.length; j += 2) coords.push({ x: pts[j], y: pts[j+1] });
    }
    if (coords.length) showRouteLine(coords, color);
  })
  .catch(function(err) { console.error("[Track]", err); });
}

function renderBusPanel(bus, course) {
  var bg      = bus.color || lineColor(bus.line);
  var delay   = bus.delay || 0;
  var delayed = delay > 60;
  var statusTxt = delayed
    ? ("+" + Math.round(delay/60) + " Min Verspätung")
    : "Pünktlich ✓";

  var stopsHtml = "";
  var stopList  = (course && course.stopList) ? course.stopList : [];
  for (var i = 0; i < stopList.length; i++) {
    var stop = stopList[i];
    var time = (stop.time && stop.time.time) ? stop.time.time : "";
    var name = stop.station ? stop.station.name : (stop.stationName || "–");
    var cls  = stop.isCurrentStop ? "current" : (stop.isPassed ? "passed" : "upcoming");
    stopsHtml +=
      '<div class="stop-item ' + cls + '">' +
        '<div class="stop-time">' + time + '</div>' +
        '<div class="stop-name ' + cls + '">' + name + '</div>' +
      '</div>';
  }

  openPanel(
    '<div class="panel-chip">🚌 Bus</div>' +
    '<div class="bus-header">' +
      '<div class="bus-line-badge" style="background:' + bg + '">' + (bus.line||"?") + '</div>' +
      '<div class="bus-meta">' +
        '<div class="bus-direction">→ ' + (bus.direction||"–") + '</div>' +
        '<div class="bus-type">' + (bus.vehicleType||"Bus") + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="bus-status-pill ' + (delayed ? "delayed" : "ontime") + '">' +
      (delayed ? "⚠️ " : "✓ ") + statusTxt +
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
    .then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function(data) {
      console.log("[Departures]", data);
      renderStationPanel(station, data.departures || []);
    })
    .catch(function(err) {
      console.error("[Departures]", err);
      openPanel(
        '<div class="panel-chip">🚏 Haltestelle</div>' +
        '<div class="panel-title">' + station.name + '</div>' +
        '<div class="panel-loading">Fehler: ' + err.message + '</div>'
      );
    });
}

function renderStationPanel(station, departures) {
  var itemsHtml = "";
  for (var i = 0; i < departures.length; i++) {
    var dep      = departures[i];
    var delay    = dep.delay || dep.depDelay || 0;
    var delayed  = delay > 60;
    var lineName = (dep.line && dep.line.name) ? dep.line.name : "?";
    var bg       = (dep.line && dep.line.color) ? dep.line.color : lineColor(lineName);
    var time     = dep.timeOffset || (dep.time && dep.time.time) || "–";
    var dir      = dep.direction || "–";
    var lineKey  = (dep.serviceId && dep.serviceId.id) || (dep.line && dep.line.id) || "";

    itemsHtml +=
      '<div class="departure-item" data-linekey="' + lineKey + '" data-station="' + station.id + '">' +
        '<div class="dep-badge" style="background:' + bg + '">' + lineName + '</div>' +
        '<div>' +
          '<div class="dep-direction">' + dir + '</div>' +
          (dep.platform ? '<div class="dep-stop">Steig ' + dep.platform + '</div>' : '') +
        '</div>' +
        '<div class="dep-time-col">' +
          '<div class="dep-time' + (delayed ? " delayed" : "") + '">' + time + '</div>' +
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

  document.querySelectorAll(".departure-item[data-linekey]").forEach(function(el) {
    el.addEventListener("click", function() {
      if (el.dataset.linekey) handleCourseClick(el.dataset.linekey, el.dataset.station);
    });
  });
}

function handleCourseClick(lineKey, stationId) {
  fetch("/api/course", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ lineKey: lineKey, stationId: stationId }),
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    loadRouteForCourse(data, "#E2001A");
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
              '<div class="search-item"' +
              ' data-id="'   + (r.id||"")   + '"' +
              ' data-type="' + (r.type||"") + '"' +
              ' data-lon="'  + lon + '"' +
              ' data-lat="'  + lat + '"' +
              ' data-name="' + (r.name||"").replace(/"/g,"&quot;") + '">' +
              '<div class="item-name">' + (r.name||"") + '</div>' +
              '<div class="item-type">' + (r.type||"") + (r.city ? " · "+r.city : "") + '</div>' +
              '</div>';
          }
        }
        searchResults.innerHTML = html;
        searchResults.classList.add("visible");

        searchResults.querySelectorAll(".search-item[data-id]").forEach(function(el) {
          el.addEventListener("click", function() {
            var lon  = parseFloat(el.dataset.lon);
            var lat  = parseFloat(el.dataset.lat);
            searchResults.classList.remove("visible");
            searchInput.value = el.dataset.name;
            if (lon && lat) flyTo(lon, lat, 15);
            if (el.dataset.type === "STATION" && el.dataset.id) {
              handleStationClick({ id: el.dataset.id, name: el.dataset.name, coordinate: { x: lon, y: lat } });
            }
          });
        });
      })
      .catch(function(err) { console.error("[Search]", err); });
  }
}

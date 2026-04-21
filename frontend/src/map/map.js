import maplibregl from "maplibre-gl";

let map = null;
const busMarkers = new Map();
const stationMarkers = new Map();

export function initMap() {
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
    center: [10.0060, 53.5530], // Hamburger Hauptbahnhof
    zoom: 14,
    minZoom: 9,
    maxZoom: 18,
  });

  map.addControl(new maplibregl.NavigationControl(), "bottom-right");
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }),
    "bottom-right"
  );

  return map;
}

// ─── Bus Markers ──────────────────────────────────────────────────────────────

export function updateBusMarkers(vehicles, onBusClick) {
  const currentIds = new Set(vehicles.map((v) => v.id).filter(Boolean));

  // Alte Marker entfernen
  for (const [id, { marker }] of busMarkers) {
    if (!currentIds.has(id)) {
      marker.remove();
      busMarkers.delete(id);
    }
  }

  const bounds = map.getBounds();

  for (const vehicle of vehicles) {
    if (!vehicle.id || !vehicle.lat || !vehicle.lon) continue;

    // Nur Busse im aktuellen Viewport rendern
    if (!bounds.contains([vehicle.lon, vehicle.lat])) {
      // Marker entfernen falls vorhanden aber außerhalb
      const existing = busMarkers.get(vehicle.id);
      if (existing) {
        existing.marker.remove();
        busMarkers.delete(vehicle.id);
      }
      continue;
    }

    const existing = busMarkers.get(vehicle.id);
    if (existing) {
      existing.marker.setLngLat([vehicle.lon, vehicle.lat]);
      updateBusEl(existing.el, vehicle);
    } else {
      const el = createBusEl(vehicle);
      el.addEventListener("click", () => onBusClick(vehicle));
      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([vehicle.lon, vehicle.lat])
        .addTo(map);
      busMarkers.set(vehicle.id, { marker, el });
    }
  }
}

function createBusEl(vehicle) {
  const el = document.createElement("div");
  el.className = "bus-marker";
  if (vehicle.delay > 120) el.classList.add("delayed");
  el.style.background = vehicle.color || lineColor(vehicle.line);
  el.textContent = vehicle.line || "?";
  el.title = `Linie ${vehicle.line} → ${vehicle.direction}`;
  return el;
}

function updateBusEl(el, vehicle) {
  el.textContent = vehicle.line || "?";
  el.style.background = vehicle.color || lineColor(vehicle.line);
  el.classList.toggle("delayed", vehicle.delay > 120);
}

// Konsistente Farbe pro Linie
function lineColor(lineName) {
  if (!lineName) return "#1a56db";
  let hash = 0;
  for (const c of lineName) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  const colors = ["#1a56db","#e74694","#0ea5e9","#f59e0b","#10b981","#8b5cf6","#ef4444","#f97316"];
  return colors[Math.abs(hash) % colors.length];
}

// ─── Station Markers – nur im Viewport, ab Zoom 14 ───────────────────────────

export function renderStationsInViewport(stations, onStationClick) {
  const zoom = map.getZoom();
  const bounds = map.getBounds();

  // Alle bestehenden Marker entfernen
  for (const marker of stationMarkers.values()) marker.remove();
  stationMarkers.clear();

  if (zoom < 14) return; // Zu weit raus – nichts rendern

  // Nur Stationen im aktuellen Viewport
  const visible = stations.filter((s) =>
    s.coordinate &&
    bounds.contains([s.coordinate.x, s.coordinate.y])
  );

  // Max 200 Marker auf einmal
  const limited = visible.slice(0, 200);

  for (const station of limited) {
    const el = document.createElement("div");
    el.className = "station-marker";
    el.title = station.name;

    el.addEventListener("click", () => {
      document.querySelectorAll(".station-marker.active")
        .forEach((m) => m.classList.remove("active"));
      el.classList.add("active");
      onStationClick(station);
    });

    const marker = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat([station.coordinate.x, station.coordinate.y])
      .addTo(map);

    stationMarkers.set(station.id, marker);
  }
}

// ─── Route Line ───────────────────────────────────────────────────────────────

export function showRouteLine(coordinates, color = "#f5a623") {
  clearRouteLine();
  const geojson = {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: coordinates.map((c) => [c.x, c.y]),
    },
  };
  if (!map.getSource("route")) {
    map.addSource("route", { type: "geojson", data: geojson });
    map.addLayer({
      id: "route-line", type: "line", source: "route",
      paint: { "line-color": color, "line-width": 4, "line-opacity": 0.85 },
    });
  } else {
    map.getSource("route").setData(geojson);
  }
}

export function clearRouteLine() {
  if (map.getLayer("route-line")) map.removeLayer("route-line");
  if (map.getSource("route")) map.removeSource("route");
}

export function flyTo(lon, lat, zoom = 15) {
  map.flyTo({ center: [lon, lat], zoom, speed: 1.5 });
}

export function getMap() { return map; }

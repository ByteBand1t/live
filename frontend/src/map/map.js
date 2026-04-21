/**
 * Map Module – MapLibre GL with OpenStreetMap tiles
 */

import maplibregl from "maplibre-gl";

let map = null;
const busMarkers = new Map(); // vehicleId → { marker, el }
const stationMarkers = new Map(); // stationId → marker

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
    center: [9.9937, 53.5511], // Hamburg city centre
    zoom: 12,
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

// ─── Bus Markers ─────────────────────────────────────────────────────────────

export function updateBusMarkers(vehicles, onBusClick) {
  const currentIds = new Set(vehicles.map((v) => v.id).filter(Boolean));

  // Remove stale markers
  for (const [id, { marker }] of busMarkers) {
    if (!currentIds.has(id)) {
      marker.remove();
      busMarkers.delete(id);
    }
  }

  // Update or create markers
  for (const vehicle of vehicles) {
    if (!vehicle.id || !vehicle.lat || !vehicle.lon) continue;

    const existing = busMarkers.get(vehicle.id);

    if (existing) {
      // Smoothly animate to new position
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

  el.style.background = vehicle.color || "#1a56db";
  el.textContent = vehicle.line || "?";
  el.title = `Linie ${vehicle.line} → ${vehicle.direction}`;
  return el;
}

function updateBusEl(el, vehicle) {
  el.textContent = vehicle.line || "?";
  el.style.background = vehicle.color || "#1a56db";
  el.classList.toggle("delayed", vehicle.delay > 120);
}

// ─── Station Markers ──────────────────────────────────────────────────────────

export function renderStations(stations, onStationClick) {
  // Clear old
  for (const marker of stationMarkers.values()) marker.remove();
  stationMarkers.clear();

  for (const station of stations) {
    if (!station.coordinate) continue;

    const el = document.createElement("div");
    el.className = "station-marker";
    el.title = station.name;

    el.addEventListener("click", () => {
      // Deactivate all others
      document.querySelectorAll(".station-marker.active").forEach((m) => m.classList.remove("active"));
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
      id: "route-line",
      type: "line",
      source: "route",
      paint: {
        "line-color": color,
        "line-width": 4,
        "line-opacity": 0.85,
      },
    });
  } else {
    map.getSource("route").setData(geojson);
  }
}

export function clearRouteLine() {
  if (map.getLayer("route-line")) map.removeLayer("route-line");
  if (map.getSource("route")) map.removeSource("route");
}

// ─── Fly to ───────────────────────────────────────────────────────────────────

export function flyTo(lon, lat, zoom = 15) {
  map.flyTo({ center: [lon, lat], zoom, speed: 1.5 });
}

export function getMap() {
  return map;
}

/**
 * Bus Position Poller
 * Polls Geofox getVehicleMap every POLL_INTERVAL_MS milliseconds
 * and emits updates to all connected WebSocket clients.
 */

const geofox = require("../geofox/client");
const cache = require("../cache/redis");

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);

const HH_BBOX = {
  latMin: parseFloat(process.env.HH_BBOX_LAT_MIN || "53.40"),
  latMax: parseFloat(process.env.HH_BBOX_LAT_MAX || "53.75"),
  lonMin: parseFloat(process.env.HH_BBOX_LON_MIN || "9.70"),
  lonMax: parseFloat(process.env.HH_BBOX_LON_MAX || "10.30"),
};

function getQuadrants() {
  const midLat = (HH_BBOX.latMin + HH_BBOX.latMax) / 2;
  const midLon = (HH_BBOX.lonMin + HH_BBOX.lonMax) / 2;

  return [
    { latMin: midLat, latMax: HH_BBOX.latMax, lonMin: HH_BBOX.lonMin, lonMax: midLon },
    { latMin: midLat, latMax: HH_BBOX.latMax, lonMin: midLon, lonMax: HH_BBOX.lonMax },
    { latMin: HH_BBOX.latMin, latMax: midLat, lonMin: HH_BBOX.lonMin, lonMax: midLon },
    { latMin: HH_BBOX.latMin, latMax: midLat, lonMin: midLon, lonMax: HH_BBOX.lonMax },
  ];
}

let io = null;
let pollTimer = null;
let isPolling = false;

function start(socketIo) {
  io = socketIo;
  console.log(`[Poller] Starting – interval: ${POLL_INTERVAL}ms`);
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function poll() {
  if (isPolling) {
    console.warn("[Poller] Previous poll still running, skipping cycle");
    return;
  }

  isPolling = true;

  try {
    const quadrants = getQuadrants();
    const allVehicles = new Map();

    for (const bbox of quadrants) {
      try {
        const result = await geofox.getVehicleMap(bbox);

        // API gibt "journeys" zurück, nicht "vehicles"
        const journeys = result.journeys || [];

        journeys.forEach((journey) => {
          const key = journey.journeyID;
          if (key) allVehicles.set(key, normalizeJourney(journey));
        });

        // 1.1s Pause zwischen Requests – Rate Limit einhalten
        await sleep(1100);
      } catch (err) {
        console.error(`[Poller] Quadrant error:`, err.message);
      }
    }

    const vehicleArray = Array.from(allVehicles.values())
      .filter((v) => v.lat && v.lon); // nur Fahrzeuge mit gültiger Position

    await cache.set("vehicles:latest", vehicleArray, 30);
    await cache.set("vehicles:lastUpdate", new Date().toISOString(), 30);

    if (io) {
      io.emit("vehicles:update", {
        vehicles: vehicleArray,
        timestamp: new Date().toISOString(),
        count: vehicleArray.length,
      });
    }

    console.log(`[Poller] Broadcast ${vehicleArray.length} buses`);
  } catch (err) {
    console.error("[Poller] Error:", err.message);
  } finally {
    isPolling = false;
  }
}

/**
 * Normalisiert ein Journey-Objekt der Geofox API
 * in ein einheitliches Format für das Frontend.
 *
 * Die aktuelle Position wird aus dem Track des ersten Segments
 * extrapoliert – track ist ein flaches Array [lon, lat, lon, lat, ...]
 */
function normalizeJourney(journey) {
  const seg = journey.segments?.[0];
  const track = seg?.track?.track || [];

  // Aktuelle Position: Mitte des Track-Arrays
  let lon = null;
  let lat = null;
  if (track.length >= 2) {
    const mid = Math.floor(track.length / 4) * 2;
    lon = track[mid] ?? track[0];
    lat = track[mid + 1] ?? track[1];
  }

  return {
    id: journey.journeyID,
    line: journey.line?.name || "?",
    direction: seg?.destination || journey.line?.direction || "",
    lat,
    lon,
    delay: seg?.realtimeDelay || 0,
    realtime: journey.realtime || false,
    vehicleType: journey.vehicleType || "METROBUS",
    color: null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { start, stop };

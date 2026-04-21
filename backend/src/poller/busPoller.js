/**
 * Bus Position Poller
 * Polls Geofox getVehicleMap every POLL_INTERVAL_MS milliseconds
 * and emits updates to all connected WebSocket clients.
 *
 * Hamburg is split into 4 quadrants to stay within bounding box limits
 * while covering the entire city.
 */

const geofox = require("../geofox/client");
const cache = require("../cache/redis");

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);

// Hamburg bounding box (can be overridden via .env)
const HH_BBOX = {
  latMin: parseFloat(process.env.HH_BBOX_LAT_MIN || "53.40"),
  latMax: parseFloat(process.env.HH_BBOX_LAT_MAX || "53.75"),
  lonMin: parseFloat(process.env.HH_BBOX_LON_MIN || "9.70"),
  lonMax: parseFloat(process.env.HH_BBOX_LON_MAX || "10.30"),
};

// Split into quadrants to get better coverage
// (large bounding boxes may return incomplete data)
function getQuadrants() {
  const midLat = (HH_BBOX.latMin + HH_BBOX.latMax) / 2;
  const midLon = (HH_BBOX.lonMin + HH_BBOX.lonMax) / 2;

  return [
    { latMin: midLat, latMax: HH_BBOX.latMax, lonMin: HH_BBOX.lonMin, lonMax: midLon },   // NW
    { latMin: midLat, latMax: HH_BBOX.latMax, lonMin: midLon, lonMax: HH_BBOX.lonMax },   // NE
    { latMin: HH_BBOX.latMin, latMax: midLat, lonMin: HH_BBOX.lonMin, lonMax: midLon },   // SW
    { latMin: HH_BBOX.latMin, latMax: midLat, lonMin: midLon, lonMax: HH_BBOX.lonMax },   // SE
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
    const allVehicles = new Map(); // deduplicate by vehicle ID

    // Poll each quadrant sequentially (respect 1 req/sec rate limit)
    for (const bbox of quadrants) {
      try {
        const result = await geofox.getVehicleMap(bbox, ["BUS"]);
        const vehicles = result.vehicles || [];

        vehicles.forEach((v) => {
          const key = v.id || `${v.line?.name}_${v.coordinate?.x}_${v.coordinate?.y}`;
          if (key) allVehicles.set(key, normalizeVehicle(v));
        });

        // Wait 1.1s between requests to respect rate limits
        await sleep(1100);
      } catch (err) {
        console.error(`[Poller] Quadrant error:`, err.message);
      }
    }

    const vehicleArray = Array.from(allVehicles.values());

    // Cache for clients that connect after the poll
    await cache.set("vehicles:latest", vehicleArray, 30);
    await cache.set("vehicles:lastUpdate", new Date().toISOString(), 30);

    // Broadcast to all connected clients
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
 * Normalise vehicle data to a consistent frontend format.
 */
function normalizeVehicle(v) {
  return {
    id: v.id,
    line: v.line?.name || "?",
    direction: v.direction || "",
    lat: v.coordinate?.y,
    lon: v.coordinate?.x,
    delay: v.delay || 0,
    realtime: v.realtimeState !== "PLANNED",
    vehicleType: v.vehicleType || "BUS",
    color: v.line?.color || null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { start, stop };

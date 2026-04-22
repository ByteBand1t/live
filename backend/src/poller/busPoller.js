const geofox = require("../geofox/client");
const cache = require("../cache/redis");

const POLL_INTERVAL = Math.max(1000, parseInt(process.env.POLL_INTERVAL_MS || "1000", 10));

const HH_BBOX = {
  latMin: 53.3983,
  latMax: 53.7393,
  lonMin: 9.7487,
  lonMax: 10.3121,
};

let io = null;
let pollTimer = null;
let isPolling = false;

function start(socketIo) {
  io = socketIo;
  console.log(`[Poller] Starting live-only mode – interval: ${POLL_INTERVAL}ms`);
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
  if (isPolling) return;
  isPolling = true;

  try {
    const result = await geofox.getVehicleMap(HH_BBOX);
    const journeys = result.journeys || [];
    const vehicles = [];

    for (const journey of journeys) {
      const normalized = normalizeJourney(journey);
      if (normalized) vehicles.push(normalized);
    }

    await cache.set("vehicles:latest", vehicles, 30);
    await cache.set("vehicles:lastUpdate", new Date().toISOString(), 30);

    if (io) {
      io.emit("vehicles:update", {
        vehicles,
        timestamp: new Date().toISOString(),
        count: vehicles.length,
        mode: "live-only",
      });
    }

    console.log(`[Poller] Broadcast ${vehicles.length} live buses from ${journeys.length} journeys`);
  } catch (err) {
    console.error("[Poller] Error:", err.message);
  } finally {
    isPolling = false;
  }
}

function normalizeJourney(journey) {
  const segments = journey.segments || [];
  const activeSeg = segments.find(isActiveSegment) || segments[0];
  if (!activeSeg) return null;

  const realtimePos = extractRealtimePosition(journey, activeSeg);
  if (!realtimePos) return null;

  const stableId = journey.journeyID && journey.journeyID !== "null"
    ? journey.journeyID
    : makeStableVehicleId(journey, activeSeg);

  return {
    id: stableId,
    line: journey.line?.name || "?",
    lineId: journey.line?.id || null,
    direction: activeSeg.destination || journey.line?.direction || "",
    lat: realtimePos.lat,
    lon: realtimePos.lon,
    delay: activeSeg.realtimeDelay || 0,
    realtime: true,
    hasLivePosition: true,
    vehicleType: journey.vehicleType || "METROBUS",
    startStationKey: activeSeg.startStationKey || null,
    startDateTime: activeSeg.startDateTime || null,
    color: null,
  };
}

function isActiveSegment(segment) {
  const now = Date.now();
  const startMs = (segment.startDateTime || 0) * 1000;
  const endMs = (segment.endDateTime || 0) * 1000;
  return startMs <= now && endMs >= now;
}

function makeStableVehicleId(journey, activeSeg) {
  const lineId = journey.line?.id || journey.line?.name || "line";
  const startStation = activeSeg?.startStationKey || "station";
  const startTime = activeSeg?.startDateTime || "time";
  const destination = activeSeg?.destination || journey.line?.direction || "dest";
  return `${lineId}|${startStation}|${startTime}|${destination}`;
}

function extractRealtimePosition(journey, activeSeg) {
  const candidates = [
    activeSeg?.coordinate,
    activeSeg?.position,
    activeSeg?.realtimePosition,
    activeSeg?.realtime?.coordinate,
    journey?.coordinate,
    journey?.position,
    journey?.realtimePosition,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const lon = candidate.lon ?? candidate.lng ?? candidate.x;
    const lat = candidate.lat ?? candidate.latitude ?? candidate.y;
    if (lat != null && lon != null) {
      return { lat, lon };
    }
  }

  return null;
}

module.exports = { start, stop };

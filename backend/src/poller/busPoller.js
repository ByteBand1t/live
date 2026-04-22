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
  console.log(`[Poller] Starting live mode – interval: ${POLL_INTERVAL}ms`);
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
        mode: "live",
      });
    }

    console.log(`[Poller] Broadcast ${vehicles.length} buses (${journeys.length} journeys total)`);
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

  // Live map: nur Fahrten, die im Realtime-Modus laufen.
  if (!journey.realtime) return null;

  // Primär echte Koordinate aus der API.
  let position = extractDirectPosition(journey, activeSeg);
  let positionSource = "live-coordinate";

  // Fallback: Wenn GTI keine direkte Koordinate liefert, aus aktuellem Segment
  // im Realtime-Zeitfenster bestimmen (sonst würden häufig 0 Busse erscheinen).
  if (!position) {
    position = estimatePositionFromActiveTrack(activeSeg);
    positionSource = "realtime-track";
  }

  if (!position) return null;

  const stableId = journey.journeyID && journey.journeyID !== "null"
    ? journey.journeyID
    : makeStableVehicleId(journey, activeSeg);

  return {
    id: stableId,
    line: journey.line?.name || "?",
    lineId: journey.line?.id || null,
    direction: activeSeg.destination || journey.line?.direction || "",
    lat: position.lat,
    lon: position.lon,
    positionSource,
    delay: normalizeDelaySeconds(activeSeg.realtimeDelay),
    realtime: true,
    vehicleType: journey.vehicleType || "METROBUS",
    startStationKey: activeSeg.startStationKey || null,
    startDateTime: activeSeg.startDateTime || null,
    color: null,
  };
}

function normalizeDelaySeconds(delay) {
  if (delay == null) return 0;
  // GTI: realtimeDelay in Minuten
  return Math.round(Number(delay) * 60);
}

function isActiveSegment(segment) {
  const now = Date.now();
  const startMs = Number(segment.startDateTime || 0) * 1000;
  const endMs = Number(segment.endDateTime || 0) * 1000;
  return startMs <= now && endMs >= now;
}

function makeStableVehicleId(journey, activeSeg) {
  const lineId = journey.line?.id || journey.line?.name || "line";
  const startStation = activeSeg?.startStationKey || "station";
  const startTime = activeSeg?.startDateTime || "time";
  const destination = activeSeg?.destination || journey.line?.direction || "dest";
  return `${lineId}|${startStation}|${startTime}|${destination}`;
}

function extractDirectPosition(journey, activeSeg) {
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
      return { lat: Number(lat), lon: Number(lon) };
    }
  }

  return null;
}

function estimatePositionFromActiveTrack(activeSeg) {
  const track = activeSeg?.track?.track || [];
  if (!Array.isArray(track) || track.length < 2) return null;

  const startMs = Number(activeSeg.startDateTime || 0) * 1000;
  const endMs = Number(activeSeg.endDateTime || 0) * 1000;
  const now = Date.now();

  if (startMs <= 0 || endMs <= 0 || endMs <= startMs) {
    return { lon: Number(track[0]), lat: Number(track[1]) };
  }

  const progress = Math.max(0, Math.min(1, (now - startMs) / (endMs - startMs)));
  const pointCount = Math.floor(track.length / 2);
  if (pointCount === 1) {
    return { lon: Number(track[0]), lat: Number(track[1]) };
  }

  const floatIndex = progress * (pointCount - 1);
  const baseIndex = Math.floor(floatIndex);
  const nextIndex = Math.min(baseIndex + 1, pointCount - 1);
  const frac = floatIndex - baseIndex;

  const lonA = Number(track[baseIndex * 2]);
  const latA = Number(track[baseIndex * 2 + 1]);
  const lonB = Number(track[nextIndex * 2]);
  const latB = Number(track[nextIndex * 2 + 1]);

  return {
    lon: lonA + (lonB - lonA) * frac,
    lat: latA + (latB - latA) * frac,
  };
}

module.exports = { start, stop };

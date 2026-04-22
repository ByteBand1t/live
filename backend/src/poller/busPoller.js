const geofox = require("../geofox/client");
const cache = require("../cache/redis");

const POLL_INTERVAL = Math.max(1000, parseInt(process.env.POLL_INTERVAL_MS || "1000", 10));

const HH_BBOX = {
  latMin: 53.3983,
  latMax: 53.7393,
  lonMin: 9.7487,
  lonMax: 10.3121,
};

const MAX_JUMP_METERS = 900;

let io = null;
let pollTimer = null;
let isPolling = false;
const lastPositions = new Map();

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
    const seenIds = new Set();

    for (const journey of journeys) {
      const normalized = normalizeJourney(journey);
      if (normalized) {
        vehicles.push(normalized);
        seenIds.add(normalized.id);
        lastPositions.set(normalized.id, {
          lat: normalized.lat,
          lon: normalized.lon,
          time: Date.now(),
        });
      }
    }

    for (const id of lastPositions.keys()) {
      if (!seenIds.has(id)) lastPositions.delete(id);
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

  const activeSeg =
    segments.find(isActiveSegment) ??
    segments.find((s) => s?.track?.track?.length >= 2) ??
    segments[0];

  if (!activeSeg) return null;

  const realtimePos = extractRealtimePosition(journey, activeSeg);
  if (!realtimePos) return null;
  if (!isInHamburg(realtimePos.lat, realtimePos.lon)) return null;

  const stableId =
    journey.journeyID && journey.journeyID !== "null"
      ? journey.journeyID
      : makeStableVehicleId(journey, activeSeg);

  const prev = lastPositions.get(stableId);
  if (prev) {
    const timeDiff = Math.max(1, (Date.now() - prev.time) / 1000);
    const maxAllowed = Math.max(MAX_JUMP_METERS, timeDiff * 30);
    if (
      haversineMeters(prev.lat, prev.lon, realtimePos.lat, realtimePos.lon) >
      maxAllowed
    ) {
      return null;
    }
  }

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
  let startMs = segment.startDateTime || 0;
  let endMs = segment.endDateTime || 0;
  if (!startMs || !endMs) return false;
  if (startMs < 1e11) startMs *= 1000;
  if (endMs < 1e11) endMs *= 1000;
  return startMs <= now && endMs >= now;
}

function makeStableVehicleId(journey, activeSeg) {
  const lineId = journey.line?.id || journey.line?.name || "line";
  const startStation = activeSeg?.startStationKey || "station";
  const startTime = activeSeg?.startDateTime || "time";
  const destination =
    activeSeg?.destination || journey.line?.direction || "dest";
  return `${lineId}|${startStation}|${startTime}|${destination}`;
}

function extractRealtimePosition(journey, activeSeg) {
  const trackData = activeSeg?.track?.track;
  if (!trackData || trackData.length < 2) return null;

  // Track-Array ist interleaved: [lon0, lat0, lon1, lat1, ...]
  const coords = [];
  for (let i = 0; i + 1 < trackData.length; i += 2) {
    coords.push({ lon: trackData[i], lat: trackData[i + 1] });
  }
  if (coords.length === 0) return null;

  let startMs = activeSeg.startDateTime || 0;
  let endMs = activeSeg.endDateTime || 0;
  if (startMs < 1e11) startMs *= 1000;
  if (endMs < 1e11) endMs *= 1000;

  const now = Date.now();

  if (!startMs || !endMs || now <= startMs) return coords[0];
  if (now >= endMs) return coords[coords.length - 1];

  const ratio = (now - startMs) / (endMs - startMs);
  const idx = ratio * (coords.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, coords.length - 1);
  const frac = idx - lo;

  return {
    lat: coords[lo].lat + frac * (coords[hi].lat - coords[lo].lat),
    lon: coords[lo].lon + frac * (coords[hi].lon - coords[lo].lon),
  };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isInHamburg(lat, lon) {
  return (
    lat >= HH_BBOX.latMin &&
    lat <= HH_BBOX.latMax &&
    lon >= HH_BBOX.lonMin &&
    lon <= HH_BBOX.lonMax
  );
}

module.exports = { start, stop };

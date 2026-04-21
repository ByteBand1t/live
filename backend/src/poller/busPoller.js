const geofox = require("../geofox/client");
const cache  = require("../cache/redis");

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);

const HH_BBOX = {
  latMin: 53.3983, latMax: 53.7393,
  lonMin: 9.7487,  lonMax: 10.3121,
};

const clientViewports = new Map();

let io        = null;
let pollTimer = null;
let isPolling = false;

function start(socketIo) {
  io = socketIo;

  io.on("connection", (socket) => {
    socket.on("viewport:update", (bbox) => clientViewports.set(socket.id, bbox));
    socket.on("disconnect",      ()     => clientViewports.delete(socket.id));
  });

  console.log(`[Poller] Starting – interval: ${POLL_INTERVAL}ms`);
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL);
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function getMergedBbox() {
  const viewports = Array.from(clientViewports.values());
  if (!viewports.length) return HH_BBOX;
  return {
    latMin: Math.min(...viewports.map(v => v.latMin)),
    latMax: Math.max(...viewports.map(v => v.latMax)),
    lonMin: Math.min(...viewports.map(v => v.lonMin)),
    lonMax: Math.max(...viewports.map(v => v.lonMax)),
  };
}

function splitBbox(bbox) {
  const latSize = bbox.latMax - bbox.latMin;
  const lonSize = bbox.lonMax - bbox.lonMin;
  if (latSize < 0.08 && lonSize < 0.12) return [bbox];
  const midLat = (bbox.latMin + bbox.latMax) / 2;
  const midLon = (bbox.lonMin + bbox.lonMax) / 2;
  return [
    { latMin: midLat,       latMax: bbox.latMax, lonMin: bbox.lonMin, lonMax: midLon       },
    { latMin: midLat,       latMax: bbox.latMax, lonMin: midLon,      lonMax: bbox.lonMax  },
    { latMin: bbox.latMin,  latMax: midLat,      lonMin: bbox.lonMin, lonMax: midLon       },
    { latMin: bbox.latMin,  latMax: midLat,      lonMin: midLon,      lonMax: bbox.lonMax  },
  ];
}

async function poll() {
  if (isPolling) return;
  isPolling = true;
  try {
    const boxes      = splitBbox(getMergedBbox());
    const allVehicles = new Map();

    for (const box of boxes) {
      try {
        const result   = await geofox.getVehicleMap(box);
        const journeys = result.journeys || [];
        console.log(`[Poller] Box returned ${journeys.length} journeys`);

        for (const journey of journeys) {
          // Nur Journeys mit echter ID verarbeiten
          if (!journey.journeyID || journey.journeyID === "null") continue;
          const v = normalizeJourney(journey);
          // Nur Fahrzeuge mit gültiger Position UND Track
          if (v.lat && v.lon && v.trackData && v.trackData.length >= 2) {
            allVehicles.set(journey.journeyID, v);
          }
        }

        if (boxes.length > 1) await sleep(1100);
      } catch (err) {
        console.error("[Poller] Box error:", err.message);
      }
    }

    const vehicleArray = Array.from(allVehicles.values());
    await cache.set("vehicles:latest",    vehicleArray,             30);
    await cache.set("vehicles:lastUpdate", new Date().toISOString(), 30);

    if (io) {
      io.emit("vehicles:update", {
        vehicles:  vehicleArray,
        timestamp: new Date().toISOString(),
        count:     vehicleArray.length,
      });
    }
    console.log(`[Poller] Broadcast ${vehicleArray.length} buses (${boxes.length} box${boxes.length > 1 ? "es" : ""})`);
  } catch (err) {
    console.error("[Poller] Fatal:", err.message);
  } finally {
    isPolling = false;
  }
}

function normalizeJourney(journey) {
  const now      = Date.now();
  const segments = journey.segments || [];
  const activeSeg = segments.find(s => s.startDateTime <= now && s.endDateTime >= now)
                 || segments[0];

  if (!activeSeg) return { id: journey.journeyID, lat: null, lon: null };

  const track = activeSeg.track?.track || [];

  // Aktuelle Position für initiales Rendering
  const pos = interpolatePosition(track, activeSeg.startDateTime, activeSeg.endDateTime, now);

  return {
    id:              journey.journeyID,
    line:            journey.line?.name  || "?",
    lineId:          journey.line?.id    || null,
    direction:       activeSeg.destination || journey.line?.direction || "",
    lat:             pos.lat,
    lon:             pos.lon,
    // Track-Daten für client-seitige Animation
    trackData:       track,
    segStartMs:      activeSeg.startDateTime,
    segEndMs:        activeSeg.endDateTime,
    delay:           activeSeg.realtimeDelay  || 0,
    realtime:        journey.realtime         || false,
    vehicleType:     journey.vehicleType      || "METROBUS",
    startStationKey: activeSeg.startStationKey || null,
    startDateTime:   activeSeg.startDateTime   || null,
    color:           null,
  };
}

function interpolatePosition(track, startMs, endMs, now) {
  if (!track || track.length < 2) return { lat: null, lon: null };
  const duration = endMs - startMs;
  if (duration <= 0) return { lon: track[track.length - 2], lat: track[track.length - 1] };

  const progress   = Math.max(0, Math.min(1, (now - startMs) / duration));
  const pointCount = Math.floor(track.length / 2);
  if (pointCount === 1) return { lon: track[0], lat: track[1] };

  const floatIdx = progress * (pointCount - 1);
  const idx      = Math.floor(floatIdx);
  const frac     = floatIdx - idx;
  const next     = Math.min(idx + 1, pointCount - 1);

  return {
    lon: track[idx*2]   + frac * (track[next*2]   - track[idx*2]),
    lat: track[idx*2+1] + frac * (track[next*2+1] - track[idx*2+1]),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, stop };

/**
 * Bus Position Poller
 * Inspiriert von: github.com/bitnulleins/hvv_live_karte
 *
 * Position wird anhand von startDateTime/endDateTime
 * des Segments auf dem Track interpoliert.
 */

const geofox = require("../geofox/client");
const cache = require("../cache/redis");

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);

// Bounding Box aus Referenzprojekt übernommen – deckt Hamburg vollständig ab
const HH_BBOX = {
  latMin: parseFloat(process.env.HH_BBOX_LAT_MIN || "53.3983"),
  latMax: parseFloat(process.env.HH_BBOX_LAT_MAX || "53.7393"),
  lonMin: parseFloat(process.env.HH_BBOX_LON_MIN || "9.7487"),
  lonMax: parseFloat(process.env.HH_BBOX_LON_MAX || "10.3121"),
};

function getQuadrants() {
  const midLat = (HH_BBOX.latMin + HH_BBOX.latMax) / 2;
  const midLon = (HH_BBOX.lonMin + HH_BBOX.lonMax) / 2;
  return [
    { latMin: midLat,        latMax: HH_BBOX.latMax, lonMin: HH_BBOX.lonMin, lonMax: midLon        },
    { latMin: midLat,        latMax: HH_BBOX.latMax, lonMin: midLon,        lonMax: HH_BBOX.lonMax },
    { latMin: HH_BBOX.latMin, latMax: midLat,        lonMin: HH_BBOX.lonMin, lonMax: midLon        },
    { latMin: HH_BBOX.latMin, latMax: midLat,        lonMin: midLon,        lonMax: HH_BBOX.lonMax },
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
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function poll() {
  if (isPolling) {
    console.warn("[Poller] Previous poll still running, skipping");
    return;
  }
  isPolling = true;

  try {
    const allVehicles = new Map();

    for (const bbox of getQuadrants()) {
      try {
        const result = await geofox.getVehicleMap(bbox);
        const journeys = result.journeys || [];
        console.log(`[Poller] Quadrant returned ${journeys.length} journeys`);

        for (const journey of journeys) {
          const key = journey.journeyID;
          if (!key) continue;
          const normalized = normalizeJourney(journey);
          if (normalized.lat && normalized.lon) {
            allVehicles.set(key, normalized);
          }
        }

        await sleep(1100); // Rate Limit einhalten
      } catch (err) {
        console.error(`[Poller] Quadrant error:`, err.message);
      }
    }

    const vehicleArray = Array.from(allVehicles.values());

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
    console.error("[Poller] Fatal error:", err.message);
  } finally {
    isPolling = false;
  }
}

/**
 * Interpoliert die aktuelle Fahrzeugposition auf dem Track
 * basierend auf startDateTime / endDateTime des Segments.
 *
 * Track-Format: flaches Array [lon0, lat0, lon1, lat1, ...]
 * Timestamps: Unix-Millisekunden
 */
function interpolatePosition(track, startMs, endMs) {
  if (!track || track.length < 2) return { lon: null, lat: null };

  const now = Date.now();
  const duration = endMs - startMs;
  if (duration <= 0) {
    return { lon: track[track.length - 2], lat: track[track.length - 1] };
  }

  // Fortschritt 0.0 – 1.0
  const progress = Math.max(0, Math.min(1, (now - startMs) / duration));

  // Anzahl der Punkte im Track
  const pointCount = Math.floor(track.length / 2);
  if (pointCount === 1) return { lon: track[0], lat: track[1] };

  const floatIdx = progress * (pointCount - 1);
  const idx = Math.floor(floatIdx);
  const frac = floatIdx - idx;

  const nextIdx = Math.min(idx + 1, pointCount - 1);

  const lon = track[idx * 2]       + frac * (track[nextIdx * 2]       - track[idx * 2]);
  const lat = track[idx * 2 + 1]   + frac * (track[nextIdx * 2 + 1]   - track[idx * 2 + 1]);

  return { lon, lat };
}

function normalizeJourney(journey) {
  // Aktuelles Segment finden (erstes nicht-abgeschlossenes)
  const now = Date.now();
  const segments = journey.segments || [];

  let activeSeg = segments.find(
    (s) => s.startDateTime <= now && s.endDateTime >= now
  ) || segments[0];

  if (!activeSeg) return { id: journey.journeyID, lat: null, lon: null };

  const track = activeSeg.track?.track || [];
  const { lon, lat } = interpolatePosition(
    track,
    activeSeg.startDateTime,
    activeSeg.endDateTime
  );

  return {
    id: journey.journeyID,
    line: journey.line?.name || "?",
    direction: activeSeg.destination || journey.line?.direction || "",
    lat,
    lon,
    delay: activeSeg.realtimeDelay || 0,
    realtime: journey.realtime || false,
    vehicleType: journey.vehicleType || "METROBUS",
    startStation: activeSeg.startStationName || "",
    endStation: activeSeg.endStationName || "",
    color: null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { start, stop };

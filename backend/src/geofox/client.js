const crypto = require("crypto");

const GTI_BASE_URL = "https://gti.geofox.de/gti/public";
const MIN_REQUEST_INTERVAL_MS = Math.max(
  1000,
  parseInt(process.env.GEOFOX_MIN_INTERVAL_MS || "1000", 10)
);

const ALL_BUS_TYPES = [
  "METROBUS",
  "REGIONALBUS",
  "SCHNELLBUS",
  "NACHTBUS",
  "XPRESSBUS",
  "AST",
  "EILBUS",
];

let nextRequestAt = 0;
let queue = Promise.resolve();

function createSignature(body, password) {
  return crypto.createHmac("sha1", password).update(body, "utf8").digest("base64");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withRateLimit(task) {
  queue = queue
    .catch(() => undefined)
    .then(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, nextRequestAt - now);
      if (waitMs > 0) await sleep(waitMs);

      nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
      return task();
    });

  return queue;
}

async function geofoxRequest(endpoint, payload) {
  return withRateLimit(async () => {
    const user = process.env.GEOFOX_USER;
    const password = process.env.GEOFOX_PASSWORD;

    if (!user || !password) {
      throw new Error("Missing GEOFOX_USER or GEOFOX_PASSWORD");
    }

    const body = JSON.stringify(payload);
    const signature = createSignature(body, password);

    const response = await fetch(`${GTI_BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Accept: "application/json",
        "geofox-auth-type": "HmacSHA1",
        "geofox-auth-user": user,
        "geofox-auth-signature": signature,
        "X-Platform": "web",
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Geofox API error: ${response.status} – ${text}`);
    }

    const data = await response.json();
    if (data.returnCode !== "OK") {
      throw new Error(`Geofox returnCode: ${data.returnCode} – ${data.errorText || ""}`);
    }

    return data;
  });
}

async function init() {
  return geofoxRequest("init", {});
}

async function checkName(name, type = "STATION", maxResults = 10) {
  return geofoxRequest("checkName", {
    coordinateType: "EPSG_4326",
    maxList: maxResults,
    theName: { name, type },
  });
}

async function departureList(stationId, time = null, maxList = 20) {
  const now = time || new Date();
  return geofoxRequest("departureList", {
    station: { id: stationId, type: "STATION" },
    time: { date: formatDate(now), time: formatTime(now) },
    maxList,
    useRealtime: true,
    allStationsInChangingNode: true,
  });
}

async function departureCourse(lineKey, stationId, time) {
  return geofoxRequest("departureCourse", {
    lineKey,
    station: { id: stationId, type: "STATION" },
    time,
    useRealtime: true,
  });
}

async function getVehicleMap(boundingBox, vehicleTypes = ALL_BUS_TYPES) {
  const now = new Date();
  return geofoxRequest("getVehicleMap", {
    coordinateType: "EPSG_4326",
    boundingBox: {
      lowerLeft: { x: boundingBox.lonMin, y: boundingBox.latMin },
      upperRight: { x: boundingBox.lonMax, y: boundingBox.latMax },
    },
    vehicleTypes,
    periodBegin: { date: formatDate(now), time: formatTime(now) },
    periodEnd: { date: formatDate(now), time: formatTime(new Date(now.getTime() + 3600000)) },
  });
}


async function getTrackCoordinates(stopPointKeys) {
  return geofoxRequest("getTrackCoordinates", {
    coordinateType: "EPSG_4326",
    stopPointKeys,
  });
}

async function listStations() {
  return geofoxRequest("listStations", { coordinateType: "EPSG_4326" });
}

async function listLines() {
  return geofoxRequest("listLines", {});
}

async function getAnnouncements() {
  return geofoxRequest("getAnnouncements", { filterPlanned: "NO_FILTER" });
}

function formatDate(date) {
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

function formatTime(date) {
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

module.exports = {
  init,
  checkName,
  departureList,
  departureCourse,
  getVehicleMap,
  getTrackCoordinates,
  listStations,
  listLines,
  getAnnouncements,
};

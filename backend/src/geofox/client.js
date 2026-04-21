/**
 * Geofox GTI API Client
 * Handles HMAC-SHA1 authentication and all API methods
 */

const crypto = require("crypto");

const GTI_BASE_URL = "https://gti.geofox.de/gti/public";

/**
 * Generates the HMAC-SHA1 signature required by the Geofox API.
 * The signature is computed over the raw JSON request body.
 */
function createSignature(body, password) {
  return crypto
    .createHmac("sha1", password)
    .update(body, "utf8")
    .digest("base64");
}

/**
 * Makes an authenticated POST request to the Geofox GTI API.
 */
async function geofoxRequest(endpoint, payload) {
  const user = process.env.GEOFOX_USER;
  const password = process.env.GEOFOX_PASSWORD;

  if (!user || !password) {
    throw new Error("GEOFOX_USER and GEOFOX_PASSWORD must be set in .env");
  }

  const body = JSON.stringify(payload);
  const signature = createSignature(body, password);

  const url = `${GTI_BASE_URL}/${endpoint}`;

  const response = await fetch(url, {
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
    throw new Error(
      `Geofox API error: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  if (data.returnCode !== "OK") {
    throw new Error(`Geofox returnCode: ${data.returnCode}`);
  }

  return data;
}

// ─────────────────────────────────────────────
// API Methods
// ─────────────────────────────────────────────

/**
 * Initialise – verifies credentials are working.
 */
async function init() {
  return geofoxRequest("init", {});
}

/**
 * Search for stations, addresses, POIs by name.
 * type: "STATION" | "ADDRESS" | "POI" | "COORDINATE"
 */
async function checkName(name, type = "STATION", maxResults = 10) {
  return geofoxRequest("checkName", {
    coordinateType: "EPSG_4326",
    maxList: maxResults,
    theName: { name, type },
  });
}

/**
 * Get departure list for a station.
 */
async function departureList(stationId, time = null, maxList = 20) {
  const now = time || new Date();
  return geofoxRequest("departureList", {
    station: { id: stationId, type: "STATION" },
    time: {
      date: formatDate(now),
      time: formatTime(now),
    },
    maxList,
    useRealtime: true,
    allStationsInChangingNode: true,
  });
}

/**
 * Get the full course (all stops) of a specific departure.
 * lineKey and departureTime come from a departureList response.
 */
async function departureCourse(lineKey, stationId, time) {
  return geofoxRequest("departureCourse", {
    lineKey,
    station: { id: stationId, type: "STATION" },
    time,
    useRealtime: true,
  });
}

/**
 * Get live vehicle positions within a bounding box.
 * This is the heart of the live map feature.
 */
async function getVehicleMap(boundingBox, vehicleTypes = ["BUS"]) {
  return geofoxRequest("getVehicleMap", {
    coordinateType: "EPSG_4326",
    boundingBox: {
      lowerLeft: {
        x: boundingBox.lonMin,
        y: boundingBox.latMin,
        type: "EPSG_4326",
      },
      upperRight: {
        x: boundingBox.lonMax,
        y: boundingBox.latMax,
        type: "EPSG_4326",
      },
    },
    vehicleTypes,
    useRealtime: true,
  });
}

/**
 * Get the track (path geometry) for a list of stop point keys.
 * Used to draw the route line on the map.
 */
async function getTrackCoordinates(stopPointKeys) {
  return geofoxRequest("getTrackCoordinates", {
    coordinateType: "EPSG_4326",
    stopPointKeys,
  });
}

/**
 * List all stations in the HVV network (cached heavily).
 */
async function listStations(coordinateType = "EPSG_4326") {
  return geofoxRequest("listStations", { coordinateType });
}

/**
 * List all lines in the HVV network.
 */
async function listLines() {
  return geofoxRequest("listLines", {});
}

/**
 * Get disruption announcements.
 */
async function getAnnouncements(filter = null) {
  const payload = { filterPlanned: "NO_FILTER" };
  if (filter) payload.filter = filter;
  return geofoxRequest("getAnnouncements", payload);
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

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

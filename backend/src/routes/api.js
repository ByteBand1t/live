/**
 * REST API Routes
 * All routes proxy Geofox API calls with caching.
 */

const express = require("express");
const router = express.Router();
const geofox = require("../geofox/client");
const cache = require("../cache/redis");

// ─── Health Check ────────────────────────────────────────────────────────────

router.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Vehicles (latest snapshot from poller) ───────────────────────────────────

router.get("/vehicles", async (req, res) => {
  try {
    const vehicles = await cache.get("vehicles:latest");
    const lastUpdate = await cache.get("vehicles:lastUpdate");
    res.json({ vehicles: vehicles || [], lastUpdate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Search ───────────────────────────────────────────────────────────────────

router.get("/search", async (req, res) => {
  const { q, type = "STATION", limit = 10 } = req.query;
  if (!q) return res.status(400).json({ error: "Missing query param 'q'" });

  try {
    const cacheKey = `search:${type}:${q.toLowerCase()}`;
    const result = await cache.cached(cacheKey, 300, () =>
      geofox.checkName(q, type, parseInt(limit))
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Departures ───────────────────────────────────────────────────────────────

router.get("/departures/:stationId", async (req, res) => {
  const { stationId } = req.params;
  const { limit = 20 } = req.query;

  try {
    // Departures are time-sensitive – cache only 30s
    const cacheKey = `departures:${stationId}`;
    const result = await cache.cached(cacheKey, 30, () =>
      geofox.departureList(stationId, new Date(), parseInt(limit))
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Departure Course (full route of a single trip) ──────────────────────────

router.post("/course", async (req, res) => {
  const { lineKey, stationId, time } = req.body;
  if (!lineKey || !stationId) {
    return res.status(400).json({ error: "lineKey and stationId required" });
  }

  try {
    const cacheKey = `course:${lineKey}:${stationId}`;
    const result = await cache.cached(cacheKey, 60, () =>
      geofox.departureCourse(lineKey, stationId, time)
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Track Coordinates (route geometry) ──────────────────────────────────────

router.post("/track", async (req, res) => {
  const { stopPointKeys } = req.body;
  if (!stopPointKeys?.length) {
    return res.status(400).json({ error: "stopPointKeys array required" });
  }

  try {
    const cacheKey = `track:${stopPointKeys.join(",")}`;
    const result = await cache.cached(cacheKey, 3600, () =>
      geofox.getTrackCoordinates(stopPointKeys)
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stations List ────────────────────────────────────────────────────────────

router.get("/stations", async (req, res) => {
  try {
    // Stations rarely change – cache for 24h
    const result = await cache.cached("stations:all", 86400, () =>
      geofox.listStations()
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Lines List ───────────────────────────────────────────────────────────────

router.get("/lines", async (req, res) => {
  try {
    const result = await cache.cached("lines:all", 86400, () =>
      geofox.listLines()
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Announcements / Disruptions ─────────────────────────────────────────────

router.get("/announcements", async (req, res) => {
  try {
    const result = await cache.cached("announcements", 120, () =>
      geofox.getAnnouncements()
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

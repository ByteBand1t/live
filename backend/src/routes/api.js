const express = require("express");
const router  = express.Router();
const geofox  = require("../geofox/client");
const cache   = require("../cache/redis");

router.get("/health", (req, res) => res.json({ status: "ok" }));

router.get("/vehicles", async (req, res) => {
  try {
    const vehicles   = await cache.get("vehicles:latest");
    const lastUpdate = await cache.get("vehicles:lastUpdate");
    res.json({ vehicles: vehicles || [], lastUpdate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/search", async (req, res) => {
  const { q, type = "STATION", limit = 10 } = req.query;
  if (!q) return res.status(400).json({ error: "Missing q" });
  try {
    const result = await cache.cached(`search:${type}:${q.toLowerCase()}`, 300,
      () => geofox.checkName(q, type, parseInt(limit)));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/departures/:stationId", async (req, res) => {
  try {
    const result = await cache.cached(`departures:${req.params.stationId}`, 30,
      () => geofox.departureList(req.params.stationId, new Date(), parseInt(req.query.limit || 20)));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bus anklicken → Haltestellen + Route
// Erwartet: { lineKey, stationKey, startDateTime }
router.post("/bus-course", async (req, res) => {
  const { lineKey, stationKey, startDateTime } = req.body;
  if (!lineKey || !stationKey) return res.status(400).json({ error: "lineKey + stationKey required" });

  try {
    const cacheKey = `bus-course:${lineKey}:${stationKey}`;
    const result = await cache.cached(cacheKey, 60, () =>
      geofox.departureCourse(lineKey, stationKey, startDateTime)
    );
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/course", async (req, res) => {
  const { lineKey, stationId, time } = req.body;
  if (!lineKey || !stationId) return res.status(400).json({ error: "lineKey + stationId required" });
  try {
    const result = await cache.cached(`course:${lineKey}:${stationId}`, 60,
      () => geofox.departureCourse(lineKey, stationId, time));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/track", async (req, res) => {
  const { stopPointKeys } = req.body;
  if (!stopPointKeys?.length) return res.status(400).json({ error: "stopPointKeys required" });
  try {
    const result = await cache.cached(`track:${stopPointKeys.join(",")}`, 3600,
      () => geofox.getTrackCoordinates(stopPointKeys));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/stations", async (req, res) => {
  try {
    const result = await cache.cached("stations:all", 86400, () => geofox.listStations());
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/lines", async (req, res) => {
  try {
    const result = await cache.cached("lines:all", 86400, () => geofox.listLines());
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/announcements", async (req, res) => {
  try {
    const result = await cache.cached("announcements", 120, () => geofox.getAnnouncements());
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

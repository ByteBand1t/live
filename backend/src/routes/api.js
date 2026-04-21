const express = require("express");
const router  = express.Router();
const geofox  = require("../geofox/client");
const cache   = require("../cache/redis");

// Geofox gibt Timestamps in Sekunden zurück, nicht Millisekunden
function toGTITime(ts) {
  // Erkennung: Sekunden (< 10 Mrd) oder Millisekunden (> 10 Mrd)
  const ms = (ts > 9999999999) ? ts : ts * 1000;
  const d  = new Date(ms);
  console.log(`[GTITime] ts=${ts} → ${d.toISOString()}`);
  const date = String(d.getDate()).padStart(2,"0") + "." +
               String(d.getMonth()+1).padStart(2,"0") + "." +
               d.getFullYear();
  const time = String(d.getHours()).padStart(2,"0") + ":" +
               String(d.getMinutes()).padStart(2,"0");
  return { date, time };
}

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
    const result = await cache.cached(
      `search:${type}:${q.toLowerCase()}`, 300,
      () => geofox.checkName(q, type, parseInt(limit))
    );
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/departures/:stationId", async (req, res) => {
  const { stationId } = req.params;
  console.log(`[API] GET /departures/${stationId}`);
  try {
    const result = await cache.cached(
      `departures:${stationId}`, 30,
      () => geofox.departureList(stationId, new Date(), parseInt(req.query.limit || "20"))
    );
    console.log(`[API] Departures returnCode=${result.returnCode} count=${result.departures?.length}`);
    res.json(result);
  } catch (err) {
    console.error(`[API] Departures error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/bus-course", async (req, res) => {
  const { lineKey, stationKey, startDateTime } = req.body;
  console.log("[API] POST /bus-course", { lineKey, stationKey, startDateTime });

  if (!lineKey)    return res.status(400).json({ error: "lineKey fehlt" });
  if (!stationKey) return res.status(400).json({ error: "stationKey fehlt" });

  try {
    const gtiTime  = toGTITime(startDateTime || Math.floor(Date.now() / 1000));
    console.log("[API] bus-course gtiTime:", gtiTime);

    const result = await cache.cached(
      `bus-course:${lineKey}:${stationKey}:${gtiTime.date}`, 30,
      () => geofox.departureCourse(lineKey, stationKey, gtiTime)
    );
    console.log(`[API] bus-course OK returnCode=${result.returnCode} stops=${result.stopList?.length}`);
    res.json(result);
  } catch (err) {
    console.error("[API] bus-course error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/course", async (req, res) => {
  const { lineKey, stationId, time } = req.body;
  console.log("[API] POST /course", { lineKey, stationId });
  if (!lineKey || !stationId) return res.status(400).json({ error: "lineKey + stationId required" });
  try {
    const gtiTime = time || toGTITime(Math.floor(Date.now() / 1000));
    const result  = await cache.cached(
      `course:${lineKey}:${stationId}`, 60,
      () => geofox.departureCourse(lineKey, stationId, gtiTime)
    );
    console.log(`[API] course OK returnCode=${result.returnCode} stops=${result.stopList?.length}`);
    res.json(result);
  } catch (err) {
    console.error("[API] course error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/track", async (req, res) => {
  const { stopPointKeys } = req.body;
  if (!stopPointKeys?.length) return res.status(400).json({ error: "stopPointKeys required" });
  try {
    const result = await cache.cached(
      `track:${stopPointKeys.join(",")}`, 3600,
      () => geofox.getTrackCoordinates(stopPointKeys)
    );
    res.json(result);
  } catch (err) {
    console.error("[API] track error:", err.message);
    res.status(500).json({ error: err.message });
  }
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

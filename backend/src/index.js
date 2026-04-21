/**
 * Hamburg Bus Live – Backend Entry Point
 * Express + Socket.io + Geofox Poller
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const geofox = require("./geofox/client");
const cache = require("./cache/redis");
const poller = require("./poller/busPoller");
const apiRoutes = require("./routes/api");

const PORT = process.env.PORT || 3001;

// ─── Express Setup ────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", apiRoutes);

// ─── HTTP + Socket.io ─────────────────────────────────────────────────────────

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 5000,
});

// ─── WebSocket Events ─────────────────────────────────────────────────────────

io.on("connection", async (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Send latest vehicle snapshot immediately on connect
  const vehicles = await cache.get("vehicles:latest");
  if (vehicles) {
    socket.emit("vehicles:update", {
      vehicles,
      timestamp: await cache.get("vehicles:lastUpdate"),
      count: vehicles.length,
    });
  }

  // Client can request departures for a specific station via WS
  socket.on("departures:request", async ({ stationId }) => {
    try {
      const result = await cache.cached(`departures:${stationId}`, 30, () =>
        geofox.departureList(stationId)
      );
      socket.emit("departures:response", { stationId, ...result });
    } catch (err) {
      socket.emit("error", { message: err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  console.log("[Startup] Verifying Geofox credentials...");

  try {
    await geofox.init();
    console.log("[Startup] ✓ Geofox API credentials valid");
  } catch (err) {
    console.error("[Startup] ✗ Geofox credential check failed:", err.message);
    console.error("[Startup] Check GEOFOX_USER and GEOFOX_PASSWORD in .env");
    process.exit(1);
  }

  poller.start(io);

  httpServer.listen(PORT, () => {
    console.log(`[Startup] Server running on http://localhost:${PORT}`);
    console.log(`[Startup] WebSocket endpoint: ws://localhost:${PORT}`);
  });
}

start();

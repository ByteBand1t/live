/**
 * Socket.io Client Module
 * Handles the WebSocket connection to the backend.
 */

import { io } from "socket.io-client";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";

let socket = null;

export function connectSocket({ onVehicleUpdate, onConnect, onDisconnect, onError }) {
  socket = io(BACKEND_URL, {
    transports: ["websocket", "polling"],
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
  });

  socket.on("connect", () => {
    console.log("[Socket] Connected:", socket.id);
    if (onConnect) onConnect();
  });

  socket.on("disconnect", (reason) => {
    console.warn("[Socket] Disconnected:", reason);
    if (onDisconnect) onDisconnect(reason);
  });

  socket.on("connect_error", (err) => {
    console.error("[Socket] Error:", err.message);
    if (onError) onError(err);
  });

  socket.on("vehicles:update", (data) => {
    if (onVehicleUpdate) onVehicleUpdate(data);
  });

  socket.on("departures:response", (data) => {
    window.dispatchEvent(new CustomEvent("departures:received", { detail: data }));
  });

  return socket;
}

export function requestDepartures(stationId) {
  if (socket) socket.emit("departures:request", { stationId });
}

export function getSocket() {
  return socket;
}

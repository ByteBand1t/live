/**
 * Side Panel Component
 * Shows station departures or single bus details.
 */

const panel = document.getElementById("side-panel");
const panelContent = document.getElementById("panel-content");
const panelClose = document.getElementById("panel-close");

panelClose.addEventListener("click", closePanel);

export function openPanel(html) {
  panelContent.innerHTML = html;
  panel.classList.remove("hidden");
}

export function closePanel() {
  panel.classList.add("hidden");
  // Deactivate station markers
  document.querySelectorAll(".station-marker.active").forEach((m) =>
    m.classList.remove("active")
  );
}

// ─── Station Departures Panel ─────────────────────────────────────────────────

export function showLoadingPanel(title) {
  openPanel(`
    <div class="panel-station-name">${title}</div>
    <div class="loading-spinner">Lade Abfahrten…</div>
  `);
}

export function renderStationPanel(station, departures, onLineClick) {
  const items = (departures || []).map((dep) => {
    const delay = dep.delay || dep.depDelay || 0;
    const timeClass = delay > 120 ? "delayed" : "ontime";
    const planned = dep.timeOffset || dep.time || "";
    const bg = dep.line?.color || "#1a56db";

    return `
      <div class="departure-item" data-linekey="${dep.serviceId?.id || ""}"
           data-station="${station.id}">
        <div class="dep-line-badge" style="background:${bg}">
          ${dep.line?.name || "?"}
        </div>
        <div>
          <div class="dep-direction">${dep.direction || ""}</div>
          ${dep.platform ? `<div class="dep-platform">Steig ${dep.platform}</div>` : ""}
        </div>
        <div>
          <div class="dep-time ${timeClass}">${planned}</div>
          ${delay > 60 ? `<div class="dep-delay">+${Math.round(delay / 60)} min</div>` : ""}
        </div>
      </div>
    `;
  });

  openPanel(`
    <div class="panel-station-name">${station.name}</div>
    <div class="panel-station-id">${station.id}</div>
    <div class="panel-section-title">Nächste Abfahrten</div>
    <div class="departures-list">
      ${items.length ? items.join("") : "<div class='loading-spinner'>Keine Abfahrten</div>"}
    </div>
  `);

  // Attach click handlers for course lookup
  panelContent.querySelectorAll(".departure-item").forEach((el) => {
    el.addEventListener("click", () => {
      const lineKey = el.dataset.linekey;
      const stationId = el.dataset.station;
      if (lineKey && onLineClick) onLineClick(lineKey, stationId);
    });
  });
}

// ─── Bus Detail Panel ─────────────────────────────────────────────────────────

export function renderBusPanel(bus, course) {
  const bg = bus.color || "#1a56db";
  const delay = bus.delay || 0;
  const delayText =
    delay > 60
      ? `+${Math.round(delay / 60)} Min Verspätung`
      : delay < -30
      ? "Früher als geplant"
      : "Pünktlich";

  const stops = (course?.stopList || [])
    .map((stop, i) => {
      const isCurrent = stop.isCurrentStop || false;
      return `
        <div class="stop-item">
          <div class="stop-time">${stop.time?.time || ""}</div>
          <div class="stop-name ${isCurrent ? "current" : ""}">
            ${isCurrent ? "▶ " : ""}${stop.station?.name || ""}
          </div>
        </div>
      `;
    })
    .join("");

  openPanel(`
    <div class="panel-bus-line" style="background:${bg}">
      ${bus.line}
    </div>
    <div class="panel-bus-direction">→ ${bus.direction}</div>
    <div class="panel-bus-status ${delay > 120 ? "delayed" : "ontime"}">
      ${delayText}
    </div>
    <div class="panel-section-title">Haltestellen</div>
    <div class="next-stops">${stops || "<div class='loading-spinner'>Keine Daten</div>"}</div>
  `);
}

const panel        = document.getElementById("side-panel");
const panelContent = document.getElementById("panel-content");
const panelClose   = document.getElementById("panel-close");

panelClose.addEventListener("click", closePanel);

export function openPanel(html) {
  panelContent.innerHTML = html;
  panel.classList.remove("hidden");
}

export function closePanel() {
  panel.classList.add("hidden");
  document.querySelectorAll(".station-marker.active").forEach((m) => m.classList.remove("active"));
  document.querySelectorAll(".bus-marker.selected").forEach((m) => m.classList.remove("selected"));
}

export function showLoadingPanel(title) {
  openPanel(`
    <div class="panel-chip">⏳ Lädt</div>
    <div class="panel-title">${title}</div>
    <div class="panel-loading">
      <div class="spinner"></div>
      Echtzeit-Daten werden abgerufen…
    </div>
  `);
}

// ─── Station Panel ────────────────────────────────────────────────────────────

export function renderStationPanel(station, departures, onLineClick) {
  const items = (departures || []).map((dep) => {
    const delay   = dep.delay || dep.depDelay || 0;
    const delayed = delay > 60;
    const bg      = dep.line?.color || lineColor(dep.line?.name);
    const time    = dep.timeOffset || dep.time?.time || "–";

    return `
      <div class="departure-item"
           data-linekey="${dep.serviceId?.id || dep.line?.id || ""}"
           data-station="${station.id}">
        <div class="dep-badge" style="background:${bg}">${dep.line?.name || "?"}</div>
        <div>
          <div class="dep-direction">${dep.direction || "–"}</div>
          ${dep.platform ? `<div class="dep-stop">Steig ${dep.platform}</div>` : ""}
        </div>
        <div class="dep-time-col">
          <div class="dep-time ${delayed ? "delayed" : ""}">${time}</div>
          ${delayed ? `<div class="dep-delay">+${Math.round(delay/60)} min</div>` : ""}
        </div>
      </div>`;
  });

  openPanel(`
    <div class="panel-chip">🚏 Haltestelle</div>
    <div class="panel-title">${station.name}</div>
    <div class="panel-section-label">Nächste Abfahrten</div>
    <div class="departures-list">
      ${items.length ? items.join("") : `<div class="panel-loading"><div class="spinner"></div>Keine Abfahrten</div>`}
    </div>
  `);

  panelContent.querySelectorAll(".departure-item").forEach((el) => {
    el.addEventListener("click", () => {
      const { linekey, station: sid } = el.dataset;
      if (linekey && onLineClick) onLineClick(linekey, sid);
    });
  });
}

// ─── Bus Panel ────────────────────────────────────────────────────────────────

export function renderBusPanel(bus, course) {
  const bg      = bus.color || lineColor(bus.line);
  const delay   = bus.delay || 0;
  const delayed = delay > 60;

  const statusText = delayed
    ? `+${Math.round(delay / 60)} Min Verspätung`
    : delay < -30 ? "Früher als geplant" : "Pünktlich ✓";

  const vehicleLabel = {
    METROBUS: "Metrobus", REGIONALBUS: "Regionalbus", SCHNELLBUS: "Schnellbus",
    NACHTBUS: "Nachtbus", XPRESSBUS: "Xpressbus", AST: "AST", EILBUS: "Eilbus",
  }[bus.vehicleType] || "Bus";

  // Stop Timeline
  const now = Date.now();
  const stops = (course?.stopList || []).map((stop) => {
    const stopTime  = stop.time?.time || "";
    const isCurrent = stop.isCurrentStop || false;
    const isPassed  = stop.isPassed || false;
    const cls       = isCurrent ? "current" : isPassed ? "passed" : "upcoming";
    return `
      <div class="stop-item ${cls}">
        <div class="stop-time">${stopTime}</div>
        <div class="stop-name ${cls}">${stop.station?.name || stop.stationName || "–"}</div>
      </div>`;
  }).join("");

  openPanel(`
    <div class="panel-chip">🚌 ${vehicleLabel}</div>
    <div class="bus-header">
      <div class="bus-line-badge" style="background:${bg}">${bus.line || "?"}</div>
      <div class="bus-meta">
        <div class="bus-direction">→ ${bus.direction || "–"}</div>
        <div class="bus-type">${vehicleLabel} · Echtzeit</div>
      </div>
    </div>
    <div class="bus-status-pill ${delayed ? "delayed" : "ontime"}">
      ${delayed ? "⚠️" : "✓"} ${statusText}
    </div>
    ${course ? `
      <div class="panel-section-label">Streckenverlauf</div>
      <div class="stop-timeline">
        ${stops || `<div class="panel-loading"><div class="spinner"></div></div>`}
      </div>
    ` : `<div class="panel-loading"><div class="spinner"></div>Lade Haltestellenfolge…</div>`}
  `);
}

// Konsistente Farbe pro Linie
function lineColor(name) {
  if (!name) return "#2563EB";
  let h = 0;
  for (const c of name) h = c.charCodeAt(0) + ((h << 5) - h);
  const cols = ["#E2001A","#2563EB","#16A34A","#D97706","#7C3AED","#0891B2","#DC2626","#0284C7"];
  return cols[Math.abs(h) % cols.length];
}

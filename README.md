# 🚌 Livemap

Live-Karte aller Busse in Hamburg mit **echter Live-Position** aus der Geofox GTI API (keine berechneten Positionen).

## Stack

| Layer | Technologie |
|-------|-------------|
| Backend | Node.js 20 + Express + Socket.io |
| Karte | MapLibre GL + OpenStreetMap |
| Frontend | Vanilla JS + Vite |
| Cache | Redis 7 |
| Proxy | Nginx |
| Container | Docker Compose |

---

## Schnellstart (Entwicklung)

```bash
# 1. Repo klonen
git clone https://github.com/DEIN_USER/livemap.git
cd livemap

# 2. Zugangsdaten setzen
cp .env.example .env
# .env öffnen und GEOFOX_USER + GEOFOX_PASSWORD eintragen

# 3. Alles starten
docker compose up --build
```

→ App unter **http://localhost**

---

## Deployment via Portainer

1. In Portainer → **Stacks** → **Add Stack**
2. Name: `livemap`
3. "Repository" wählen → GitHub URL eintragen
4. Environment Variables setzen:
   - `GEOFOX_USER=MaximilianMevs`
   - `GEOFOX_PASSWORD=<dein_passwort>`
5. **Deploy the stack**

Oder alternativ mit Portainer Webhook (Auto-Deploy bei Git Push):
- Stack → **Webhooks** → URL kopieren
- In GitHub → Settings → Webhooks → URL eintragen

---

## Projektstruktur

```
livemap/
├── docker-compose.yml
├── .env.example               ← Vorlage für Zugangsdaten
│
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js           ← Entry point: Express + Socket.io + Startup
│       ├── geofox/
│       │   └── client.js      ← Geofox GTI API Wrapper (HMAC-SHA1 Auth)
│       ├── cache/
│       │   └── redis.js       ← Redis Cache Layer
│       ├── poller/
│       │   └── busPoller.js   ← Holt jede Sekunde Live-Positionen, broadcast via WS
│       └── routes/
│           └── api.js         ← REST Endpoints
│
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.js            ← Hauptlogik: Map + Socket + Search + Panel
│       ├── styles/
│       │   └── main.css
│       ├── map/
│       │   └── map.js         ← MapLibre GL, Bus/Station-Marker, Route-Line
│       ├── components/
│       │   └── panel.js       ← Side Panel: Abfahrten + Bus-Details
│       └── socket/
│           └── socket.js      ← Socket.io Client
│
└── nginx/
    └── nginx.conf             ← Reverse Proxy
```

---

## API Endpoints

| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET | `/api/health` | Health check |
| GET | `/api/vehicles` | Aktueller Bus-Snapshot aus Cache |
| GET | `/api/search?q=Altona` | Haltestellen/Adressen suchen |
| GET | `/api/departures/:stationId` | Abfahrten einer Haltestelle |
| POST | `/api/course` | Vollständiger Linienweg eines Trips |
| POST | `/api/track` | GPS-Koordinaten einer Route |
| GET | `/api/stations` | Alle HVV-Haltestellen |
| GET | `/api/lines` | Alle HVV-Linien |
| GET | `/api/announcements` | Störungsmeldungen |

## WebSocket Events

| Event | Richtung | Payload |
|-------|----------|---------|
| `vehicles:update` | Server → Client | `{ vehicles[], timestamp, count }` |
| `departures:request` | Client → Server | `{ stationId }` |
| `departures:response` | Server → Client | Geofox departureList Response |

---

## Geofox API Authentifizierung

Die GTI API verwendet **HMAC-SHA1** Signaturen. Der Ablauf:

1. Request-Body als JSON serialisieren
2. HMAC-SHA1 über den Body mit dem Passwort als Key berechnen
3. Base64-kodiertes Ergebnis als `geofox-auth-signature` Header mitsenden

Implementiert in `backend/src/geofox/client.js`.

---

## Rate Limits

⚠️ Geofox sperrt Accounts bei **> 1 Request/Sekunde** (temporär).

Unsere Lösung:
- **Zentrale Request-Queue** im Backend: maximal **1 API-Request pro Sekunde** über alle Endpunkte hinweg
- **Live-only Poller** mit mindestens 1000ms Intervall
- **Nur Fahrzeuge mit echter Echtzeitposition** werden veröffentlicht

---

## Nächste Schritte / Feature-Ideen

- [ ] S-Bahn, U-Bahn, Fähren hinzufügen (vehicleTypes erweitern)
- [ ] Störungslayer auf der Karte (getAnnouncements)
- [ ] Statistik-Dashboard (Verspätungen nach Linie)
- [ ] "Bus verfolgen" Modus (Kamera folgt einem Bus)
- [ ] PWA + Homescreen-Icon
- [ ] Dark/Light Mode Toggle
- [ ] Heatmap der Bus-Dichte
- [ ] Abfahrtsboard-Modus (Vollbild-Anzeige)
- [ ] Push-Benachrichtigungen bei Verspätungen

---

## Umgebungsvariablen

| Variable | Beschreibung | Default |
|----------|--------------|---------|
| `GEOFOX_USER` | API Benutzername | – |
| `GEOFOX_PASSWORD` | API Passwort (für HMAC) | – |
| `PORT` | Backend-Port | `3001` |
| `REDIS_URL` | Redis-Verbindung | `redis://redis:6379` |
| `POLL_INTERVAL_MS` | Polling-Intervall (min. 1000ms) | `1000` |
| `HH_BBOX_*` | Hamburg Bounding Box | Hamburg gesamt |

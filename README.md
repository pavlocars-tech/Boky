# TaxiAds

Werbeflächen auf Bildschirmen in Wiener Taxis: Player-App (Android), Backend und Web-Oberfläche (Admin + Kundenportal).

Architektur, Datenmodell und Entscheidungen: [`docs/ARCHITEKTUR.md`](docs/ARCHITEKTUR.md)

| Ordner | Inhalt | Stand |
|---|---|---|
| `packages/shared` | Schleifen- und Buchungslogik, Helligkeitsplan, Geräteprotokoll (TypeScript, ohne Datenbank) | ✅ Phase 1 |
| `apps/api` | API-Server + Worker (Node.js, Fastify, PostgreSQL/PostGIS, S3) | ✅ Phase 1 |
| `apps/player-android` | Player-App (Kotlin, Media3) | Phase 2 |
| `apps/web` | Admin-Bereich und Kundenportal (Next.js) | Phase 3/4 |

## Schnellstart (lokal)

Voraussetzungen: Node.js 22, pnpm 10, PostgreSQL 16 mit PostGIS, ffmpeg – **oder** Docker.

### Variante A: Docker (am einfachsten)

```bash
docker compose up --build              # Datenbank, MinIO (S3), API (Port 3000), Worker
docker compose exec api node dist/cli/seed.js   # Demodaten
```

### Variante B: ohne Docker

```bash
pnpm install
# Datenbank "taxiads" (User/Passwort taxiads) mit PostGIS anlegen, dann:
pnpm db:migrate
pnpm dev:api          # Terminal 1: API auf http://localhost:3000
pnpm dev:worker       # Terminal 2: Worker (Medien, Playlists, Löschfristen)
pnpm db:seed          # Terminal 3: Demodaten (API muss laufen)
```

Medien landen ohne Docker im Ordner `apps/api/.data/storage` (lokaler Speicher statt S3).

**Demo-Zugänge** (nur Seed): Admin `admin@taxiads.local` / `admin-passwort-123`, Kunde `kunde@example.com` / `kunden-passwort-123`.
E-Mails (Bestätigung, Einladung, Passwort) erscheinen ohne `SMTP_URL` im Log der API.

## Tests

```bash
pnpm test        # Unit-Tests (Schleife/Buchung/Helligkeit) + Integrationstests gegen PostgreSQL
pnpm typecheck
```

Die Integrationstests legen die Datenbank `taxiads_test` selbst neu an (`TEST_DATABASE_URL` überschreibt die Adresse).

## Phase 1 testen

1. **Automatische Tests:** `pnpm test` – 52 Unit-Tests und 44 Integrationstests, u. a.:
   - nie mehr als 300 s pro Fahrzeug und Tag verkauft, auch bei gleichzeitigen Buchungen
   - Pausieren, Beenden, Stornieren, Erhöhen; Schleifenlänge als Richtwert
   - Füllinhalte füllen jede Schleife exakt, Motive wechseln sich ab
   - Helligkeit 06–16 Uhr 50 %, sonst 5 %, inkl. Sommer-/Winterzeit in Wien
   - Kunden sehen nur eigene Daten; Geräte-Anmeldung nur mit eigenem Schlüssel
   - Logs/GPS idempotent (doppelter Upload aus dem Funkloch zählt nicht doppelt), GPS-Löschfrist 90 Tage
   - Upload: zu lange Videos werden abgelehnt, Umwandlung auf 1920×1200 ohne Ton
2. **API ausprobieren:** http://localhost:3000/docs (Swagger). Zuerst `POST /auth/login` mit einem Demo-Zugang ausführen, danach funktionieren die anderen Aufrufe im selben Browser.
   - Kunde: `POST /portal/availability` → `{"startDate":"2026-11-10","endDate":"2026-11-30","secondsPerLoop":30}` zeigt freie Fahrzeuge; `POST /portal/campaigns` mit `"book": true` bucht.
   - Admin: `GET /admin/utilization?from=…&to=…` zeigt die Auslastung, `GET /admin/vehicles/{id}/playlist` die erzeugte Schleife.
3. **Taxi-Bildschirm simulieren** (bis die Android-App fertig ist):
   ```bash
   pnpm --filter @taxiads/api simulate-device --speed 10
   ```
   Der Simulator zeigt einen 6-stelligen Code. Diesen im Swagger-UI als Admin mit `POST /admin/devices/claim` (`{"code":"123456","vehicleId":"…"}`) einem Fahrzeug zuordnen. Danach lädt der Simulator die Playlist, „spielt“ 10-fach beschleunigt und sendet Ausspiel-Logs, GPS und Lebenszeichen. Prüfen mit `GET /admin/devices` (online, was läuft gerade, letzte Position).

## Produktion

- `.env.example` enthält alle Einstellungen (S3 in der EU, SMTP, `APP_SECRET`).
- API und Worker getrennt starten (`node dist/index.js`, `node dist/worker.js`); beide aus `apps/api/Dockerfile`.
- Ersten Admin anlegen: `node dist/cli/create-admin.js admin@firma.at 'langes-passwort' "Vorname Nachname"`.
- TLS über einen vorgeschalteten Proxy (z. B. Caddy/Traefik); Cookies sind in Produktion automatisch `Secure`.

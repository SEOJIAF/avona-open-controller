# open-avona web app

A self-hosted web app, compatible with popular Anova cookers, that covers the main flows: **create an account or sign in, find
and set up a cooker, and cook with it.** It is plain Node.js (22+) with no npm dependencies, and talks to
Anova's cloud exactly as the Android app does (see [`../PROTOCOL.md`](../PROTOCOL.md)).

## Run it

**Node:**

```bash
npm start
```

Open http://localhost:8080.

**Docker Compose,** from the repository root:

```bash
docker compose up -d --build
```

The container also serves http://localhost:8080.

**Docker without Compose:**

```bash
docker build -t open-avona .
```

```bash
docker run -d -p 127.0.0.1:8080:8080 open-avona
```

**Offline demo:** this simulates the accounts, the cloud, a cooker and Bluetooth, and never contacts Anova.

```bash
npm run start:mock
```

Demo login: `demo@example.com` / `demo1234`.

## Using it

### 1. Account (`/login`)

- **Create account** makes a real Anova Culinary account: Firebase sign-up, then registration with Anova, as the app does it.
- **Sign in** works with any Anova account that has an email and password.

Google, Facebook and Apple sign-ins have no password and can't be used here.

### 2. Add a cooker (`/setup`)

**Precision Cooker Wi‑Fi (AN500) / Pro Wi‑Fi** (`/setup-wifi`). This works even if the cooker is linked to an
account you no longer have access to.
1. Open the page **on the computer running the server**. Setup switches that computer's Wi‑Fi.
2. Hold the cooker's **target temperature** button for 5 seconds. It shows a 4‑digit code and opens a hotspot `Anova <code>`.
3. Type the code. The server joins the hotspot, either automatically through NetworkManager or after you join it by hand.
4. Pick your **2.4 GHz** home network from the cooker's own scan and enter its password.
5. The cooker joins your Wi‑Fi and is linked to your account. Your computer goes back to its previous network, and the page waits for the cooker to appear in your account.

Don't touch the system's network menu while setup runs.

**Precision Cooker 3.0, Nano 3.0, Mini/Lite, Pro 3.0** (`/setup`). This runs over **Web Bluetooth** in the browser.
1. Use Chrome or Edge near the cooker, on `http://localhost` or HTTPS (see *Phones and HTTPS*). On Linux, enable `chrome://flags/#enable-experimental-web-platform-features`.
2. Put the cooker in pairing mode. A new cooker is usually already in it.
   - **3.0 / Nano 3.0:** hold **timer** and **–** for 10 seconds.
   - **Mini/Lite:** hold the button for 10 seconds until the LED blinks.
   - **Pro 3.0:** open the Wi‑Fi menu on the display.
3. **Find my cooker**, then confirm the code shown on the cooker by pressing any of its buttons.
4. Choose your Wi‑Fi. The page then links the cooker to your account.

### 3. Cook (`/`)

Each cooker card shows live water temperature, target and timer, with Start (target + optional timer), Stop,
Update temp, Update timer and °C/°F. Low water and offline states show next to the model.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Listen address |
| `TLS_CERT`, `TLS_KEY` | – | Serve HTTPS with this certificate and key |
| `COOKIE_SECURE` | – | `1` marks the session cookie `Secure` when HTTPS is terminated by a proxy (automatic with `TLS_*`) |
| `ANOVA_FIREBASE_API_KEY` | key from the app | Override the Firebase web API key |
| `ANOVA_WS_LOG` | – | File path; appends every raw cloud message, in both directions, for debugging. Tokens are not logged. |
| `MOCK` | – | `1` = offline simulation |

## Docker notes

- The image is `node:22-alpine` plus the app, runs as the unprivileged `node` user, and has a health check on `/api/config`.
- The Compose file publishes the port on **localhost only**.
- **2nd‑gen Wi‑Fi setup needs the host's network.** A bridged container can't reach the cooker's hotspot (`10.123.45.1`), and its requests don't count as local. For that one‑time step:
  - **Option 1:** run `npm start` on the host.
  - **Option 2:** on Linux, run the host-network variant and join the `Anova <code>` Wi‑Fi on the host yourself when the page asks. NetworkManager isn't available inside the container, so the page switches to manual mode.

    ```bash
    docker compose --profile host-network up -d --build open-avona-host
    ```

  After setup, the normal container controls the cooker over the cloud.
- Sessions live in memory, so `docker compose restart` signs everyone out.

## Phones and HTTPS

Web Bluetooth (3rd‑gen setup) only works on `localhost` or HTTPS. To use a phone:
- **USB (simplest).** Connect the phone with USB debugging on and run the command below. Then open `http://localhost:8080` in Chrome on the phone.

  ```bash
  adb reverse tcp:8080 tcp:8080
  ```

- **Local HTTPS.** Create a private CA and a certificate for your LAN address:

  ```bash
  tools/make-local-https.sh 192.168.1.20
  ```

  Install `certs/ca.crt` on the phone (Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate). Then start the server with HTTPS:

  ```bash
  TLS_CERT=certs/server.crt TLS_KEY=certs/server.key HOST=0.0.0.0 npm start
  ```

  With Docker, mount `certs/` and set the same variables (see `docker-compose.yml`).
- **Reverse proxy.** Put Caddy, nginx or similar in front and set `COOKIE_SECURE=1`.

Cooking itself needs no Bluetooth and works from any browser that can reach the server.

## HTTP API

All routes except `/login`, `/api/login`, `/api/signup` and `/api/config` need the session cookie. POST bodies are JSON.

| Route | Purpose |
|---|---|
| `POST /api/login`, `POST /api/signup` `{email, password}` | Start a session |
| `POST /api/logout`, `GET /api/me` | End the session; current user `{email, uid}` |
| `GET /api/status` | Cloud connection and cookers with their last state |
| `GET /api/events` | Server‑Sent Events: `status`, `devices`, `state` |
| `POST /api/devices/{id}/start` `{targetTemperature, unit, timerMinutes}` | Start cooking |
| `POST /api/devices/{id}/stop` | Stop |
| `POST /api/devices/{id}/temperature` `{targetTemperature, unit}` | Change target |
| `POST /api/devices/{id}/timer` `{timerMinutes}` | Change timer |
| `POST /api/devices/{id}/unit` `{unit}` | °C / °F |
| `POST /api/gen2/join` `{code, auto}`, `/scan`, `/configure` `{ssid, password, securityType}`, `/cancel` | 2nd‑gen Wi‑Fi setup steps (local requests only) |

## Code map

| File | Role |
|---|---|
| `server.mjs` | HTTP(S) server, sessions, API routes |
| `anova-cloud.mjs` | Firebase auth, Anova sign-up registration, cloud WebSocket client |
| `gen2-setup.mjs` | 2nd‑gen Wi‑Fi setup: cooker hotspot HTTP API and NetworkManager control |
| `public/gen3-ble.js` | 3rd‑gen Bluetooth setup protocol (Web Bluetooth) |
| `public/*.html` | Login, dashboard, setup pages |
| `public/app.css`, `public/icon.svg` | Shared styles (light/dark, animated water) and app icon |
| `mock-cloud.mjs`, `public/mock-bluetooth.js` | Offline simulation for `MOCK=1` |
| `tests/` | `npm test` |
| `tools/make-local-https.sh` | Local CA and certificate for LAN HTTPS |

## Troubleshooting

- **The cooker's hotspot isn't found:** check the code on its display. A new code appears each time you hold the button. Keep the laptop close.
- **"Lost contact with the cooker":** the computer left the cooker's Wi‑Fi. Usually the system network menu or a saved network took over. Start again from the code.
- **"The cooker could not join that Wi‑Fi network":** wrong password, or a network that is 5 GHz-only. Guest networks often block devices from reaching the internet.
- **The cooker is on the dashboard but shows "no status from the cloud yet":** it hasn't checked in. Check the Wi‑Fi symbol on its display.
- **Commands time out:** the cooker is offline, or the cloud didn't answer within 10 s. Run with `ANOVA_WS_LOG=/tmp/ws.log` to see the raw messages.
- **Bluetooth "not supported":** use Chrome or Edge on `localhost`/HTTPS. Firefox-based browsers and Safari have no Web Bluetooth.

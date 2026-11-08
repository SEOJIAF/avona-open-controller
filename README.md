# open-avona

**An unofficial, self-hosted web controller, compatible with popular Anova Precision® Cookers.** Built from a
reverse-engineered protocol spec. Create or sign in to your Anova account, set up a cooker on your Wi‑Fi
(including taking over a cooker that is still linked to an old account), and cook from any browser.

> Not affiliated with, endorsed by, or supported by Anova Applied Electronics, Inc. "Anova" and "Precision" are
> their trademarks, used here only to say which cookers this works with. This project talks to Anova's own cloud with your own account; it is an interoperability
> project for owners of the hardware. Anova can change their service at any time and break it.

## What's in here

| Path | What it is |
|---|---|
| [`webapp/`](webapp/) | The controller: a dependency-free Node.js server and web UI, with Docker support |
| [`PROTOCOL.md`](PROTOCOL.md) | Protocol spec: Bluetooth, cloud WebSocket, REST, Wi‑Fi provisioning, auth. Every claim is labelled as observed in the app or inferred. |
| [`schemas/`](schemas/) | JSON Schemas for cloud messages, rebuilt from the app |
| [`docker-compose.yml`](docker-compose.yml) | One-command deployment |

## Device support

| Cooker | Model numbers (examples) | Setup | Cooking | Status |
|---|---|---|---|---|
| Precision Cooker Wi‑Fi (2nd gen), Pro Wi‑Fi | AN500‑xx | Through the cooker's own hotspot, run by the server | Cloud | **Tested end-to-end on an AN500**: setup, account takeover, start/stop, temperature, live state |
| Precision Cooker 3.0, Nano 3.0, Mini/Lite, Pro 3.0 | AN525, … | Bluetooth from the browser (Web Bluetooth) | Cloud | Implemented from the app code; tested against a simulated cooker only |
| Original Bluetooth / Wi‑Fi cookers, Nano (1st gen) | AN100, AN400 | — | — | Protocol documented in `PROTOCOL.md`; not implemented |
| Precision Oven | — | — | — | Message schemas documented; not implemented |

## Quick start

**Docker:**

```bash
docker compose up -d --build
```

Open **http://localhost:8080**.

**Node.js 22 or newer, no `npm install` needed:**

```bash
cd webapp && npm start
```

Then:
1. **Create an account or sign in.** These are real Anova Culinary accounts, the same as in the official app.
2. **+ Add a cooker.** Follow the setup for your model; the page tells you which button to hold.
3. **Cook.** You get live water and target temperature, timer, start/stop and °C/°F.

See [`webapp/README.md`](webapp/README.md) for the full guide: setting up each model, Docker networking for Wi‑Fi
setup, HTTPS for phones, configuration, the HTTP API and troubleshooting.

## How it works

```
 browser ──HTTP──▶ webapp/server.mjs ──WebSocket──▶ wss://devices.anovaculinary.io ──▶ cooker
    │                     │                ▲
    │                     │                └── Firebase Auth (your Anova account) + /authenticate
    │                     └──HTTP──▶ cooker hotspot 10.123.45.1   (2nd-gen Wi‑Fi setup only)
    └──Web Bluetooth──▶ cooker                                     (3rd-gen setup only)
```

- **Accounts:** Firebase email/password auth, as the app does. New accounts are registered with Anova like the app registers them.
- **Control:** the same WebSocket and the same JSON commands the Android app sends, such as `CMD_APC_START`, `CMD_APC_STOP` and `CMD_APC_SET_TARGET_TEMP`. The cloud pushes `EVENT_APC_STATE` updates. The connection is opened only while you use the app and closed again after a few idle minutes.
- **Setup:** for 2nd‑gen Wi‑Fi cookers, the server joins the cooker's `Anova <code>` hotspot through NetworkManager. It sends your Wi‑Fi credentials and your account ID, then switches your computer back to your Wi‑Fi. For 3.0‑generation cookers, the browser runs the app's Bluetooth handshake, code confirmation, Wi‑Fi and account-linking steps.

## Development

```bash
cd webapp
npm test             # node:test suite: cooker HTTP quirks, cloud envelope, Bluetooth encoding
npm run start:mock   # fully offline: simulated accounts, cloud, cooker and Bluetooth
```

## How the protocol was worked out

The official Android app (`com.anovaculinary.android`) is React Native. Its logic ships as Hermes bytecode (v96).
The bytecode was decompiled with [hermes-dec](https://github.com/P1sec/hermes-dec) and the Java shell with
[jadx](https://github.com/skylot/jadx). Embedded JSON Schemas were rebuilt by evaluating the code that builds them.
Behaviour was then confirmed against a real AN500. `PROTOCOL.md` cites the module and function for each finding.

The APK and decompiled output are **not** included and must not be committed (see `.gitignore`). To reproduce,
obtain the APK yourself and follow the reproduction notes in `PROTOCOL.md`.

## Security and privacy

- The server stores no passwords. It keeps each browser session's Firebase refresh token in memory only, so restarting it signs everyone out.
- It listens on `127.0.0.1` by default, and the Compose file publishes it on localhost only. Before exposing it, put it behind HTTPS. Anyone who can reach it can sign in with *their own* Anova account.
- Cooker Wi‑Fi setup changes the host's Wi‑Fi connection, so those endpoints only answer requests made directly from the host itself.
- The Firebase API key and Android certificate fingerprint in `webapp/anova-cloud.mjs` are public values shipped inside every copy of the app. They are not secrets.

## License

[MIT](LICENSE) for the code and documentation in this repository. The license does not cover Anova's app,
firmware, trademarks or services.

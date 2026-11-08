// open-avona: self-hosted web controller, compatible with popular Anova sous-vide cookers. No dependencies (Node >= 22).
//
//   MOCK=1 node server.mjs     # offline simulation, never contacts Anova (demo login: demo@example.com / demo1234)
//   node server.mjs            # real Anova accounts: sign in or create one at /login
//
// Optional: PORT (8080), HOST (127.0.0.1), TLS_CERT + TLS_KEY (serve HTTPS; see tools/make-local-https.sh),
// COOKIE_SECURE=1 (when HTTPS is terminated by a reverse proxy).
import http from 'node:http';
import https from 'node:https';
import { appendFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AnovaCloud, AuthError, FirebaseAuth, registerFirebaseTokenWithAnova } from './anova-cloud.mjs';
import { MockAuth, addCooker, createMockSocket } from './mock-cloud.mjs';
import { WifiSwitcher, configureCooker, getDeviceId, scanNetworks } from './gen2-setup.mjs';

const env = process.env;
const PORT = Number(env.PORT ?? 8080);
const HOST = env.HOST ?? '127.0.0.1';
const MOCK = env.MOCK === '1';
const TLS = Boolean(env.TLS_CERT && env.TLS_KEY);
const COOKIE = 'avona_sid';
const SESSION_IDLE_MS = 7 * 24 * 3600_000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// sid -> {email, cloud, sse: Set<res>, lastSeen}. In memory only: a restart signs everyone out.
const sessions = new Map();

function makeAuth(email, password) {
  return MOCK
    ? new MockAuth({ email, password })
    : new FirebaseAuth({ apiKey: env.ANOVA_FIREBASE_API_KEY, email, password });
}

// ANOVA_WS_LOG=<file> appends every raw cloud message (both directions) for debugging.
const trace = env.ANOVA_WS_LOG
  ? (email) => (dir, text) => appendFile(env.ANOVA_WS_LOG, `${new Date().toISOString()} ${email} ${dir} ${text}\n`).catch(() => {})
  : () => undefined;

function startSession(email, auth) {
  const cloud = MOCK
    ? new AnovaCloud({ auth, connectSocket: createMockSocket, trace: trace(email) })
    : new AnovaCloud({ auth, trace: trace(email) });
  const session = { email, auth, cloud, sse: new Set(), lastSeen: Date.now() };
  const broadcast = (event, data) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of session.sse) res.write(chunk);
  };
  cloud.on('status', (s) => broadcast('status', { ...s, mock: MOCK }));
  cloud.on('devices', (list) => broadcast('devices', list));
  cloud.on('state', (p) => broadcast('state', p));
  cloud.connect().catch((e) => console.error(`[anova] connect failed for ${email}: ${e.message}`));
  const sid = randomBytes(32).toString('base64url');
  sessions.set(sid, session);
  return sid;
}

function endSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  s.cloud.close();
  for (const res of s.sse) res.end();
  sessions.delete(sid);
}

setInterval(() => {
  for (const [sid, s] of sessions) if (!s.sse.size && Date.now() - s.lastSeen > SESSION_IDLE_MS) endSession(sid);
}, 3600_000).unref();

function sidOf(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE) return v;
  }
  return null;
}

function setCookie(res, sid, maxAge) {
  const secure = TLS || env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

async function readJson(req) {
  // Requiring a JSON content type keeps plain cross-site form posts out (on top of SameSite=Strict).
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('expected application/json');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function number(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

const unitOf = (u) => (String(u ?? 'C').toUpperCase() === 'F' ? 'F' : 'C');

// A reverse proxy on the same host also connects from loopback, so proxied requests never count as local.
const isLocal = (req) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
  !req.headers['x-forwarded-for'] && !req.headers.forwarded;
let gen2Busy = null; // email of the session currently running Wi-Fi cooker setup

// Node reports a dropped local connection as a bare "fetch failed"; say what it means.
function cookerUnreachable(err) {
  if (/^cooker .*(timed out|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|no HTTP reply)/.test(err?.message ?? '')) {
    throw new Error("Lost contact with the cooker at 10.123.45.1. This computer probably left the cooker's Wi-Fi. Press the button again to retry.");
  }
  throw err;
}

// Wi-Fi (2nd gen, AN500) cooker setup. These switch this computer's Wi-Fi, so they only answer local requests.
const gen2 = {
  async join(session, b) {
    session.gen2 ??= new WifiSwitcher();
    if (b.auto !== false) await session.gen2.joinCookerHotspot(String(b.code ?? ''));
    // The app retries get-device-identity for up to 30 s while the connection settles.
    let lastErr;
    for (let i = 0; i < 30; i++) {
      try {
        return { deviceId: await getDeviceId(), previousWifi: session.gen2.previousName };
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`Connected, but the cooker didn't answer at 10.123.45.1 (${lastErr?.message}).`);
  },
  async scan(session) {
    await session.gen2?.ensureOnHotspot();
    return { networks: await scanNetworks().catch(cookerUnreachable) };
  },
  async configure(session, b) {
    if (!session.auth.uid) throw new Error('Your account ID is unknown. Sign out and sign in again.');
    if (typeof b.ssid !== 'string' || !b.ssid) throw new Error('Choose or type a network name.');
    const password = String(b.password ?? '');
    const securityType = /^\d$/.test(String(b.securityType)) ? String(b.securityType) : password ? '2' : '0';
    await session.gen2?.ensureOnHotspot();
    await configureCooker({ ssid: b.ssid, password, securityType, userId: session.auth.uid }).catch(cookerUnreachable);
    await session.gen2?.restore();
    setTimeout(() => session.cloud.reconnectNow(), 3000);
    return { previousWifi: session.gen2?.previousName ?? null };
  },
  async cancel(session) {
    await session.gen2?.restore();
    setTimeout(() => session.cloud.reconnectNow(), 3000);
    return {};
  },
};

const actions = {
  start: (cloud, id, b) =>
    cloud.startCook(id, {
      targetTemperature: number(b.targetTemperature, 'targetTemperature'),
      unit: unitOf(b.unit),
      timerSeconds: Math.round(number(b.timerMinutes ?? 0, 'timerMinutes') * 60),
    }),
  stop: (cloud, id) => cloud.stopCook(id),
  temperature: (cloud, id, b) =>
    cloud.setTargetTemperature(id, { targetTemperature: number(b.targetTemperature, 'targetTemperature'), unit: unitOf(b.unit) }),
  timer: (cloud, id, b) => cloud.setTimer(id, { timerSeconds: Math.round(number(b.timerMinutes, 'timerMinutes') * 60) }),
  unit: (cloud, id, b) => cloud.setTemperatureUnit(id, { unit: unitOf(b.unit) }),
};

async function login(req, res, { create }) {
  const { email, password } = await readJson(req);
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return send(res, 400, { ok: false, error: 'Email and password are required.' });
  }
  const auth = makeAuth(email.trim(), password);
  try {
    if (create) {
      await auth.signUp();
      // The app registers every new user with Anova right after Firebase sign-up.
      if (!MOCK) {
        await registerFirebaseTokenWithAnova(await auth.getIdToken()).catch((e) => {
          throw new Error(`Account created, but registering it with Anova failed (${e.message}). Try signing in.`);
        });
      }
    } else {
      await auth.signIn();
    }
  } catch (err) {
    return send(res, err instanceof AuthError ? 401 : 502, { ok: false, error: err.message });
  }
  const old = sidOf(req);
  if (old) endSession(old);
  setCookie(res, startSession(email.trim(), auth), SESSION_IDLE_MS / 1000);
  send(res, 200, { ok: true, email: email.trim() });
}

async function page(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(await readFile(path.join(PUBLIC_DIR, file)));
}

// Browser modules for the Bluetooth setup flow (explicit list, no directory serving).
const SCRIPTS = new Set(['/gen3-ble.js', '/mock-bluetooth.js']);

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    // Public routes.
    if (req.method === 'GET' && url.pathname === '/login') return await page(res, 'login.html');
    if (req.method === 'POST' && url.pathname === '/api/login') return await login(req, res, { create: false });
    if (req.method === 'POST' && url.pathname === '/api/signup') return await login(req, res, { create: true });
    if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { mock: MOCK });
    if (req.method === 'GET' && SCRIPTS.has(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(await readFile(path.join(PUBLIC_DIR, url.pathname.slice(1))));
    }

    const sid = sidOf(req);
    const session = sid && sessions.get(sid);
    if (!session) {
      if (req.method === 'GET' && ['/', '/index.html', '/setup', '/setup-wifi'].includes(url.pathname)) {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      return send(res, 401, { ok: false, error: 'not signed in' });
    }
    session.lastSeen = Date.now();
    const { cloud } = session;

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return await page(res, 'index.html');
    if (req.method === 'GET' && url.pathname === '/setup') return await page(res, 'setup.html');
    if (req.method === 'GET' && url.pathname === '/setup-wifi') return await page(res, 'setup-wifi.html');
    if (req.method === 'GET' && url.pathname === '/api/gen2/info') {
      return send(res, 200, { local: isLocal(req), nmcli: await WifiSwitcher.available() });
    }
    const g = url.pathname.match(/^\/api\/gen2\/(join|scan|configure|cancel)$/);
    if (req.method === 'POST' && g) {
      if (!isLocal(req)) return send(res, 403, { ok: false, error: 'Wi-Fi cooker setup only works from the computer running the server.' });
      if (gen2Busy && gen2Busy !== session.email) return send(res, 409, { ok: false, error: 'Another cooker setup is running.' });
      gen2Busy = g[1] === 'configure' || g[1] === 'cancel' ? null : session.email;
      try {
        const result = await gen2[g[1]](session, await readJson(req));
        return send(res, 200, { ok: true, ...result });
      } catch (err) {
        return send(res, 400, { ok: false, error: err.message });
      }
    }
    if (MOCK && req.method === 'POST' && url.pathname === '/api/mock/cooker-online') {
      const { cookerId, type, name } = await readJson(req);
      if (!/^[\w.-]{1,64}$/.test(String(cookerId)) || !/^a[6-9]$/.test(String(type))) throw new Error('bad mock cooker');
      addCooker(session.email, { cookerId, type, name: String(name ?? '').slice(0, 60) });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      endSession(sid);
      setCookie(res, '', 0);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      return send(res, 200, { email: session.email, uid: session.auth.uid ?? null, mock: MOCK });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, { connected: cloud.connected, mock: MOCK, devices: cloud.deviceList() });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify({ connected: cloud.connected, mock: MOCK })}\n\n`);
      res.write(`event: devices\ndata: ${JSON.stringify(cloud.deviceList())}\n\n`);
      session.sse.add(res);
      req.on('close', () => session.sse.delete(res));
      return;
    }
    const m = url.pathname.match(/^\/api\/devices\/([\w.-]+)\/(\w+)$/);
    if (req.method === 'POST' && m && Object.hasOwn(actions, m[2])) {
      const result = await actions[m[2]](cloud, m[1], await readJson(req));
      return send(res, 200, { ok: true, result });
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 400, { ok: false, error: err.message });
  }
};

// HTTPS makes the page a secure context on other devices (phones), which Web Bluetooth requires.
const server = TLS
  ? https.createServer({ cert: await readFile(env.TLS_CERT), key: await readFile(env.TLS_KEY) }, handler)
  : http.createServer(handler);

server.listen(PORT, HOST, () => {
  const scheme = TLS ? 'https' : 'http';
  console.log(`open-avona on ${scheme}://${HOST}:${PORT}${MOCK ? ' (MOCK mode, offline)' : ''}`);
});

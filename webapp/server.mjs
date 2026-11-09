// open-avona: self-hosted web controller, compatible with popular Anova sous-vide cookers. No dependencies (Node >= 22).
//
//   MOCK=1 node server.mjs     # offline simulation, never contacts Anova (demo login: demo@example.com / demo1234)
//   node server.mjs            # real Anova accounts: sign in or create one at /login
//
// Optional: PORT (8080), HOST (127.0.0.1), TLS_CERT + TLS_KEY (serve HTTPS; see tools/make-local-https.sh),
// COOKIE_SECURE=1 (when HTTPS is terminated by a reverse proxy), CLOUD_IDLE_MINUTES (5; see below).
import http from 'node:http';
import https from 'node:https';
import { appendFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AnovaCloud, AuthError, FirebaseAuth, registerFirebaseTokenWithAnova } from './anova-cloud.mjs';
import { MockAuth, addCooker, createMockSocket } from './mock-cloud.mjs';
import { WifiSwitcher, configureCooker, getDeviceId, scanNetworks } from './gen2-setup.mjs';
import { SessionStore } from './session-store.mjs';
import { createLogger } from './log.mjs';

const env = process.env;
const PORT = Number(env.PORT ?? 8080);
const HOST = env.HOST ?? '127.0.0.1';
const MOCK = env.MOCK === '1';
const TLS = Boolean(env.TLS_CERT && env.TLS_KEY);
const COOKIE = 'avona_sid';
const SESSION_IDLE_MS = 30 * 24 * 3600_000;
const CLOUD_IDLE_MS = Number(env.CLOUD_IDLE_MINUTES ?? 5) * 60_000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const log = createLogger('server');
const sessionStore = new SessionStore(env.SESSION_FILE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'sessions.json'));

// sid -> {email, auth, cloud, log, sse: Set<res>, lastSeen}.
const sessions = new Map();

function savedSessions() {
  return [...sessions].map(([sid, s]) => ({
    sid, email: s.email, uid: s.auth.uid, refreshToken: s.auth.refreshToken, lastSeen: s.lastSeen, mock: MOCK,
  }));
}

const persistSessions = () => sessionStore.save(savedSessions());
const persistInBackground = () => { void persistSessions().catch((e) => log.error(`saving sessions failed: ${e.message}`)); };

function makeAuth(email, password) {
  return MOCK
    ? new MockAuth({ email, password })
    : new FirebaseAuth({ apiKey: env.ANOVA_FIREBASE_API_KEY, email, password });
}

// ANOVA_WS_LOG=<file> appends every raw cloud message (both directions) for debugging.
const trace = env.ANOVA_WS_LOG
  ? (email) => (dir, text) => appendFile(env.ANOVA_WS_LOG, `${new Date().toISOString()} ${email} ${dir} ${text}\n`).catch(() => {})
  : () => undefined;

function startSession(email, auth, { sid = randomBytes(32).toString('base64url'), lastSeen = Date.now() } = {}) {
  const userLog = createLogger(email);
  const cloud = MOCK
    ? new AnovaCloud({ auth, connectSocket: createMockSocket, log: userLog, trace: trace(email) })
    : new AnovaCloud({ auth, log: userLog, trace: trace(email) });
  const session = { email, auth, cloud, log: userLog, sse: new Set(), lastSeen };
  const broadcast = (event, data) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of session.sse) res.write(chunk);
  };
  cloud.on('status', (s) => broadcast('status', { ...s, mock: MOCK }));
  cloud.on('devices', (list) => broadcast('devices', list));
  cloud.on('state', (p) => broadcast('state', p));
  sessions.set(sid, session);
  auth.onTokenUpdate = persistInBackground;
  return sid;
}

function connectSession(sid) {
  const s = sessions.get(sid);
  s.cloud.connect().catch((e) => {
    s.log.error(`cloud connect failed: ${e.message}`);
    if (e instanceof AuthError) {
      endSession(sid, 'the account rejected the saved sign-in');
      persistInBackground();
    }
  });
}

function endSession(sid, reason) {
  const s = sessions.get(sid);
  if (!s) return;
  s.log.info(`session ended: ${reason}`);
  s.cloud.close(reason);
  for (const res of s.sse) res.end();
  sessions.delete(sid);
}

setInterval(() => {
  let removed = false;
  for (const [sid, s] of sessions) if (Date.now() - s.lastSeen > SESSION_IDLE_MS) { endSession(sid, 'expired, unused for 30 days'); removed = true; }
  if (removed) persistInBackground();
}, 3600_000).unref();

// Cookers are off most of the time, so a session only holds a cloud connection while it is being used: the socket
// opens on demand (wakeCloud) and closes after CLOUD_IDLE_MS with no requests and no open event stream.
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.cloud.stopped && !s.sse.size && Date.now() - s.lastSeen > CLOUD_IDLE_MS) {
      s.cloud.sleep(`idle, no page open for ${CLOUD_IDLE_MS / 60_000} min`);
    }
  }
}, 15_000).unref();

function wakeCloud(session) {
  session.lastSeen = Date.now();
  return session.cloud.wake();
}

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
    if (b.auto !== false) {
      session.log.info(`Wi-Fi cooker setup: joining the cooker hotspot "Anova ${String(b.code ?? '')}"`);
      await session.gen2.joinCookerHotspot(String(b.code ?? ''));
    } else {
      session.log.info('Wi-Fi cooker setup: looking for a cooker on the current network');
    }
    // The app retries get-device-identity for up to 30 s while the connection settles.
    let lastErr;
    for (let i = 0; i < 30; i++) {
      try {
        const deviceId = await getDeviceId();
        session.log.info(`Wi-Fi cooker setup: found cooker ${deviceId}`);
        return { deviceId, previousWifi: session.gen2.previousName };
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
    session.log.info(`Wi-Fi cooker setup: sending network "${b.ssid}" and pairing the cooker to account ${session.auth.uid}`);
    await configureCooker({ ssid: b.ssid, password, securityType, userId: session.auth.uid }).catch(cookerUnreachable);
    session.log.info('Wi-Fi cooker setup: cooker configured, waiting for it to come online');
    await session.gen2?.restore();
    setTimeout(() => session.cloud.reconnectNow(), 3000);
    return { previousWifi: session.gen2?.previousName ?? null };
  },
  async cancel(session) {
    session.log.info('Wi-Fi cooker setup: cancelled');
    await session.gen2?.restore();
    setTimeout(() => session.cloud.reconnectNow(), 3000);
    return {};
  },
};

// What each command did, for the log, e.g. "set temperature 56.5 °C".
const temp = (b) => `${b.targetTemperature} °${unitOf(b.unit)}`;
const minutes = (m) => `${Number(m ?? 0)} min`;
const describeAction = {
  start: (b) => `start cooking at ${temp(b)}${Number(b.timerMinutes) ? `, timer ${minutes(b.timerMinutes)}` : ''}`,
  stop: () => 'stop cooking',
  temperature: (b) => `set temperature ${temp(b)}`,
  timer: (b) => `set timer ${minutes(b.timerMinutes)}`,
  unit: (b) => `set unit °${unitOf(b.unit)}`,
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
  const userLog = createLogger(email.trim());
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
    userLog.warn(`${create ? 'sign-up' : 'sign-in'} failed: ${err.message}`);
    return send(res, err instanceof AuthError ? 401 : 502, { ok: false, error: err.message });
  }
  userLog.info(create ? `account created and signed in (uid ${auth.uid})` : `signed in (uid ${auth.uid})`);
  const old = sidOf(req);
  if (old) endSession(old, 'replaced by a new sign-in');
  const sid = startSession(email.trim(), auth);
  try {
    await persistSessions();
  } catch (err) {
    endSession(sid, 'could not be saved');
    persistInBackground();
    return send(res, 500, { ok: false, error: `Could not save your session (${err.message}).` });
  }
  connectSession(sid);
  setCookie(res, sid, SESSION_IDLE_MS / 1000);
  send(res, 200, { ok: true, email: email.trim() });
}

async function page(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(await readFile(path.join(PUBLIC_DIR, file)));
}

// Static files: the shared stylesheet and icon, and the Bluetooth setup modules (explicit list, no directory serving).
const ASSETS = {
  '/app.css': 'text/css; charset=utf-8',
  '/icon.svg': 'image/svg+xml',
  '/cooker-state.mjs': 'text/javascript; charset=utf-8',
  '/gen3-ble.js': 'text/javascript; charset=utf-8',
  '/mock-bluetooth.js': 'text/javascript; charset=utf-8',
};

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    // Public routes.
    if (req.method === 'GET' && url.pathname === '/login') {
      const existing = sessions.get(sidOf(req));
      if (existing && Date.now() - existing.lastSeen < SESSION_IDLE_MS) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      return await page(res, 'login.html');
    }
    if (req.method === 'POST' && url.pathname === '/api/login') return await login(req, res, { create: false });
    if (req.method === 'POST' && url.pathname === '/api/signup') return await login(req, res, { create: true });
    if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { mock: MOCK });
    if (req.method === 'GET' && Object.hasOwn(ASSETS, url.pathname)) {
      res.writeHead(200, { 'Content-Type': ASSETS[url.pathname] });
      return res.end(await readFile(path.join(PUBLIC_DIR, url.pathname.slice(1))));
    }

    const sid = sidOf(req);
    let session = sid && sessions.get(sid);
    if (session && Date.now() - session.lastSeen >= SESSION_IDLE_MS) {
      endSession(sid, 'expired, unused for 30 days');
      await persistSessions();
      session = null;
    }
    if (!session) {
      if (req.method === 'GET' && ['/', '/index.html', '/setup', '/setup-wifi'].includes(url.pathname)) {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      return send(res, 401, { ok: false, error: 'not signed in' });
    }
    session.lastSeen = Date.now();
    setCookie(res, sid, SESSION_IDLE_MS / 1000);
    persistInBackground();
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
        session.log.warn(`Wi-Fi cooker setup (${g[1]}) failed: ${err.message}`);
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
      endSession(sid, 'signed out');
      await persistSessions();
      setCookie(res, '', 0);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      return send(res, 200, { email: session.email, uid: session.auth.uid ?? null, mock: MOCK });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const error = await wakeCloud(session).then(() => undefined, (e) => e.message);
      return send(res, 200, { connected: cloud.connected, mock: MOCK, error, devices: cloud.deviceList() });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify({ connected: cloud.connected, connecting: !cloud.connected, mock: MOCK })}\n\n`);
      // Until the cloud has sent the cooker list, the cached one may be incomplete; the list follows when it arrives.
      if (cloud.listed) res.write(`event: devices\ndata: ${JSON.stringify(cloud.deviceList())}\n\n`);
      session.sse.add(res);
      req.on('close', () => {
        session.sse.delete(res);
        session.lastSeen = Date.now(); // the idle countdown starts when the last page stops listening
      });
      wakeCloud(session).catch((e) => {
        session.log.error(`cloud connect failed: ${e.message}`);
        if (session.sse.has(res)) res.write(`event: status\ndata: ${JSON.stringify({ connected: false, error: e.message, mock: MOCK })}\n\n`);
      });
      return;
    }
    const m = url.pathname.match(/^\/api\/devices\/([\w.-]+)\/(\w+)$/);
    if (req.method === 'POST' && m && Object.hasOwn(actions, m[2])) {
      const body = await readJson(req);
      const what = `cooker ${m[1]}: ${describeAction[m[2]](body)}`;
      try {
        await wakeCloud(session);
        const result = await actions[m[2]](cloud, m[1], body);
        session.log.info(`${what}: ok`);
        return send(res, 200, { ok: true, result });
      } catch (err) {
        session.log.warn(`${what}: failed (${err.message})`);
        throw err;
      }
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

let restored = 0;
for (const record of await sessionStore.load()) {
  if (!record || !/^[A-Za-z0-9_-]{43}$/.test(record.sid) || typeof record.email !== 'string' ||
      typeof record.lastSeen !== 'number' || Date.now() - record.lastSeen >= SESSION_IDLE_MS ||
      record.mock !== MOCK || (!MOCK && (typeof record.refreshToken !== 'string' || !record.refreshToken))) continue;
  const auth = MOCK
    ? new MockAuth({ email: record.email })
    : new FirebaseAuth({ apiKey: env.ANOVA_FIREBASE_API_KEY, email: record.email, refreshToken: record.refreshToken });
  auth.uid = record.uid;
  startSession(record.email, auth, { sid: record.sid, lastSeen: record.lastSeen });
  restored++;
}
if (restored) log.info(`restored ${restored} saved session${restored === 1 ? '' : 's'}: ${[...new Set([...sessions.values()].map((s) => s.email))].join(', ')}`);
await persistSessions();
server.listen(PORT, HOST, () => {
  const scheme = TLS ? 'https' : 'http';
  log.info(`open-avona on ${scheme}://${HOST}:${PORT}${MOCK ? ' (MOCK mode, offline)' : ''}`);
});

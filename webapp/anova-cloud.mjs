// Client for the Anova cloud, reimplemented from the Android app (see ../../PROTOCOL.md §2, §4).
// Auth: Firebase ID token. Transport: wss://devices.anovaculinary.io with {command, requestId, payload} JSON.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// Public Firebase client config embedded in the APK (resources.arsc), not a secret.
export const FIREBASE_API_KEY = 'AIzaSyCGJwHXUhkNBdPkH3OAkjc9-3xMMjvanfU';
export const DEVICES_WS_URL = 'wss://devices.anovaculinary.io';
// Firebase API keys can be restricted to an Android app; Google then requires the app's package name and
// signing-certificate SHA-1 on each REST call. Values from the APK (package name, v2/v3 signing block).
const ANDROID_APP_HEADERS = {
  'X-Android-Package': 'com.anovaculinary.android',
  'X-Android-Cert': '826E0D4C041DF7BDE2F94446226FDA57160472A9',
};
const COMMAND_TIMEOUT_MS = 10_000; // COMMAND_TIMEOUT_SECONDS = 10 in the app
const RECONNECT_DELAY_MS = 5_000; // APCWebsocket.reconnect sleeps 5 s

// Firebase error codes -> text a user can act on.
const AUTH_MESSAGES = {
  EMAIL_EXISTS: 'An account with this email already exists.',
  EMAIL_NOT_FOUND: 'Wrong email or password.',
  INVALID_PASSWORD: 'Wrong email or password.',
  INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
  INVALID_EMAIL: 'That email address is not valid.',
  USER_DISABLED: 'This account has been disabled.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again later.',
  OPERATION_NOT_ALLOWED: 'Email/password sign-in is not enabled for this account type.',
};

export class AuthError extends Error {
  constructor(code) {
    const key = String(code).split(' ')[0].split(':')[0];
    const friendly = key.startsWith('WEAK_PASSWORD') ? 'Password is too weak (at least 6 characters).' : AUTH_MESSAGES[key];
    super(friendly ?? `Sign-in failed (${code}).`);
    this.code = key;
  }
}

// After sign-up the app registers the new Firebase user with Anova (registerFirebaseTokenWithAnova).
export async function registerFirebaseTokenWithAnova(idToken, fetchImpl = fetch) {
  const res = await fetchImpl('https://anovaculinary.io/authenticate', {
    method: 'POST',
    headers: { 'Firebase-Token': idToken },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Anova /authenticate returned HTTP ${res.status}`);
}

// Firebase Auth over its public REST API. Mirrors what the Firebase SDK does inside the app.
export class FirebaseAuth {
  constructor({ apiKey = FIREBASE_API_KEY, email, password, refreshToken, fetchImpl = fetch } = {}) {
    Object.assign(this, { apiKey, email, password, refreshToken, fetch: fetchImpl });
    this.idToken = null;
    this.expiresAt = 0;
  }

  signIn() {
    return this.#passwordCall('accounts:signInWithPassword');
  }

  // Equivalent of createUserWithEmailAndPassword in the app's submitCredentials (AuthTypes.Register).
  signUp() {
    return this.#passwordCall('accounts:signUp');
  }

  async #passwordCall(method) {
    const res = await this.fetch(`https://identitytoolkit.googleapis.com/v1/${method}?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ANDROID_APP_HEADERS },
      body: JSON.stringify({ email: this.email, password: this.password, returnSecureToken: true }),
    });
    const body = await res.json();
    if (!res.ok) throw new AuthError(body?.error?.message ?? `HTTP ${res.status}`);
    this.#store(body.idToken, body.refreshToken, body.expiresIn);
    this.uid = body.localId; // Firebase uid; the cooker is linked to it during setup (PAIRING)
    this.password = null; // the refresh token is enough from here on
  }

  async refresh() {
    const res = await this.fetch(`https://securetoken.googleapis.com/v1/token?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...ANDROID_APP_HEADERS },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
    });
    const body = await res.json();
    if (!res.ok) throw new AuthError(body?.error?.message ?? `HTTP ${res.status}`);
    this.#store(body.id_token, body.refresh_token, body.expires_in);
    this.uid = body.user_id ?? this.uid;
  }

  // Like currentUser.getIdToken(): cached token, refreshed when under 5 minutes remain.
  async getIdToken() {
    if (this.idToken && Date.now() < this.expiresAt - 5 * 60_000) return this.idToken;
    if (this.refreshToken) await this.refresh();
    else await this.signIn();
    return this.idToken;
  }

  #store(idToken, refreshToken, expiresIn) {
    this.idToken = idToken;
    this.refreshToken = refreshToken;
    this.expiresAt = Date.now() + Number(expiresIn) * 1000;
  }
}

// Events emitted: 'status' ({connected}), 'devices' (list), 'state' ({cookerId, type, state}), 'message' (raw).
// The socket is opened on demand with wake() and closed with sleep(); while awake it reconnects on its own.
export class AnovaCloud extends EventEmitter {
  // trace(direction, text) receives every raw message in and out, for debugging.
  constructor({ auth, url = DEVICES_WS_URL, platform = 'android', connectSocket = (u) => new WebSocket(u), log = console, trace } = {}) {
    super();
    Object.assign(this, { auth, url, platform, connectSocket, log, trace });
    this.ws = null;
    this.pending = new Map(); // requestId -> {resolve, reject, timer}
    this.devices = new Map(); // cookerId -> {cookerId, type, name, state, updatedAt}
    this.stopped = true; // not connected and not reconnecting
    this.listed = false; // the cooker list has arrived on the current socket
    this.opening = null; // connect() still fetching a token
    this.retryTimer = null;
  }

  get connected() {
    return this.ws?.readyState === 1;
  }

  async connect() {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    const token = await this.auth.getIdToken();
    if (this.stopped) return; // sleep() was called while the token was being fetched
    if (this.ws && this.ws.readyState <= 1) {
      // Replace a still-open socket without triggering its reconnect handler.
      this.ws.onclose = null;
      this.ws.close();
    }
    this.listed = false;
    const url = `${this.url}?token=${encodeURIComponent(token)}&supportedAccessories=APC&platform=${this.platform}`;
    const ws = this.connectSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.log.info?.('[anova] websocket connected');
      this.emit('status', { connected: true });
    };
    ws.onmessage = (ev) => {
      this.trace?.('in', typeof ev.data === 'string' ? ev.data : `<${typeof ev.data}>`);
      if (typeof ev.data !== 'string') return this.log.warn?.("[anova] message wasn't a string");
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return this.log.warn?.('[anova] non-JSON message');
      }
      this.#processMessage(msg);
    };
    ws.onclose = (ev) => {
      this.log.info?.(`[anova] websocket closed code=${ev?.code} reason=${ev?.reason ?? ''}`);
      this.listed = false;
      this.emit('status', { connected: false });
      this.#failPending(new Error('Websocket connection is closed.'));
      if (!this.stopped) this.retryTimer = setTimeout(() => this.connect().catch((e) => this.#retryAfter(e)), RECONNECT_DELAY_MS);
    };
    ws.onerror = (ev) => this.log.warn?.(`[anova] websocket error ${ev?.message ?? ''}`);
  }

  // Connects unless already connected or connecting. Resolves once the cooker list has arrived, so commands
  // know each cooker's type; rejects if the cloud can't be reached within timeoutMs.
  async wake(timeoutMs = COMMAND_TIMEOUT_MS) {
    if (this.stopped || !this.ws || this.ws.readyState > 1) {
      this.opening ??= this.connect().finally(() => (this.opening = null));
    }
    await this.opening;
    if (this.connected && this.listed) return;
    await new Promise((resolve, reject) => {
      const check = () => this.connected && this.listed && finish();
      const finish = (err) => {
        clearTimeout(timer);
        this.off('devices', check);
        if (err) reject(err);
        else resolve();
      };
      // An open socket whose list is late still gets to try the command.
      const timer = setTimeout(() => finish(this.connected ? null : new Error("Couldn't reach the Anova cloud. Try again in a moment.")), timeoutMs);
      this.on('devices', check);
      check();
    });
  }

  // Disconnects until the next wake(). Cooker states go stale meanwhile, so they are dropped; names and types stay.
  sleep() {
    this.close();
    for (const d of this.devices.values()) {
      delete d.state;
      delete d.updatedAt;
    }
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  // After this computer changed networks, the old socket may hang silently; start a fresh one.
  reconnectNow() {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState <= 1) this.ws.close(); // onclose schedules the reconnect
    else this.connect().catch((e) => this.log.error?.(`[anova] reconnect failed: ${e.message}`));
  }

  #retryAfter(err) {
    this.log.error?.(`[anova] reconnect failed: ${err.message}`);
    if (!this.stopped) this.retryTimer = setTimeout(() => this.connect().catch((e) => this.#retryAfter(e)), RECONNECT_DELAY_MS * 6);
  }

  // Same dispatch as APCWebsocket.processMessage: known events -> state, anything else -> command response.
  #processMessage(msg) {
    this.emit('message', msg);
    const { command, payload } = msg ?? {};
    switch (command) {
      case 'EVENT_APC_WIFI_LIST': {
        const list = Array.isArray(payload) ? payload : (payload?.cookers ?? payload?.devices ?? []);
        for (const d of list) this.#upsert(d.cookerId, { type: d.type, name: d.name });
        this.listed = true;
        this.emit('devices', this.deviceList());
        break;
      }
      case 'EVENT_APC_WIFI_ADDED':
        this.#upsert(payload?.cookerId, { type: payload?.type, name: payload?.name });
        this.emit('devices', this.deviceList());
        break;
      case 'EVENT_APC_WIFI_REMOVED':
        this.devices.delete(payload?.cookerId);
        this.emit('devices', this.deviceList());
        break;
      case 'EVENT_APC_STATE':
        this.#upsert(payload?.cookerId, { type: payload?.type, state: payload?.state, updatedAt: new Date().toISOString() });
        this.emit('state', payload);
        break;
      case 'EVENT_APC_WIFI_VERSION':
      case 'EVENT_USER_STATE':
        break;
      default:
        this.#processResponse(msg);
    }
  }

  #upsert(cookerId, fields) {
    if (!cookerId) return;
    const cur = this.devices.get(cookerId) ?? { cookerId };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) cur[k] = v;
    this.devices.set(cookerId, cur);
  }

  deviceList() {
    return [...this.devices.values()];
  }

  #processResponse(msg) {
    const p = this.pending.get(msg?.requestId);
    if (!p) return;
    this.pending.delete(msg.requestId);
    clearTimeout(p.timer);
    if (msg.payload?.status === 'ok') p.resolve(msg.payload);
    else p.reject(new Error(msg.payload?.error ?? `command failed: ${JSON.stringify(msg.payload)}`));
  }

  #failPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // CommandProcessor.sendCommand: outer requestId is matched; payload gets its own fresh requestId.
  sendCommand(command, payload) {
    if (!this.connected) return Promise.reject(new Error('Websocket connection is closed.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`timeout error after ${COMMAND_TIMEOUT_MS / 1000} seconds`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      const text = JSON.stringify({ command, requestId, payload: { ...payload, requestId: randomUUID() } });
      this.trace?.('out', text);
      this.ws.send(text);
    });
  }

  #typeOf(cookerId) {
    const d = this.devices.get(cookerId);
    if (!d?.type) throw new Error(`unknown cooker ${cookerId}`);
    return d.type;
  }

  // Payload shapes follow APCWebsocket.startCooker etc. timer is in seconds (app sends minutes * 60).
  startCook(cookerId, { targetTemperature, unit = 'C', timerSeconds = 0, cookable }) {
    const payload = { cookerId, type: this.#typeOf(cookerId), targetTemperature, unit, timer: timerSeconds };
    if (cookable) payload.cookable = cookable;
    return this.sendCommand('CMD_APC_START', payload);
  }

  stopCook(cookerId) {
    return this.sendCommand('CMD_APC_STOP', { cookerId, type: this.#typeOf(cookerId) });
  }

  setTargetTemperature(cookerId, { targetTemperature, unit = 'C' }) {
    return this.sendCommand('CMD_APC_SET_TARGET_TEMP', { cookerId, type: this.#typeOf(cookerId), targetTemperature, unit });
  }

  setTimer(cookerId, { timerSeconds }) {
    return this.sendCommand('CMD_APC_SET_TIMER', { cookerId, type: this.#typeOf(cookerId), timer: timerSeconds });
  }

  setTemperatureUnit(cookerId, { unit }) {
    return this.sendCommand('CMD_APC_SET_TEMPERATURE_UNIT', { cookerId, type: this.#typeOf(cookerId), unit });
  }
}

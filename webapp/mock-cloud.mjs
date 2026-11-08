// Offline stand-in for Firebase Auth and wss://devices.anovaculinary.io. Speaks the same JSON envelope so the
// real AnovaCloud code paths (requestId matching, event dispatch) are exercised without touching Anova.
import { createHash } from 'node:crypto';
import { AuthError } from './anova-cloud.mjs';

// email -> {password, uid, cookers: Map<cookerId, cooker>, sockets: Set}
const accounts = new Map();

function account(email) {
  return accounts.get(email);
}

function createAccount(email, password) {
  const uid = createHash('sha256').update(email).digest('hex').slice(0, 28);
  const acct = { password, uid, cookers: new Map(), sockets: new Set() };
  accounts.set(email, acct);
  return acct;
}

// Demo account that already owns one cooker.
createAccount('demo@example.com', 'demo1234');
addCooker('demo@example.com', { cookerId: 'mock-a7-0001', type: 'a7', name: 'Mock Precision Cooker 3.0' });

export class MockAuth {
  constructor({ email, password } = {}) {
    Object.assign(this, { email, password });
  }

  async signIn() {
    if (account(this.email)?.password !== this.password) throw new AuthError('INVALID_LOGIN_CREDENTIALS');
    this.uid = account(this.email).uid;
  }

  async signUp() {
    if (!/^[^@\s]+@[^@\s]+$/.test(this.email ?? '')) throw new AuthError('INVALID_EMAIL');
    if (accounts.has(this.email)) throw new AuthError('EMAIL_EXISTS');
    if (String(this.password ?? '').length < 6) throw new AuthError('WEAK_PASSWORD');
    this.uid = createAccount(this.email, this.password).uid;
  }

  async getIdToken() {
    return `mock-token:${this.email}`;
  }
}

// What a real cooker does after Bluetooth setup: it comes online and the cloud reports it to the owner's sockets.
// In mock mode the simulated Bluetooth cooker triggers this through /api/mock/cooker-online.
export function addCooker(email, { cookerId, type, name }) {
  const acct = account(email);
  if (!acct || acct.cookers.has(cookerId)) return;
  acct.cookers.set(cookerId, {
    cookerId,
    type,
    name,
    mode: 'idle',
    unit: 'C',
    current: 21.5,
    setpoint: 56.5,
    timerInitial: 0,
    timerStartedAt: null,
  });
  for (const sock of acct.sockets) sock.announce(cookerId);
}

export function createMockSocket(url) {
  const email = decodeURIComponent(new URL(url).searchParams.get('token') ?? '').replace(/^mock-token:/, '');
  const acct = account(email);
  const sock = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(raw) {
      const msg = JSON.parse(raw);
      const p = msg.payload ?? {};
      const cooker = acct?.cookers.get(p.cookerId);
      let error = cooker ? null : `unknown cooker ${p.cookerId}`;
      if (cooker) {
        switch (msg.command) {
          case 'CMD_APC_START':
            cooker.mode = 'cook';
            cooker.setpoint = toC(p.targetTemperature, p.unit);
            cooker.timerInitial = p.timer ?? 0;
            cooker.timerStartedAt = p.timer ? new Date().toISOString() : null;
            break;
          case 'CMD_APC_STOP':
            cooker.mode = 'idle';
            cooker.timerStartedAt = null;
            break;
          case 'CMD_APC_SET_TARGET_TEMP':
            cooker.setpoint = toC(p.targetTemperature, p.unit);
            break;
          case 'CMD_APC_SET_TIMER':
            cooker.timerInitial = p.timer;
            cooker.timerStartedAt = cooker.mode === 'cook' ? new Date().toISOString() : null;
            break;
          case 'CMD_APC_SET_TEMPERATURE_UNIT':
            cooker.unit = p.unit;
            break;
          default:
            error = `unsupported ${msg.command}`;
        }
      }
      setTimeout(() => {
        deliver({ command: 'RESPONSE', requestId: msg.requestId, payload: error ? { status: 'error', error } : { status: 'ok' } });
        if (cooker) pushState(cooker);
      }, 150);
    },
    announce(cookerId) {
      const c = acct.cookers.get(cookerId);
      deliver({ command: 'EVENT_APC_WIFI_ADDED', payload: { cookerId, type: c.type, name: c.name } });
      pushState(c);
    },
    close() {
      clearInterval(tick);
      acct?.sockets.delete(sock);
      sock.readyState = 3;
      sock.onclose?.({ code: 1000, reason: 'closed by client' });
    },
  };

  function deliver(obj) {
    sock.onmessage?.({ data: JSON.stringify(obj) });
  }

  // State shape follows schemas/SousVideState.schema.json.
  function pushState(c) {
    deliver({
      command: 'EVENT_APC_STATE',
      payload: {
        cookerId: c.cookerId,
        type: c.type,
        state: {
          version: 1,
          updatedTimestamp: new Date().toISOString(),
          state: { mode: c.mode, temperatureUnit: c.unit, processedCommandIds: [] },
          nodes: {
            waterTemperatureSensor: {
              enabled: true,
              current: { celsius: Math.round(c.current * 10) / 10 },
              setpoint: { celsius: c.setpoint },
            },
            timer: {
              initial: c.timerInitial,
              mode: c.timerStartedAt ? 'running' : 'idle',
              startedAtTimestamp: c.timerStartedAt,
            },
            lowWater: { empty: false, warning: false },
          },
          systemInfo: { deviceId: c.cookerId, online: true, firmwareVersion: 'mock-1.0.0' },
        },
      },
    });
  }

  const tick = setInterval(() => {
    for (const c of acct?.cookers.values() ?? []) {
      const target = c.mode === 'cook' ? c.setpoint : 21.5;
      c.current += Math.sign(target - c.current) * Math.min(Math.abs(target - c.current), 0.8);
      pushState(c);
    }
  }, 2000);

  setTimeout(() => {
    if (!acct) {
      sock.readyState = 3;
      return sock.onclose?.({ code: 4001, reason: 'invalid token' });
    }
    acct.sockets.add(sock);
    sock.readyState = 1;
    sock.onopen?.();
    const list = [...acct.cookers.values()].map(({ cookerId, type, name }) => ({ cookerId, type, name }));
    deliver({ command: 'EVENT_APC_WIFI_LIST', payload: list });
    for (const c of acct.cookers.values()) pushState(c);
  }, 50);
  return sock;
}

function toC(value, unit) {
  return String(unit).toUpperCase() === 'F' ? Math.round(((value - 32) / 1.8) * 10) / 10 : value;
}

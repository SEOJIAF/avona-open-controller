// AnovaCloud against an in-memory socket that replays message shapes seen from the real cloud (IDs replaced).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnovaCloud, AuthError } from '../anova-cloud.mjs';

function fakeSocket({ answer = (msg) => ({ status: 'ok' }) } = {}) {
  const sock = { readyState: 0, sent: [] };
  sock.send = (text) => {
    const msg = JSON.parse(text);
    sock.sent.push(msg);
    const payload = answer(msg);
    if (payload) setTimeout(() => sock.onmessage({ data: JSON.stringify({ command: 'RESPONSE', requestId: msg.requestId, payload }) }), 5);
  };
  sock.close = () => {
    sock.readyState = 3;
    sock.onclose?.({ code: 1000 });
  };
  setTimeout(() => {
    sock.readyState = 1;
    sock.onopen?.();
    sock.onmessage({ data: JSON.stringify({
      command: 'EVENT_APC_WIFI_LIST',
      payload: [{ cookerId: 'cooker-1', type: 'a5', pairedAt: '2026-11-08T13:11:52Z', name: 'Anova Precision Cooker' }],
    }) });
  }, 5);
  return sock;
}

async function connected(opts) {
  let sock;
  const cloud = new AnovaCloud({
    auth: { getIdToken: async () => 'id-token' },
    connectSocket: (url) => {
      sock = fakeSocket(opts);
      sock.url = url;
      return sock;
    },
    log: {},
  });
  const devices = new Promise((r) => cloud.once('devices', r));
  await cloud.connect();
  await devices;
  return { cloud, sock: () => sock };
}

test('connects with the token in the URL and lists cookers', async () => {
  const { cloud, sock } = await connected();
  assert.equal(sock().url, 'wss://devices.anovaculinary.io?token=id-token&supportedAccessories=APC&platform=android');
  assert.deepEqual(cloud.deviceList().map((d) => [d.cookerId, d.type]), [['cooker-1', 'a5']]);
  cloud.close();
});

test('sends CMD_APC_START in the app envelope and resolves on RESPONSE ok', async () => {
  const { cloud, sock } = await connected();
  const result = await cloud.startCook('cooker-1', { targetTemperature: 56.5, unit: 'C', timerSeconds: 3600 });
  assert.deepEqual(result, { status: 'ok' });
  const sent = sock().sent[0];
  assert.equal(sent.command, 'CMD_APC_START');
  assert.ok(sent.requestId && sent.payload.requestId && sent.requestId !== sent.payload.requestId);
  assert.deepEqual({ ...sent.payload, requestId: undefined }, {
    cookerId: 'cooker-1', type: 'a5', targetTemperature: 56.5, unit: 'C', timer: 3600, requestId: undefined,
  });
  cloud.close();
});

test('rejects when the cloud answers with an error', async () => {
  const { cloud } = await connected({ answer: () => ({ status: 'error', error: 'device offline' }) });
  await assert.rejects(cloud.stopCook('cooker-1'), /device offline/);
  cloud.close();
});

test('refuses commands for unknown cookers', async () => {
  const { cloud } = await connected();
  assert.throws(() => cloud.stopCook('nope'), /unknown cooker/);
  cloud.close();
});

function idleCloud() {
  const sockets = [];
  const cloud = new AnovaCloud({
    auth: { getIdToken: async () => 'id-token' },
    connectSocket: () => {
      sockets.push(fakeSocket());
      return sockets.at(-1);
    },
    log: {},
  });
  return { cloud, sockets };
}

test('stays disconnected until woken, and concurrent wakes share one socket', async () => {
  const { cloud, sockets } = idleCloud();
  assert.equal(sockets.length, 0);
  await Promise.all([cloud.wake(), cloud.wake(), cloud.wake()]);
  assert.equal(sockets.length, 1);
  assert.ok(cloud.connected && cloud.listed);
  await cloud.wake();
  assert.equal(sockets.length, 1);
  cloud.close();
});

test('sleep disconnects for good and forgets stale states until the next wake', async (t) => {
  const { cloud, sockets } = idleCloud();
  await cloud.wake();
  sockets[0].onmessage({ data: JSON.stringify({ command: 'EVENT_APC_STATE', payload: { cookerId: 'cooker-1', type: 'a5', state: { job: {} } } }) });
  assert.ok(cloud.deviceList()[0].state);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  cloud.sleep();
  t.mock.timers.tick(10 * 60_000); // well past any reconnect delay
  await new Promise(setImmediate);
  assert.equal(sockets.length, 1);
  assert.equal(cloud.connected, false);
  assert.deepEqual(cloud.deviceList(), [{ cookerId: 'cooker-1', type: 'a5', name: 'Anova Precision Cooker' }]);
  t.mock.timers.reset();

  await cloud.wake();
  assert.equal(sockets.length, 2);
  assert.ok(cloud.connected);
  cloud.close();
});

test('maps Firebase error codes to readable messages', () => {
  assert.equal(new AuthError('INVALID_LOGIN_CREDENTIALS').message, 'Wrong email or password.');
  assert.match(new AuthError('WEAK_PASSWORD : Password should be at least 6 characters').message, /too weak/);
});

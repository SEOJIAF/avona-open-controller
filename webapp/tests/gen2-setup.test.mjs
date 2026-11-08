// The 2nd-gen cooker's local API, against a stand-in that answers like the real one (lwIP HTTP/1.0:
// no Content-Length, reply ends when the socket closes, empty bodies on POST).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

const requests = [];
const scanResults = ['2HomeWifi;', '2Neighbour Net;', 'X'];
let cursor = 0;

const reply = (sock, body) =>
  sock.end(`HTTP/1.0 200 OK\r\nServer: lwIP/2.1.2\r\nContent-Type: text/plain\r\n\r\n${body}`);

const fakeCooker = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    const headEnd = buf.indexOf('\r\n\r\n');
    if (headEnd < 0) return;
    const length = Number(buf.match(/Content-Length: (\d+)/i)?.[1] ?? 0);
    const body = buf.slice(headEnd + 4);
    if (body.length < length) return;
    const [method, path] = buf.split(' ');
    requests.push({ method, path, body, contentType: buf.match(/Content-Type: ([^\r]+)/i)?.[1] });
    if (path === '/get-device-identity') return reply(sock, 'Ab12Cd34Ef56Gh78Ij90Kl');
    if (path === '/__SL_G_NW0') {
      cursor = 0;
      return reply(sock, scanResults[cursor++]);
    }
    if (path === '/__SL_G_NW1') return reply(sock, scanResults[Math.min(cursor++, scanResults.length - 1)]);
    if (path === '/__SL_G_MCH') return reply(sock, 'OK');
    reply(sock, '');
  });
});

let setup;
before(async () => {
  await new Promise((r) => fakeCooker.listen(0, '127.0.0.1', r));
  process.env.ANOVA_COOKER_URL = `http://127.0.0.1:${fakeCooker.address().port}`;
  setup = await import('../gen2-setup.mjs');
});
after(() => fakeCooker.close());

test('reads the device id', async () => {
  assert.equal(await setup.getDeviceId(), 'Ab12Cd34Ef56Gh78Ij90Kl');
});

test('scans networks through the paged __SL_G_NW endpoints', async () => {
  requests.length = 0;
  const networks = await setup.scanNetworks();
  assert.deepEqual(networks, [
    { ssid: 'HomeWifi', securityType: '2' },
    { ssid: 'Neighbour Net', securityType: '2' },
  ]);
  assert.deepEqual(requests[0], {
    method: 'POST', path: '/api/1/wlan/en_ap_scan', body: '__SL_P_SC2=3&__SL_P_SC1=10',
    contentType: 'application/x-www-form-urlencoded',
  });
});

test('sends Wi-Fi profile, account link and confirmation like the app', async () => {
  requests.length = 0;
  await setup.configureCooker({ ssid: 'Home Wifi&1', password: 'p@ss word', securityType: '2', userId: 'firebase-uid' });
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path} ${r.body}`), [
    'POST /api/1/wlan/profile_add __SL_P_P.A=Home%20Wifi%261&__SL_P_P.B=2&__SL_P_P.C=p%40ss%20word&__SL_P_P.D=1',
    'POST /add-user-identity firebase-uid',
    'POST /api/1/wlan/confirm_req ',
    'GET /__SL_G_MCH ',
  ]);
});

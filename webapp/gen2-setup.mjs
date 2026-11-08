// Setup for 2nd-generation Wi-Fi cookers (Precision Cooker Wi-Fi AN500, a4/a5/Pro Wi-Fi), reimplemented from the
// app's WifiPairingController (PROTOCOL.md §3.2). The cooker shows a 4-digit code and opens a hotspot
// "Anova <code>" (password <code><code>); this computer joins it and talks to the cooker's TI SimpleLink web server.
import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);
const COOKER_URL = process.env.ANOVA_COOKER_URL ?? 'http://10.123.45.1'; // override only for testing
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Same shape as the app's retry(fn, attempts, delaySeconds).
async function retry(fn, attempts, delaySeconds) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(delaySeconds);
    }
  }
  throw last;
}

// --- the cooker's local HTTP API (modules 4348-4354). The app posts every body as form-urlencoded text. ---
// The cooker runs lwIP's tiny HTTP/1.0 server: no Content-Length, the reply ends when it closes the socket.
// Node's fetch (undici) rejects its empty POST replies ("other side closed"), so speak HTTP over a raw socket.
function cookerRequest(path, { method = 'GET', body } = {}) {
  const { hostname, port } = new URL(COOKER_URL);
  const payload = method === 'POST' ? Buffer.from(body ?? '', 'utf8') : null;
  const head = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${hostname}`,
    ...(payload ? [`Content-Type: ${FORM['Content-Type']}`, `Content-Length: ${payload.length}`] : []),
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sock = net.createConnection({ host: hostname, port: Number(port) || 80 });
    sock.setTimeout(5000, () => sock.destroy(new Error(`cooker ${path} timed out`)));
    sock.on('connect', () => sock.end(payload ? Buffer.concat([Buffer.from(head), payload]) : head));
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', (err) => reject(new Error(`cooker ${path}: ${err.message}`)));
    sock.on('close', (hadError) => {
      if (hadError) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      const status = Number(raw.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
      if (!status) return reject(new Error(`cooker ${path}: no HTTP reply`));
      if (status >= 400) return reject(new Error(`cooker ${path} returned HTTP ${status}`));
      const split = raw.indexOf('\r\n\r\n');
      resolve(split >= 0 ? raw.slice(split + 4) : '');
    });
  });
}

export async function getDeviceId() {
  const text = (await cookerRequest('/get-device-identity')).trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parsed;
    return parsed?.deviceId ?? parsed?.deviceID ?? parsed?.id ?? text;
  } catch {
    return text;
  }
}

// getNetworkScanResults: start a scan, then page through results; "X" as the security char means no more entries.
export async function scanNetworks() {
  await cookerRequest('/api/1/wlan/en_ap_scan', { method: 'POST', body: '__SL_P_SC2=3&__SL_P_SC1=10' });
  await sleep(3);
  const found = new Map();
  const take = (data) => {
    const securityType = (data ?? '').slice(0, 1);
    const ssid = (data ?? '').slice(1, -1);
    if (!securityType || securityType === 'X') return false;
    if (ssid) found.set(ssid, { ssid, securityType });
    return true;
  };
  if (take(await cookerRequest('/__SL_G_NW0'))) {
    for (let i = 0; i < 64 && take(await cookerRequest('/__SL_G_NW1')); i++);
  }
  await cookerRequest('/__SL_G_NW0').catch(() => {}); // rewind, as the app does
  return [...found.values()];
}

// connectWifiCookerToAccessPoint: profile_add, add-user-identity (links the cooker to this account), confirm_req.
export async function configureCooker({ ssid, password, securityType, userId }) {
  const form = `__SL_P_P.A=${encodeURIComponent(ssid)}&__SL_P_P.B=${securityType}&__SL_P_P.C=${encodeURIComponent(password)}&__SL_P_P.D=1`;
  await retry(() => cookerRequest('/api/1/wlan/profile_add', { method: 'POST', body: form }), 5, 1);
  await retry(() => cookerRequest('/add-user-identity', { method: 'POST', body: userId }), 5, 1);
  await sleep(2);
  // The cooker may switch its radio to the home network as soon as it accepts confirm_req, so a dropped
  // connection here is expected; whether it worked shows up when the cooker appears in the cloud.
  const confirmed = await retry(() => cookerRequest('/api/1/wlan/confirm_req', { method: 'POST' }), 2, 1)
    .then(() => true, () => false);
  if (!confirmed) return;
  await sleep(5);
  // didConfirmationFail: the cooker reports "Confirmation failed" if it could not join the network.
  const status = await retry(() => cookerRequest('/__SL_G_MCH'), 3, 1).catch(() => '');
  if (status.includes('Confirmation failed')) {
    throw new Error('The cooker could not join that Wi-Fi network. Check the password and that it is a 2.4 GHz network.');
  }
}

// --- this computer's Wi-Fi, through NetworkManager ---
export class WifiSwitcher {
  constructor() {
    this.previous = null; // {name, device} of the Wi-Fi connection active before setup
    this.hotspot = null;
  }

  static async available() {
    try {
      await run('nmcli', ['-t', 'general']);
      return true;
    } catch {
      return false;
    }
  }

  async #activeWifi() {
    const { stdout } = await run('nmcli', ['-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active']);
    for (const line of stdout.split('\n')) {
      const [name, type, device] = line.split(':');
      if (type === '802-11-wireless') return { name, device };
    }
    return null;
  }

  async joinCookerHotspot(code) {
    if (!/^\d{4}$/.test(code)) throw new Error('The code must be 4 digits.');
    const current = await this.#activeWifi();
    if (current && !current.name.startsWith('Anova ')) this.previous = current;
    const ssid = `Anova ${code}`;
    const args = ['device', 'wifi', 'connect', ssid, 'password', `${code}${code}`];
    if (this.previous?.device) args.push('ifname', this.previous.device);
    // The cooker's hotspot can take a while to show up in NetworkManager's scan cache; keep rescanning.
    let seen = false;
    for (let i = 0; i < 10 && !seen; i++) {
      const { stdout } = await run('nmcli', ['-t', '-f', 'SSID', 'device', 'wifi', 'list', '--rescan', 'yes'], { timeout: 20_000 })
        .catch(() => ({ stdout: '' }));
      seen = stdout.split('\n').some((line) => line.trim() === ssid);
      if (!seen) await sleep(4);
    }
    if (!seen) {
      throw new Error(`This computer can't see the Wi-Fi network "${ssid}". Check the code on the cooker's display and keep the laptop close.`);
    }
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await run('nmcli', args, { timeout: 45_000 });
        this.hotspot = ssid;
        // The hotspot has no internet and blips while the cooker scans; without this NetworkManager
        // falls back to the home network and the cooker becomes unreachable mid-setup.
        await run('nmcli', ['connection', 'modify', ssid, 'connection.autoconnect-priority', '999',
          'connection.autoconnect-retries', '0']).catch(() => {});
        return;
      } catch (err) {
        lastErr = String(err.stderr || err.message).trim();
        await sleep(3);
      }
    }
    throw new Error(`Joining "${ssid}" failed: ${lastErr}`);
  }

  // Make sure this computer is (still) on the cooker's hotspot and the cooker answers.
  async ensureOnHotspot() {
    if (!this.hotspot) return; // manual mode: the user manages the connection
    if ((await this.#activeWifi())?.name !== this.hotspot) {
      await run('nmcli', ['connection', 'up', this.hotspot], { timeout: 45_000 }).catch((err) => {
        throw new Error(`Lost the cooker's Wi-Fi "${this.hotspot}" and couldn't rejoin it: ${String(err.stderr || err.message).trim()}`);
      });
    }
    for (let i = 0; i < 20; i++) {
      try {
        return await getDeviceId();
      } catch {
        await sleep(1);
      }
    }
    throw new Error(`Connected to "${this.hotspot}", but the cooker isn't answering. Keep the laptop next to the cooker and try again.`);
  }

  async restore() {
    if (this.hotspot) await run('nmcli', ['connection', 'delete', this.hotspot]).catch(() => {});
    this.hotspot = null;
    if (this.previous) await run('nmcli', ['connection', 'up', this.previous.name], { timeout: 45_000 }).catch(() => {});
  }

  get previousName() {
    return this.previous?.name ?? null;
  }
}

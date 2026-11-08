// Gen-3 Anova cooker (Precision Cooker 3.0, Nano 3.0, Mini/Lite, Pro 3.0) setup over Web Bluetooth.
// Reimplements BluetoothPairingManager from the Android app (PROTOCOL.md §1.4).
// Wire format: every characteristic value is the ASCII text of base64(JSON).

export const SERVICE = '910772a8-a5e7-49a7-bc6d-701e9a783a5c';
export const CHAR = {
  HELLO: '1877e8fa-abed-437c-8ae5-f4ec89daa1c2',
  READ_POP_CODE: 'c7a9a65b-1e5b-4387-9c0d-d3f1f7e2e254',
  CONFIRM_POP: '7e29a154-3eae-4ba8-90c3-d0763d57baf5',
  GET_AVAILABLE_NETWORKS: '511232d6-594e-4f90-8c57-c67b28505c6c',
  CONNECT_TO_NETWORK: 'dca82f2c-9406-11ec-b909-0242ac120002',
  PAIRING: '9596bdb9-c194-4aa2-b226-2e10b8d901dc',
  SETUP_DONE: 'c6537d1c-e23b-48b6-8fa6-b0e544561810',
};
const PROTOCOL_VERSION = '20220101';
const CONFIRMATION_BUTTONS = ['temp', 'timer', '-', '+', 'start'];

export const PRODUCT_NAMES = {
  a6: 'Precision Cooker Nano 3.0',
  a7: 'Precision Cooker 3.0',
  a8: 'Precision Cooker Mini',
  a9: 'Precision Cooker Pro 3.0',
};

// --- codec (prepareJson / decodeString / decodeJson) ---
function toBase64(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}
function fromBase64(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}
export function encodeJson(obj) {
  return new TextEncoder().encode(toBase64(JSON.stringify(obj)));
}
export function decodeString(dataView) {
  return fromBase64(new TextDecoder('ascii').decode(dataView).trim());
}
export function decodeJson(dataView) {
  const parsed = JSON.parse(decodeString(dataView));
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class Gen3Cooker {
  constructor(bluetooth = navigator.bluetooth) {
    this.bluetooth = bluetooth;
    this.device = null;
    this.chars = {};
    this.info = null; // HELLO reply: {result, class, deviceType, deviceId}
  }

  static isSupported(bluetooth = navigator.bluetooth) {
    return Boolean(bluetooth?.requestDevice);
  }

  // Must be called from a click handler (browser rule for Bluetooth device pickers).
  async choose() {
    this.device = await this.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    return this.device;
  }

  async connect() {
    const server = await withTimeout(this.device.gatt.connect(), 30_000, 'Bluetooth connection');
    const service = await server.getPrimaryService(SERVICE);
    for (const [name, uuid] of Object.entries(CHAR)) this.chars[name] = await service.getCharacteristic(uuid);
  }

  disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  async #write(name, obj) {
    const ch = this.chars[name];
    await (ch.writeValueWithResponse ? ch.writeValueWithResponse(encodeJson(obj)) : ch.writeValue(encodeJson(obj)));
  }

  // monitorCharacteristicForService equivalent. handler returns a value to resolve the wait, or undefined to keep waiting.
  async #waitForNotification(name, handler, ms, what, afterSubscribe) {
    const ch = this.chars[name];
    let listener;
    const done = new Promise((resolve, reject) => {
      listener = (ev) => {
        try {
          const result = handler(ev.target.value);
          if (result !== undefined) resolve(result);
        } catch (err) {
          reject(err);
        }
      };
    });
    ch.addEventListener('characteristicvaluechanged', listener);
    await ch.startNotifications();
    try {
      await afterSubscribe?.();
      return await withTimeout(done, ms, what);
    } finally {
      ch.removeEventListener('characteristicvaluechanged', listener);
      ch.stopNotifications().catch(() => {});
    }
  }

  // initiateHandshake + writeHelloHandshake: device answers {result:"accepted", class, deviceType, deviceId}.
  async hello() {
    this.info = await this.#waitForNotification(
      'HELLO',
      (v) => {
        const reply = decodeJson(v);
        if (reply?.result !== 'accepted') throw new Error(`Handshake failed (${reply?.result ?? 'no result'})`);
        return reply;
      },
      20_000,
      'Handshake',
      () => this.#write('HELLO', { protocolVersion: PROTOCOL_VERSION }),
    );
    return this.info;
  }

  get productType() {
    return String(this.info?.class ?? '').toLowerCase();
  }

  // readProofOfPossessionCode: the same code is shown on the cooker's display (not on the Mini, which blinks its LED).
  async readCode() {
    const reply = decodeJson(await this.chars.READ_POP_CODE.readValue());
    return reply?.pin;
  }

  // subscribeForProofOfPossessionConfirmation + writeConfirmationProofOfPossession.
  async waitForButtonPress() {
    const button = await this.#waitForNotification(
      'CONFIRM_POP',
      (v) => {
        const b = decodeJson(v)?.button;
        return CONFIRMATION_BUTTONS.includes(b) ? b : undefined;
      },
      180_000,
      'Waiting for the button press',
    );
    await this.#write('CONFIRM_POP', { ackButton: button });
    return button;
  }

  // startNetworkScan + subscribeForNetworksAvailableToCooker ("EXPECT.<n>" header, then n chunks of JSON).
  async scanNetworks() {
    let chunks = [];
    let expected = 0;
    const result = await this.#waitForNotification(
      'GET_AVAILABLE_NETWORKS',
      (v) => {
        const text = decodeString(v);
        if (text.startsWith('EXPECT.')) {
          chunks = [];
          expected = parseInt(text.split('.')[1] ?? '0', 10);
          return undefined;
        }
        chunks.push(text);
        if (chunks.length < expected) return undefined;
        return JSON.parse(chunks.join(''));
      },
      45_000,
      'Wi-Fi scan',
      () => this.#write('GET_AVAILABLE_NETWORKS', { command: 'start_scanning', maxSsidCount: 16, scanTimeSeconds: 5 }),
    );
    return [...new Set((result?.ssids ?? []).filter(Boolean))];
  }

  // Shared shape of CONNECT_TO_NETWORK / PAIRING / SETUP_DONE replies: {status, errorCode}.
  #statusStep(name, payload, ms, what) {
    return this.#waitForNotification(
      name,
      (v) => {
        const reply = decodeJson(v);
        if (!reply?.status) return undefined;
        if (reply.status === 'failure' || reply.status === 'error') {
          const err = new Error(`${what} failed${reply.errorCode != null ? ` (error ${reply.errorCode})` : ''}`);
          err.status = reply.status;
          err.errorCode = reply.errorCode;
          throw err;
        }
        return reply.status === 'success' ? reply : undefined;
      },
      ms,
      what,
      () => this.#write(name, payload),
    );
  }

  // EnterWifiPassword -> connectToNetwork. "failure" is what the app shows as "Incorrect Password".
  connectToWifi(ssid, password) {
    return this.#statusStep('CONNECT_TO_NETWORK', { ssid, password, cloud: 'prod' }, 120_000, 'Connecting to Wi-Fi');
  }

  // pairUserId: links the cooker to the signed-in Anova account (Firebase uid).
  pairUser(userId) {
    return this.#statusStep('PAIRING', { userId }, 90_000, 'Linking the cooker to your account');
  }

  // setupDone: tells the cooker setup is complete.
  finish() {
    return this.#statusStep('SETUP_DONE', { command: 'close' }, 60_000, 'Finishing setup');
  }
}

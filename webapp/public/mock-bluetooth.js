// Simulated gen-3 cooker behind a fake navigator.bluetooth, used only in MOCK mode.
// It answers with the same wire encoding (ASCII base64 of JSON) so gen3-ble.js runs unchanged against it.
import { SERVICE, CHAR, encodeJson, decodeJson } from './gen3-ble.js';

const encodeText = (text) => new TextEncoder().encode(btoa(text));
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const later = (ms, fn) => setTimeout(fn, ms);

class FakeCharacteristic extends EventTarget {
  constructor(uuid, device) {
    super();
    this.uuid = uuid;
    this.device = device;
    this.value = null;
    this.notifying = false;
  }
  async startNotifications() {
    this.notifying = true;
    return this;
  }
  async stopNotifications() {
    this.notifying = false;
    return this;
  }
  notify(bytes) {
    if (!this.notifying) return;
    this.value = view(bytes);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
  async readValue() {
    return view(this.device.read(this.uuid));
  }
  async writeValueWithResponse(bytes) {
    if (!this.device.gatt.connected) throw new Error('GATT Server is disconnected.');
    this.device.write(this.uuid, decodeJson(view(bytes)));
  }
}

class FakeCooker {
  constructor() {
    const suffix = Math.random().toString(16).slice(2, 8);
    this.type = 'a7';
    this.deviceId = `mock-a7-${suffix}`;
    this.name = `Anova ${suffix}`;
    this.id = `fake-${suffix}`;
    this.pin = String(1000 + Math.floor(Math.random() * 9000));
    this.chars = new Map(Object.values(CHAR).map((u) => [u, new FakeCharacteristic(u, this)]));
    this.gatt = {
      connected: false,
      device: this,
      connect: async () => {
        await new Promise((r) => later(400, r));
        this.gatt.connected = true;
        return this.gatt;
      },
      disconnect: () => {
        this.gatt.connected = false;
      },
      getPrimaryService: async (uuid) => {
        if (uuid !== SERVICE) throw new Error('No Services matching UUID found in Device.');
        return { getCharacteristic: async (u) => this.chars.get(u) };
      },
    };
  }

  read(uuid) {
    if (uuid === CHAR.READ_POP_CODE) return encodeJson({ pin: this.pin });
    throw new Error('read not permitted');
  }

  // Simulates the person pressing a button on the cooker during code confirmation.
  pressButton(button = 'start') {
    this.chars.get(CHAR.CONFIRM_POP).notify(encodeJson({ button }));
  }

  write(uuid, msg) {
    const ch = this.chars.get(uuid);
    switch (uuid) {
      case CHAR.HELLO:
        later(300, () =>
          ch.notify(encodeJson(msg.protocolVersion === '20220101'
            ? { result: 'accepted', class: this.type.toUpperCase(), deviceType: this.type, deviceId: this.deviceId }
            : { result: 'rejected' })));
        break;
      case CHAR.CONFIRM_POP:
        this.confirmed = msg.ackButton;
        break;
      case CHAR.GET_AVAILABLE_NETWORKS: {
        const json = JSON.stringify({ ssids: ['HomeNetwork', 'HomeNetwork-5G', 'Neighbor Wi-Fi', 'Kitchen IoT'] });
        const parts = [json.slice(0, 30), json.slice(30)];
        later(1200, () => ch.notify(encodeText(`EXPECT.${parts.length}`)));
        parts.forEach((p, i) => later(1300 + i * 100, () => ch.notify(encodeText(p))));
        break;
      }
      case CHAR.CONNECT_TO_NETWORK:
        this.ssid = msg.ssid;
        later(500, () => ch.notify(encodeJson({ status: 'connecting' })));
        later(2000, () =>
          ch.notify(encodeJson(msg.password === 'wrongpass' || msg.cloud !== 'prod'
            ? { status: 'failure', errorCode: 2 }
            : { status: 'success' })));
        break;
      case CHAR.PAIRING:
        later(800, () => ch.notify(encodeJson(msg.userId ? { status: 'success' } : { status: 'error', errorCode: 1 })));
        break;
      case CHAR.SETUP_DONE:
        later(500, () => ch.notify(encodeJson(msg.command === 'close' ? { status: 'success' } : { status: 'error' })));
        // A real cooker now joins the user's Wi-Fi and checks in with the Anova cloud.
        later(2500, () =>
          fetch('/api/mock/cooker-online', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookerId: this.deviceId, type: this.type, name: 'Mock Precision Cooker 3.0' }),
          }));
        break;
    }
  }
}

export const mockBluetooth = {
  lastDevice: null,
  async requestDevice() {
    await new Promise((r) => later(500, r));
    this.lastDevice = new FakeCooker();
    return this.lastDevice;
  },
};

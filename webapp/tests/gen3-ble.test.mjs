// Wire encoding of the 3rd-gen Bluetooth setup service: characteristic values are ASCII base64 of JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeJson, decodeJson, decodeString } from '../public/gen3-ble.js';

const asView = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

test('encodes JSON as base64 text bytes', () => {
  const bytes = encodeJson({ protocolVersion: '20220101' });
  assert.equal(new TextDecoder().decode(bytes), btoa('{"protocolVersion":"20220101"}'));
});

test('round-trips JSON, including non-ASCII Wi-Fi names', () => {
  const msg = { ssid: 'Kuchyňa Wi‑Fi', password: 'heslo', cloud: 'prod' };
  assert.deepEqual(decodeJson(asView(encodeJson(msg))), msg);
});

test('decodes plain string packets used by the network list', () => {
  assert.equal(decodeString(asView(new TextEncoder().encode(btoa('EXPECT.2')))), 'EXPECT.2');
});

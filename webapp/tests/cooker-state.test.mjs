import assert from 'node:assert/strict';
import test from 'node:test';
import { view } from '../public/cooker-state.mjs';

test('3rd-gen alerts remain distinct from active cooking', () => {
  for (const mode of ['lowWater', 'highTemp', 'motorStuck', 'waterLeak']) {
    const state = view({ state: {
      state: { mode, temperatureUnit: 'C' },
      nodes: { waterTemperatureSensor: { setpoint: { celsius: 56.5 } }, lowWater: { warning: mode === 'lowWater' } },
      systemInfo: { online: true },
    } });
    assert.equal(state.cooking, false);
    assert.ok(state.alert, mode);
  }
});

test('legacy low-water mode remains distinct from active cooking', () => {
  const state = view({ state: {
    job: { mode: 'LOW WATER', 'target-temperature': 56.5, 'cook-time-seconds': 0 },
    'job-status': { state: '' },
    'pin-info': { 'water-level-critical': 1 },
  } });
  assert.equal(state.cooking, false);
  assert.equal(state.alert, 'Low water');
});

test('idle and cooking modes stay distinct', () => {
  assert.equal(view({ state: { state: { mode: 'idle' } } }).cooking, false);
  assert.equal(view({ state: { state: { mode: 'idle' }, nodes: { lowWater: { warning: true } } } }).cooking, false);
  assert.equal(view({ state: { state: { mode: 'cook' } } }).cooking, true);
  assert.equal(view({ state: { job: { mode: 'IDLE' } } }).cooking, false);
  assert.equal(view({ state: { job: { mode: 'COOK' } } }).cooking, true);
});

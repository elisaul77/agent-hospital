// Escalation bell client helpers (Phase 4): fresh detection and the opt-in WebAudio bell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEscalations } from '../public/js/bell.js';
import { createBellSound } from '../public/js/audio.js';

test('only escalations whose id was not seen before are fresh', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(freshEscalations(new Set(['a']), list), [{ id: 'b' }]);
  assert.deepEqual(freshEscalations(new Set(['a', 'b']), list), []);
  assert.deepEqual(freshEscalations(new Set(), undefined), []);
});

test('with sound off no AudioContext is created and nothing rings', () => {
  let made = 0;
  class Fake { constructor() { made++; } }
  const bell = createBellSound({ AudioCtor: Fake });
  assert.equal(bell.enabled, false);
  assert.equal(bell.ring(), false);
  assert.equal(made, 0);
});

test('turning sound on creates the context once, and then ring schedules two strikes', () => {
  let made = 0;
  const started = [];
  class Fake {
    constructor() { made++; this.currentTime = 0; this.destination = {}; }
    createOscillator() { return { connect() {}, start: (t) => started.push(t), stop() {}, frequency: {} }; }
    createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  }
  const bell = createBellSound({ AudioCtor: Fake });
  bell.setEnabled(true);
  assert.equal(made, 1);
  assert.equal(bell.ring(), true);
  assert.equal(started.length, 2);
  assert.equal(made, 1);
});

test('no WebAudio: sound stays off and the reason is logged, not thrown', () => {
  const logs = [];
  const bell = createBellSound({ AudioCtor: undefined, log: (m) => logs.push(m) });
  bell.setEnabled(true);
  assert.equal(bell.enabled, false);
  assert.equal(logs.length, 1);
});

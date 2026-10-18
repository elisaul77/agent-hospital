// Phase 5a: fit-to-screen zoom. Integer, at least 100 %, at most 400 %, and the largest one that fits the HUD frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitZoomOf, FIT_SIDE, FIT_TOP, FIT_BOTTOM } from '../public/js/view.js';
import { W, H, TILE } from '../public/js/map.js';

test('the fit zoom is an integer between 1 and 4', () => {
  for (const [w, h] of [[320, 480], [800, 600], [1366, 768], [1600, 900], [1920, 1080], [2560, 1440], [6000, 4000]]) {
    const z = fitZoomOf(w, h);
    assert.ok(Number.isInteger(z) && z >= 1 && z <= 4, `${w}x${h} -> ${z}`);
  }
});

test('small viewports keep 100 % and pan (never below the current default)', () => {
  assert.equal(fitZoomOf(800, 600), 1);
  assert.equal(fitZoomOf(320, 480), 1);
});

test('a viewport that fits the hospital at 200 % gets 200 %, and no larger zoom that overflows', () => {
  const w = W * TILE * 2 + 2 * FIT_SIDE;
  const h = H * TILE * 2 + FIT_TOP + FIT_BOTTOM;
  assert.equal(fitZoomOf(w, h), 2);
  assert.equal(fitZoomOf(w - 1, h), 1);
  assert.equal(fitZoomOf(w, h - 1), 1);
});

test('the chosen zoom always fits the frame when it is above 100 %', () => {
  for (const [w, h] of [[1600, 1320], [2000, 1400], [3000, 2000], [5000, 3500]]) {
    const z = fitZoomOf(w, h);
    if (z > 1) {
      assert.ok(W * TILE * z + 2 * FIT_SIDE <= w);
      assert.ok(H * TILE * z + FIT_TOP + FIT_BOTTOM <= h);
    }
  }
});

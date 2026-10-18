// Client-side pure rules (imported by node:test; no DOM needed): equipment per tool, gate and threads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equipmentOf, gateBlocked, threadsOf, warningSummary, frozenWarnView, FIXED_DROP_MS } from '../js/anim.js';

test('unruled is blocking: it closes the gate, draws a thread, and is counted as "sin dictamen"', () => {
  assert.equal(gateBlocked({ warnings: [{ state: 'unruled' }] }), true);
  assert.deepEqual(threadsOf({ warnings: [{ id: 'u', state: 'unruled' }] }, 10_000).map((w) => w.id), ['u']);
  assert.equal(warningSummary({ warnings: [{ text: 'x', state: 'unruled' }] }), '1 sin dictamen');
});

test('frozen warning fixtures (?freezeWarn=) hold the state they are named for, and unknown names give null', () => {
  const now = 1000;
  const held = frozenWarnView('held', now).cases.frozen;
  assert.equal(held.held, 'discharge');
  assert.deepEqual(threadsOf(held, now).map((w) => w.state), ['open', 'unruled']);
  assert.deepEqual(frozenWarnView('fixed', now).cases.frozen.warnings.map((w) => w.state), ['fixed']);
  assert.deepEqual(frozenWarnView('must_fix', now).cases.frozen.warnings.map((w) => w.state), ['must_fix']);
  assert.deepEqual(frozenWarnView('acceptable', now).cases.frozen.warnings.map((w) => w.state), ['acceptable']);
  assert.equal(frozenWarnView('nope', now), null);
});

test('each tool maps to its equipment; MCP tools get the console; unknown gets the generic kind', () => {
  const table = {
    Read: 'lightbox', NotebookRead: 'lightbox', Grep: 'microscope', Glob: 'microscope', Bash: 'sparks',
    Edit: 'scalpel', Write: 'scalpel', MultiEdit: 'scalpel', WebSearch: 'dish', WebFetch: 'dish',
    Task: 'pager', Agent: 'pager', SendMessage: 'capsule', mcp__cad__diseno: 'console', Mystery: 'working',
  };
  for (const [tool, kind] of Object.entries(table)) assert.equal(equipmentOf(tool), kind, tool);
  const kinds = new Set(Object.values(table));
  assert.equal(kinds.size, 9, 'nine distinct equipment kinds');
});

test('the gate is closed by open, acceptable and must_fix; fixed does not close it', () => {
  for (const state of ['open', 'acceptable', 'must_fix']) {
    assert.equal(gateBlocked({ warnings: [{ state }] }), true, state);
  }
  assert.equal(gateBlocked({ warnings: [{ state: 'fixed' }] }), false);
  assert.equal(gateBlocked({ warnings: [] }), false);
  assert.equal(gateBlocked({}), false);
});

test('threads: blocking ones always; a fixed one only while it drops', () => {
  const now = 10_000;
  const c = { warnings: [
    { id: 'a', state: 'open' },
    { id: 'b', state: 'acceptable' },
    { id: 'c', state: 'fixed', ruledT: now - 100 },
    { id: 'd', state: 'fixed', ruledT: now - FIXED_DROP_MS - 1 },
    { id: 'e', state: 'must_fix' },
  ] };
  assert.deepEqual(threadsOf(c, now).map((w) => w.id), ['a', 'b', 'c', 'e']);
});

test('HUD summary carries counts and the held state, never warning text', () => {
  const c = { held: 'discharge', warnings: [
    { text: 'SECRET-WARNING-TEXT', state: 'open' },
    { text: 'SECRET-WARNING-TEXT', state: 'must_fix' },
    { text: 'SECRET-WARNING-TEXT', state: 'acceptable' },
    { text: 'SECRET-WARNING-TEXT', state: 'fixed' },
  ] };
  const s = warningSummary(c);
  assert.equal(s, '1 abierto(s) · 1 a corregir · 1 a la espera del usuario · 1 resuelto(s) · retenido en Alta');
  assert.ok(!s.includes('SECRET'));
  assert.equal(warningSummary({ warnings: [] }), '');
});

// Phase 5a: patient chips per case. One row per case with a case colour tag (the same colour as that case's
// wristband), caps of 6 waiting and 4 finished per row, "+N" for the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipRowsOf, caseColourOf, CASE_COLOURS, WAITING_CAP, DISCHARGED_CAP } from '../public/js/patients.js';

const phases = (total, done) => Array.from({ length: total }, (_, i) => ({
  id: `${i + 1}`, title: `Fase ${i + 1}`, state: i < done ? 'done' : i === done ? 'current' : 'waiting',
}));

test('one row per case, in case order; a case with no patients has no row', () => {
  const cases = { a: { caseId: 'a', phases: phases(10, 1) }, b: { caseId: 'b', phases: phases(3, 2) }, c: { caseId: 'c', phases: [] } };
  const rows = chipRowsOf(cases);
  assert.deepEqual(rows.map((r) => r.caseId), ['a', 'b']);
});

test('caps per row: 6 waiting and 4 finished, with the rest counted as "+N"', () => {
  assert.equal(WAITING_CAP, 6);
  assert.equal(DISCHARGED_CAP, 4);
  const rows = chipRowsOf({ a: { caseId: 'a', phases: phases(10, 1) } });
  assert.equal(rows[0].waiting.length, 6);
  assert.equal(rows[0].waitingMore, 2);
  assert.equal(rows[0].finished.length, 1);
  assert.equal(rows[0].finishedMore, 0);
  const many = chipRowsOf({ a: { caseId: 'a', phases: phases(12, 9) } });
  assert.equal(many[0].finished.length, 4);
  assert.equal(many[0].finishedMore, 5);
});

test('each row has its own colour; the colour is the case colour used by its wristband', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const cases = Object.fromEntries(ids.map((id) => [id, { caseId: id, phases: phases(3, 1) }]));
  const rows = chipRowsOf(cases);
  const colours = rows.map((r) => r.colour);
  assert.equal(new Set(colours).size, 4, 'four cases, four colours');
  for (const r of rows) assert.equal(r.colour, caseColourOf(r.caseId, ids));
  assert.ok(colours.every((c) => CASE_COLOURS.includes(c)));
});

test('the case colour never uses a tier colour (S red, M yellow, L blue)', () => {
  for (const c of CASE_COLOURS) assert.ok(!['#ff6b5b', '#f2c94c', '#56a8ff'].includes(c));
});

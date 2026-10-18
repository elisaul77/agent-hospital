// Phase 4b client rules (pure, imported by node:test): patients by place, caps, wristband, specialty desks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  patientsOf, wristbandOf, wristbandLabel, chipLayout, specialtyDeskOf, phaseStateLabel, WAITING_CAP, DISCHARGED_CAP,
} from '../public/js/patients.js';
import { SPECIALTY_DESKS, ROOMS } from '../public/js/map.js';

// `done` finished patients, one current (unless all are done), the rest waiting.
const phases = (total, done) => Array.from({ length: total }, (_, i) => ({
  id: `${i + 1}`, title: `Fase ${i + 1}`, state: i < done ? 'done' : i === done ? 'current' : 'waiting',
}));

test('patients are counted by state across cases; the caps are 6 waiting and 4 discharged', () => {
  assert.equal(WAITING_CAP, 6);
  assert.equal(DISCHARGED_CAP, 4);
  const cases = { a: { caseId: 'a', phases: phases(10, 1) }, b: { caseId: 'b', phases: phases(3, 2) } };
  const p = patientsOf(cases);
  assert.equal(p.waiting.length, 8); // a: patients 3-10
  assert.equal(p.current.length, 2); // a: patient 2, b: patient 3
  assert.equal(p.discharged.length, 3); // a: patient 1, b: patients 1-2
  assert.deepEqual(chipLayout(p.waiting.length, WAITING_CAP, 3).more, 2);
  assert.deepEqual(chipLayout(p.discharged.length, DISCHARGED_CAP, 4).more, 0);
});

test('a case with no phases has no wristband and no patients', () => {
  assert.equal(wristbandOf({ caseId: 'x', phases: [] }), null);
  assert.equal(wristbandOf({ caseId: 'x' }), null);
  assert.deepEqual(patientsOf({ x: { caseId: 'x', phases: [] } }), { waiting: [], current: [], discharged: [] });
});

test('wristband shows the current patient over the total; a finished case shows its last patient', () => {
  assert.equal(wristbandOf({ phases: phases(10, 1) }).label, '2/10');
  assert.equal(wristbandOf({ phases: phases(3, 3) }).label, '3/3');
  assert.equal(wristbandLabel('3b', 7), '3b/7');
});

test('chip layout: at most the cap is drawn, the rest is a count, slots stay inside the grid', () => {
  assert.deepEqual(chipLayout(0, 6, 3), { slots: [], more: 0 });
  const full = chipLayout(6, 6, 3);
  assert.equal(full.slots.length, 6);
  assert.equal(full.more, 0);
  assert.equal(full.moreSlot, undefined);
  const over = chipLayout(9, 6, 3);
  assert.equal(over.slots.length, 6);
  assert.equal(over.more, 3);
  assert.deepEqual(over.moreSlot, { col: 0, row: 2 });
  const cells = new Set(over.slots.map((s) => `${s.col},${s.row}`));
  assert.equal(cells.size, 6);
  assert.ok(over.slots.every((s) => s.col >= 0 && s.col < 3));
});

test('a 30-phase plan never draws more than the caps (no throw)', () => {
  const p = patientsOf({ big: { caseId: 'big', phases: phases(30, 30) } });
  assert.equal(p.discharged.length, 30);
  assert.equal(p.waiting.length, 0);
  const shown = chipLayout(p.discharged.length, DISCHARGED_CAP, 4);
  assert.equal(shown.slots.length, 4);
  assert.equal(shown.more, 26);
  const waiting = patientsOf({ big: { caseId: 'big', phases: phases(30, 0) } });
  assert.equal(chipLayout(waiting.waiting.length, WAITING_CAP, 3).slots.length, 6);
});

test('specialty desk: a token maps case-insensitively; unknown, missing and invalid tokens use the generic desk', () => {
  assert.equal(specialtyDeskOf('security').id, 'security');
  assert.equal(specialtyDeskOf('Security'), specialtyDeskOf('security'));
  assert.equal(specialtyDeskOf('architecture').id, 'architecture');
  for (const t of ['quantum-x', '', null, undefined]) assert.equal(specialtyDeskOf(t).id, 'general');
});

test('specialty desks: seven distinct desks in the Specialist pool, each with a short plaque', () => {
  assert.equal(SPECIALTY_DESKS.length, 7);
  assert.equal(new Set(SPECIALTY_DESKS.map((d) => d.id)).size, 7);
  const room = ROOMS.find((r) => r.id === 'specialists').rect;
  const seats = new Set();
  for (const d of SPECIALTY_DESKS) {
    const [x, y] = d.seat;
    assert.ok(x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h, `${d.id} seat in room`);
    seats.add(`${x},${y}`);
    assert.ok(d.label.length >= 1 && d.label.length <= 8, `${d.id} plaque length`);
  }
  assert.equal(seats.size, 7);
});

test('phase states read in Spanish; public client code never writes HTML from text', () => {
  assert.equal(phaseStateLabel('current'), 'en curso');
  assert.equal(phaseStateLabel('done'), 'hecho');
  assert.equal(phaseStateLabel('waiting'), 'en espera');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('innerHTML'), `${f} uses innerHTML`);
  }
});

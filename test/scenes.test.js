// Render-only scene fixtures (?freezeScene=) for the Phase 4 screenshots: council, tube, accepted seal,
// Direction pending and Direction answered. Each one is a fixed view, zoomed in (>= 300 %), never sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frozenSceneView, SCENE_NAMES } from '../public/js/anim.js';

const NOW = 1000;
const scene = (name) => frozenSceneView(name, NOW);
const holders = (v) => Object.values(v.agents).filter((a) => a.holdingAt === 'direction');

test('scene names are fixed and unknown names give null', () => {
  // Phase 4b added 'waiting' (patients in Reception and Alta) and 'consult' (a specialty desk) before 'council'.
  // Phase 5a added 'chips' (four cases, one chip row each) before 'direction'.
  assert.deepEqual(SCENE_NAMES, ['waiting', 'consult', 'council', 'tube', 'accepted', 'chips', 'direction', 'direction-answered']);
  assert.equal(frozenSceneView('nope', NOW), null);
});

test('every scene is zoomed to at least 300 % on a focus tile', () => {
  for (const name of SCENE_NAMES) {
    const s = scene(name);
    assert.ok(s.zoom >= 3, `${name} zoom`);
    assert.equal(s.focus.length, 2, `${name} focus`);
  }
});

test('council: four distinct council hats in the council room, and a capsule mid-flight', () => {
  const { view } = scene('council');
  const agents = Object.values(view.agents);
  assert.equal(new Set(agents.map((a) => a.role)).size, 4);
  assert.ok(agents.every((a) => a.room === 'council' && a.role.startsWith('council-')));
  const m = view.messages[0];
  assert.ok(m && m.t < NOW && NOW - m.t < 1600, 'a capsule in flight at NOW');
  assert.ok(view.agents[m.from] && view.agents[m.to], 'the capsule links two of the four seats');
});

test('tube: one SendMessage capsule mid-flight between two agents in different rooms', () => {
  const { view } = scene('tube');
  const [m] = view.messages;
  assert.ok(m && NOW - m.t > 0 && NOW - m.t < 1600);
  assert.notEqual(view.agents[m.from].room, view.agents[m.to].room);
});

test('accepted: a signed risk on a case in the archive room, with no blocking warning', () => {
  const c = Object.values(scene('accepted').view.cases)[0];
  assert.equal(c.room, 'casefile');
  assert.equal(c.accepted.length, 1);
  assert.ok(c.warnings.every((w) => !['open', 'unruled', 'acceptable', 'must_fix'].includes(w.state)));
});

test('direction pending: a delegate holds at the door, the approval is pending, no stamp yet', () => {
  const s = scene('direction');
  const c = Object.values(s.view.cases)[0];
  assert.ok(c.approval, 'approval pending');
  assert.equal(holders(s.view).length, 1, 'one delegate holding');
  assert.ok(!(s.view.userT && NOW - s.view.userT < 4000), 'no stamp');
  assert.ok(s.view.escalations.some((e) => e.reason === 'approve'), 'the bell rings for approve');
});

test('direction answered: no delegate, no approval, and the stamp is up; not the same frame as pending', () => {
  const pending = scene('direction');
  const answered = scene('direction-answered');
  const c = Object.values(answered.view.cases)[0];
  assert.equal(c.approval, null);
  assert.equal(holders(answered.view).length, 0);
  assert.ok(answered.view.userT && NOW - answered.view.userT < 4000, 'stamp showing');
  assert.notEqual(JSON.stringify(pending.view), JSON.stringify(answered.view));
});

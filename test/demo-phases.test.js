// Demo mode (Phase 4b): the scripted cases pass through the real reducer and show every patient state,
// and one consult sits at a specialty desk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseSteps } from '../src/demo.js';
import { EMPTY_STATE, reduce, derive } from '../src/state.js';
import { specialtyDeskOf } from '../public/js/patients.js';

test('demo shows waiting, current and done patients, and a consult at its specialty desk', () => {
  let state = EMPTY_STATE();
  const seen = new Set();
  const consults = [];
  let t = 1_000_000;
  // The Conductor is spawned first, as startDemo() does before any cycle.
  state = reduce(state, { t, kind: 'agent_spawn', sessionId: 'demo', agentId: 'main', subagentType: 'conductor', description: 'Conductor' });
  for (let cycle = 0; cycle < 2; cycle++) {
    const sid = `demo-${cycle}`;
    for (const step of caseSteps(sid, cycle % 2 === 0)) {
      t += step.wait + 1;
      state = reduce(state, { t, ...step.make(sid) });
      const view = derive(state, t);
      for (const c of Object.values(view.cases)) for (const p of c.phases ?? []) seen.add(p.state);
      for (const a of Object.values(view.agents)) if (a.consult) consults.push(a);
    }
  }
  assert.deepEqual([...seen].sort(), ['current', 'done', 'waiting']);
  assert.ok(consults.length >= 1, 'a consult appears in the demo');
  for (const a of consults) {
    assert.equal(a.room, 'specialists');
    assert.equal(specialtyDeskOf(a.specialty).id, 'security');
  }
});

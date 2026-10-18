// Council and specialist pool mapping (Phase 4): team members and council-* go to the Council room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleOf } from '../src/roles.js';

test('council-* types and the team members spec/risk/architect/lateral go to the Council room', () => {
  for (const t of ['council-spec', 'council-risk', 'council-architect', 'council-lateral', 'spec', 'risk', 'architect', 'lateral']) {
    assert.equal(roleOf(t).room, 'council', t);
  }
  assert.equal(roleOf('spec').role, 'council-spec');
  assert.equal(roleOf('lateral').role, 'council-lateral');
  assert.equal(roleOf('architect').role, 'council-architect');
  assert.equal(roleOf('risk').role, 'council-risk');
});

test('alfa and beta go to the Specialist pool; AgentArchitect keeps its own office', () => {
  for (const t of ['alfa', 'beta']) assert.deepEqual(roleOf(t), { role: 'consultant', room: 'specialists' }, t);
  assert.deepEqual(roleOf('AgentArchitect'), { role: 'architect', room: 'architect' });
});

// ---- Phase 4b: consult desk and specialty token ----
import * as roles4b from '../src/roles.js';

test('review-agent in consult mode is a consultant at the specialists desk, not a reviewer', () => {
  assert.deepEqual(roles4b.roleOf('review-agent', 'consult'), { role: 'consultant', room: 'specialists' });
  assert.equal(roles4b.roleOf('review-agent', 'review').room, 'radiology');
  assert.equal(roles4b.isConsult('review-agent', 'consult'), true);
  assert.equal(roles4b.isConsult('review-agent', undefined), false);
  assert.equal(roles4b.isConsult('codex-agent', 'consult'), false);
});

test('specialty token is lowercased, ^[a-z][a-z0-9-]{0,23}$; anything else is null', () => {
  assert.equal(roles4b.specialtyToken('Cost'), 'cost');
  assert.equal(roles4b.specialtyToken('ops-2'), 'ops-2');
  assert.equal(roles4b.specialtyToken('2fast'), null);
  assert.equal(roles4b.specialtyToken('a b'), null);
  assert.equal(roles4b.specialtyToken(undefined), null);
  assert.equal(roles4b.SPECIALTY_RE.test('a'.repeat(24)), true);
  assert.equal(roles4b.SPECIALTY_RE.test('a'.repeat(25)), false);
});

// ---- Phase 4: council room role fix (D14) ----
// Team members spawned with a free name (spec5, architect5...) carry the real type in the meta sidecar.
import * as roles4 from '../src/roles.js';

test('free team names matching the council pattern land in the Council room', () => {
  const cases = {
    spec5: 'council-spec', architect5: 'council-architect', lateral5: 'council-lateral', risk5: 'council-risk',
    'council-lateral-hospital-5b1': 'council-lateral', 'risk-2': 'council-risk',
  };
  for (const [name, role] of Object.entries(cases)) {
    assert.deepEqual(roles4.roleOf(name), { role, room: 'council' }, name);
  }
});

test('names that only look like council members stay in the Specialist pool', () => {
  for (const name of ['specialist', 'riskless', 'architecture', 'Spec5', 'my-spec-helper']) {
    assert.deepEqual(roles4.roleOf(name), { role: 'consultant', room: 'specialists' }, name);
  }
});

test('effectiveAgentType prefers customAgentType, then spawnedAgentType, when they are known roles', () => {
  const real = { agentType: 'architect5', name: 'architect5', customAgentType: 'council-architect', spawnedAgentType: 'council-architect' };
  assert.equal(roles4.effectiveAgentType(real), 'council-architect');
  assert.equal(roles4.effectiveAgentType({ agentType: 'spec5', spawnedAgentType: 'council-spec' }), 'council-spec');
  assert.equal(roles4.effectiveAgentType({ agentType: 'mine', customAgentType: 'review-agent' }), 'review-agent');
});

test('effectiveAgentType keeps agentType when the real type is not a known role', () => {
  // alfa/beta are spawned as general-purpose: stays alfa -> Specialist pool.
  const alfa = { agentType: 'alfa', name: 'alfa', spawnedAgentType: 'general-purpose' };
  assert.equal(roles4.effectiveAgentType(alfa), 'alfa');
  assert.deepEqual(roles4.roleOf(roles4.effectiveAgentType(alfa)), { role: 'consultant', room: 'specialists' });
  assert.equal(roles4.effectiveAgentType({ agentType: 'spec5' }), 'spec5');
  assert.equal(roles4.effectiveAgentType({}), undefined);
  assert.equal(roles4.effectiveAgentType(null), undefined);
});

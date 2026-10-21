import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkflow } from '../src/workflow.js';
import { EMPTY_STATE, reduce, derive } from '../src/state.js';

const t = 1_000_000;
const run = (events) => events.reduce(reduce, EMPTY_STATE());
const main = { t, kind: 'agent_spawn', sessionId: 's', agentId: 's', subagentType: 'assistant', workflow: 'unknown', runtime: 'claude' };
const child = (agentId, subagentType) => ({ ...main, agentId, subagentType, parentAgentId: 's' });

test('spawn without workflow keeps observed planning room without creating a case', () => {
  const s = run([{ t, kind: 'agent_spawn', sessionId: 's', agentId: 's', subagentType: 'assistant' },
    { t: t + 1, kind: 'agent_spawn', sessionId: 's', agentId: 'p', subagentType: 'planning-agent', parentAgentId: 's' }]);
  assert.deepEqual(s.cases, {});
  assert.equal(s.agents.s.room, 'specialists');
  assert.equal(s.agents.p.room, 'diagnosis');
  assert.equal(s.workflows.s?.workflow ?? 'unknown', 'unknown');
});

test('bare pool claim on spawn cannot promote a session or create a case', () => {
  const s = run([{ t, kind: 'agent_spawn', sessionId: 's', agentId: 's', subagentType: 'assistant', workflow: 'subagent-pool' },
    { t: t + 1, kind: 'agent_spawn', sessionId: 's', agentId: 'p', subagentType: 'planning-agent', workflow: 'subagent-pool', parentAgentId: 's' }]);
  assert.deepEqual(s.cases, {});
  assert.equal(s.agents.s.room, 'specialists');
  assert.equal(s.agents.p.room, 'diagnosis');
  assert.equal(s.workflows.s?.workflow ?? 'unknown', 'unknown');
});

test('confirmation needs an exact pool workflow even with a valid reason', () => {
  for (const workflow of [undefined, 'other', 'unknown', null]) {
    const initial = run([main, child('p', 'planning-agent')]);
    const s = reduce(initial, { t: t + 1, kind: 'workflow_confirmed', sessionId: 's', workflow,
      runtime: 'claude', reason: 'skill_invocation' });
    assert.deepEqual(s.cases, {}, String(workflow));
    assert.equal(s.workflows.s.workflow, 'unknown', String(workflow));
    assert.equal(s.agents.s.role, 'consultant', String(workflow));
    assert.equal(s.agents.p.room, 'diagnosis', String(workflow));
  }
});

test('ordinary workflows keep observed role rooms without inferring a case or pool roles', () => {
  for (const workflow of ['unknown', 'other']) {
    const s = run([{ ...main, workflow },
      { ...child('p', 'planning-agent'), workflow },
      { ...child('i', 'implement-agent'), workflow },
      { ...child('r', 'review-agent'), workflow },
      { ...child('c', 'council-risk'), workflow },
      { ...child('a', 'AgentArchitect'), workflow },
      { ...child('consult', 'review-agent'), workflow, mode: 'consult' }]);
    assert.deepEqual(s.cases, {}, workflow);
    assert.deepEqual(s.escalations, [], workflow);
    assert.equal(s.agents.s.room, 'specialists', workflow);
    assert.equal(s.agents.p.room, 'diagnosis', workflow);
    assert.equal(s.agents.i.room, 'operating', workflow);
    assert.equal(s.agents.r.room, 'radiology', workflow);
    assert.equal(s.agents.r.reviewer, true, workflow);
    for (const id of ['c', 'a', 'consult']) assert.equal(s.agents[id].room, 'specialists', `${workflow}:${id}`);
    assert.equal(s.agents.consult.reviewer, false, workflow);
  }
});

test('classifier requires an explicit Skill invocation or a matched, corroborated case file', () => {
  assert.equal(classifyWorkflow({ runtime: 'claude' }).workflow, 'unknown');
  assert.equal(classifyWorkflow({ runtime: 'claude', prompt: 'use subagent-pool', agentName: 'planning-agent' }).workflow, 'unknown');
  assert.equal(classifyWorkflow({ runtime: 'claude', tool: 'Read', skill: 'subagent-pool' }).workflow, 'unknown');
  assert.equal(classifyWorkflow({ runtime: 'claude', tool: 'Skill', skill: 'other-skill' }).workflow, 'other');
  assert.deepEqual(classifyWorkflow({ runtime: 'claude', tool: 'Skill', skill: 'subagent-pool' }),
    { workflow: 'subagent-pool', runtime: 'claude', reason: 'skill_invocation' });
  const file = { runtime: 'codex', sessionId: 's', caseFile: { confined: true, active: true, sessionBound: true, sessionId: 's', poolHeaders: true, modifiedAt: t + 1 },
    sessionStartedAt: t, observedAt: t + 2, parentChild: true, poolRoles: true, handback: true };
  assert.equal(classifyWorkflow(file).workflow, 'subagent-pool');
  for (const change of [
    { sessionId: 'other' }, { caseFile: { ...file.caseFile, confined: false } },
    { caseFile: { ...file.caseFile, sessionId: 'other' } }, { parentChild: false }, { poolRoles: false }, { handback: false }, { caseFile: { ...file.caseFile, modifiedAt: t - 1 } },
    { caseFile: { ...file.caseFile, poolHeaders: false } }, { caseFile: { ...file.caseFile, sessionBound: false } },
  ]) assert.equal(classifyWorkflow({ ...file, ...change }).workflow, 'unknown');
});

test('unknown session shows observed agents and tools without a case or false alerts', () => {
  const s = run([main, child('p', 'planning-agent'), child('risk', 'risk'),
    { t: t + 1, kind: 'tool_start', sessionId: 's', agentId: 's', tool: 'Read', label: 'file', toolUseId: 'u' },
    { t: t + 2, kind: 'agent_done', sessionId: 's', agentId: 'p', verdict: 'APPROVED', final: true },
    { t: t + 3, kind: 'approval_pending', sessionId: 's', agentId: 's', action: 'git push' },
    { t: t + 4, kind: 'triage', sessionId: 's', tier: 'M', phases: [{ id: '1', title: 'One' }] },
    { t: t + 5, kind: 'warning_open', sessionId: 's', agentId: 'p', items: ['false warning'] },
    { t: t + 6, kind: 'question', sessionId: 's' },
    { t: t + 20_000, kind: 'idle_tick' }]);
  const v = derive(s, t + 20_000);
  assert.deepEqual(v.cases, {});
  assert.deepEqual(v.escalations, []);
  assert.equal(v.agents.s.role, 'consultant');
  assert.equal(v.agents.s.room, 'specialists');
  assert.equal(v.agents.s.tool.name, 'Read');
  assert.equal(v.agents.s.runtime, 'claude');
  assert.equal(v.agents.p, undefined, 'a finished child leaves after its existing handback TTL');
  assert.equal(run([main, child('p', 'planning-agent')]).agents.p.room, 'diagnosis');
  assert.equal(v.agents.risk.room, 'specialists');
  assert.equal(v.workflows.s.workflow, 'unknown');
  assert.equal(v.workflows.s.runtime, 'claude');
});

test('other workflow stays generic and a later confirmation promotes in place', () => {
  const initial = run([main, child('r', 'review-agent'),
    { t: t + 1, kind: 'workflow_observed', sessionId: 's', workflow: 'other', runtime: 'claude', reason: 'other_skill_invocation' }]);
  assert.equal(derive(initial, t + 1).workflows.s.workflow, 'other');
  assert.equal(derive(initial, t + 1).workflows.s.reason, 'other_skill_invocation');
  assert.deepEqual(initial.cases, {});
  const s = reduce(initial, { t: t + 2, kind: 'workflow_confirmed', sessionId: 's', workflow: 'subagent-pool', runtime: 'claude', reason: 'skill_invocation' });
  assert.equal(Object.keys(s.agents).length, 2);
  assert.equal(s.agents.s.role, 'conductor');
  assert.equal(s.agents.r.role, 'review');
  assert.ok(s.cases.s);
  assert.equal(derive(s, t + 2).workflows.s.workflow, 'subagent-pool');
  const done = reduce(s, { t: t + 3, kind: 'agent_done', agentId: 'r', verdict: 'APPROVED', final: true });
  assert.equal(done.cases.s.status, 'discharged');
});

test('unknown workflow cannot demote a confirmed pool or create a second case', () => {
  let s = run([main, { t: t + 1, kind: 'workflow_confirmed', sessionId: 's', workflow: 'subagent-pool', runtime: 'claude', reason: 'skill_invocation' }]);
  const original = s.cases.s;
  s = reduce(s, { ...child('p', 'planning-agent'), t: t + 2 });
  s = reduce(s, { t: t + 3, kind: 'workflow_observed', sessionId: 's', workflow: 'unknown', runtime: 'claude' });
  assert.equal(s.workflows.s.workflow, 'subagent-pool');
  assert.equal(s.cases.s.caseId, original.caseId);
  assert.equal(Object.keys(s.cases).length, 1);
});

test('an observed pool claim does not confirm the workflow', () => {
  const s = run([main, { t: t + 1, kind: 'workflow_observed', sessionId: 's', workflow: 'subagent-pool', runtime: 'claude' }]);
  assert.equal(derive(s, t + 1).workflows.s.workflow, 'unknown');
  assert.deepEqual(s.cases, {});
});

test('workflow metadata on first main tool event prevents a false Conductor', () => {
  const s = run([{ t, kind: 'tool_start', sessionId: 's', agentId: 's', workflow: 'unknown', runtime: 'codex',
    tool: 'Read', label: 'file', toolUseId: 'u' },
  { t: t + 1, kind: 'task_complete', sessionId: 's', agentId: 's' }]);
  assert.equal(s.agents.s.role, 'consultant');
  assert.equal(s.agents.s.runtime, 'codex');
  assert.deepEqual(s.cases, {});
});

test('pool promotion preserves a review-agent consult as a specialist', () => {
  const s = run([main, { ...child('consult', 'review-agent'), mode: 'consult', specialty: 'cost' },
    { t: t + 1, kind: 'workflow_confirmed', sessionId: 's', workflow: 'subagent-pool', runtime: 'claude', reason: 'skill_invocation' }]);
  assert.equal(s.agents.consult.role, 'consultant');
  assert.equal(s.agents.consult.room, 'specialists');
  assert.equal(s.agents.consult.reviewer, false);
});

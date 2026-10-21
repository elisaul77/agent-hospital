// Delegate at the Direction door (Phase 4 revision): an approval that comes from a Bash tool or a BLOCKED
// handback holds the agent that issued it at the door until the user answers. The Conductor is never the
// delegate, and a case-file gate (no agent) holds nobody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, derive, EMPTY_STATE, HANDBACK_TTL_MS, LEAVE_MS } from '../src/state.js';
import { normalizeLine, parseLine } from '../src/normalize.js';

const S = 'sess-hold';
const T = 1_000_000;
const run = (events) => events.reduce((s, ev) => reduce(s, ev), EMPTY_STATE({ trustedDemo: true }));
const spawn = (agentId, subagentType, t = T) =>
  ({ t, kind: 'agent_spawn', sessionId: S, agentId, subagentType, parentAgentId: S, description: 'd' });

test('approval from a Bash tool marks that agent holdingAt direction; the user message clears it', () => {
  const s1 = run([
    spawn(S, 'conductor'),
    spawn('impl', 'implement-agent'),
    { t: T + 1, kind: 'approval_pending', sessionId: S, agentId: 'impl', action: 'git merge' },
  ]);
  assert.equal(s1.agents.impl.holdingAt, 'direction');
  assert.equal(s1.agents[S].holdingAt, undefined, 'the Conductor is never marked as the delegate');
  const s2 = reduce(s1, { t: T + 2, kind: 'user_message', sessionId: S });
  assert.equal(s2.agents.impl.holdingAt, undefined, 'cleared by the user message');
  assert.equal(s2.cases[S].approval, null);
});

test('a Conductor approval (main session Bash) rings Direction but holds nobody', () => {
  const s = run([
    spawn(S, 'conductor'),
    { t: T + 1, kind: 'approval_pending', sessionId: S, agentId: S, action: 'git push' },
  ]);
  assert.equal(s.agents[S].holdingAt, undefined);
  assert.equal(s.cases[S].approval.action, 'git push');
});

test('a case-file gate (no agent) holds nobody', () => {
  const s = run([
    spawn('impl', 'implement-agent'),
    { t: T + 1, kind: 'approval_pending', sessionId: S, action: 'gate 2' },
  ]);
  assert.equal(s.agents.impl.holdingAt, undefined);
  assert.equal(s.cases[S].approval.action, 'gate 2');
});

test('a holding delegate stays in the derived view after the handback TTL until the user answers', () => {
  const s1 = run([
    spawn('impl', 'implement-agent'),
    spawn('other', 'implement-agent'),
    { t: T + 1, kind: 'approval_pending', sessionId: S, agentId: 'impl', action: 'git push' },
    { t: T + 2, kind: 'agent_done', sessionId: S, agentId: 'impl' },
    { t: T + 3, kind: 'agent_done', sessionId: S, agentId: 'other' },
  ]);
  const later = T + 3 + HANDBACK_TTL_MS + 5000;
  const v1 = derive(s1, later);
  assert.ok(v1.agents.impl, 'the holder is still drawn after the TTL');
  assert.equal(v1.agents.impl.holdingAt, 'direction');
  assert.equal(v1.agents.other, undefined, 'a plain handback is still pruned after the TTL');
  const s2 = reduce(s1, { t: later, kind: 'user_message', sessionId: S });
  // Phase 5a: once answered, the finished holder walks out (LEAVE_MS) instead of vanishing at once.
  assert.equal(derive(s2, later).agents.impl.leaving, true, 'answered: walks out');
  assert.equal(derive(s2, later + LEAVE_MS).agents.impl, undefined, 'gone after the walk-out');
});

test('a BLOCKED merge handback names the handback agent as the holder', () => {
  const owners = new Map();
  const line = {
    type: 'assistant',
    timestamp: '2026-10-18T10:00:00.000Z',
    message: { content: [{ type: 'tool_use', id: 'toolu_h', name: 'SubagentHandback', input: { message: 'STATUS: BLOCKED\nNo puedo hacer git push sin tu OK' } }] },
  };
  const evs = normalizeLine(line, { sessionId: S, agentId: 'impl', isMain: false, owners, subagentType: 'implement-agent' });
  const approval = evs.find((e) => e.kind === 'approval_pending');
  assert.equal(approval?.agentId, 'impl');
  const s = run([spawn('impl', 'implement-agent'), ...evs]);
  assert.equal(s.agents.impl.holdingAt, 'direction');
});

test('normalize: a git merge in a subagent carries its agent id and keeps its own tool bubble', () => {
  const line = parseLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-18T10:00:00.000Z',
    message: { content: [{ type: 'tool_use', id: 'toolu_m', name: 'Bash', input: { command: 'git merge main', description: 'Integrar main' } }] },
  }));
  const evs = normalizeLine(line, { sessionId: S, agentId: 'impl', isMain: false, owners: new Map(), subagentType: 'implement-agent' });
  assert.deepEqual(evs.filter((e) => e.kind === 'approval_pending').map((e) => [e.agentId, e.action]), [['impl', 'git merge']]);
  assert.equal(evs.filter((e) => e.kind === 'tool_start').length, 1);
});

test('normalize: the Conductor git merge emits the approval with its id but never a tool_start (never drawn executing git)', () => {
  const line = parseLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-18T10:00:00.000Z',
    message: { content: [{ type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { command: 'git merge main', description: 'Integrar main' } }] },
  }));
  const evs = normalizeLine(line, { sessionId: S, agentId: S, isMain: true, owners: new Map() });
  assert.deepEqual(evs.map((e) => e.kind), ['approval_pending']);
  assert.equal(evs[0].agentId, S);
});

test('normalize: a plain Conductor Bash (no approval action) still draws its tool', () => {
  const line = parseLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-18T10:00:00.000Z',
    message: { content: [{ type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: 'git status', description: 'Estado' } }] },
  }));
  const evs = normalizeLine(line, { sessionId: S, agentId: S, isMain: true, owners: new Map() });
  assert.deepEqual(evs.map((e) => e.kind), ['tool_start']);
});

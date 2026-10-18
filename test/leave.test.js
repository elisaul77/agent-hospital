// Phase 5a: finished agents walk out and disappear (LEAVE_MS after their handback); a holder waits at the Direction
// door until the user answers; the Conductor leaves only when its session has been idle for CONDUCTOR_IDLE_MS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, derive, EMPTY_STATE, IDLE_MS, LEAVE_MS, HANDBACK_TTL_MS, CONDUCTOR_IDLE_MS, parseConductorIdleMin } from '../src/state.js';

const T = 1_000_000;
const S = 'S';
const run = (evs) => evs.reduce((s, ev) => reduce(s, ev), EMPTY_STATE());
const spawn = (agentId, subagentType, t = T) => ({ t, kind: 'agent_spawn', sessionId: S, agentId, subagentType });
const done = (agentId, t) => ({ t, kind: 'agent_done', sessionId: S, agentId });

test('LEAVE_MS is the handback TTL: a few seconds of walk-out', () => {
  assert.equal(LEAVE_MS, HANDBACK_TTL_MS);
  assert.ok(LEAVE_MS >= 3000 && LEAVE_MS <= 6000);
});

test('a finished agent is marked leaving with goneAt, is drawn while walking out, and is gone at goneAt', () => {
  const s = run([spawn('c', 'council-spec'), done('c', T + 1000)]);
  assert.equal(s.agents.c.leaving, true);
  assert.equal(s.agents.c.goneAt, T + 1000 + LEAVE_MS);
  const walking = derive(s, T + 1000 + LEAVE_MS - 1);
  assert.equal(walking.agents.c.leaving, true);
  assert.equal(derive(s, T + 1000 + LEAVE_MS).agents.c, undefined);
});

test('every role walks out: council, architect, specialist, implement, review, planning', () => {
  for (const type of ['council-architect', 'council-risk', 'review-agent', 'implement-agent', 'planning-agent', 'AgentArchitect']) {
    const s = run([spawn('x', type), done('x', T + 10)]);
    assert.equal(derive(s, T + 10 + LEAVE_MS - 1).agents.x?.leaving, true, type);
    assert.equal(derive(s, T + 10 + LEAVE_MS).agents.x, undefined, type);
  }
});

test('a holder at the Direction door stays until the user answers, then walks out', () => {
  const s1 = run([
    spawn('impl', 'implement-agent'),
    { t: T + 1, kind: 'approval_pending', sessionId: S, agentId: 'impl', action: 'git push' },
    done('impl', T + 2),
  ]);
  const long = T + 2 + LEAVE_MS + 5000;
  const v1 = derive(s1, long);
  assert.ok(v1.agents.impl, 'the holder is still drawn after LEAVE_MS');
  assert.equal(v1.agents.impl.holdingAt, 'direction');
  assert.notEqual(v1.agents.impl.leaving, true);
  const s2 = reduce(s1, { t: long, kind: 'user_message', sessionId: S });
  assert.equal(derive(s2, long).agents.impl.leaving, true, 'answered: it walks out now');
  assert.equal(derive(s2, long + LEAVE_MS).agents.impl, undefined, 'and is gone after LEAVE_MS');
});

test('replayed old finished agents are never shown', () => {
  const s = run([spawn('old', 'implement-agent', T), done('old', T + 500)]);
  assert.equal(derive(s, T + 3_600_000).agents.old, undefined);
});

test('the Conductor stays while its session is active and leaves once the session is idle for CONDUCTOR_IDLE_MS', () => {
  const s = run([
    spawn('main', 'conductor', T),
    spawn('w', 'implement-agent', T + 1000),
    { t: T + 2000, kind: 'tool_start', sessionId: S, agentId: 'w', tool: 'Bash', label: 'npm test', toolUseId: 'u' },
  ]);
  const sessionT = T + 2000;
  assert.notEqual(derive(s, sessionT + CONDUCTOR_IDLE_MS - 1).agents.main.leaving, true);
  assert.equal(derive(s, sessionT + CONDUCTOR_IDLE_MS + 1).agents.main.leaving, true);
  assert.equal(derive(s, sessionT + CONDUCTOR_IDLE_MS + LEAVE_MS).agents.main, undefined);
});

test('CONDUCTOR_IDLE_MS defaults to 30 minutes (HOSPITAL_CONDUCTOR_IDLE_MIN)', () => {
  assert.equal(CONDUCTOR_IDLE_MS, 30 * 60_000);
});

test('the Conductor follows the configured idle time: 29 min stays, 30 min + 1 s walks out (default), 44 stays and 45 min + 1 s walks out at 45', () => {
  const s = run([spawn('main', 'conductor', T)]);
  assert.notEqual(derive(s, T + 29 * 60_000).agents.main.leaving, true);
  assert.equal(derive(s, T + 30 * 60_000 + 1000).agents.main.leaving, true);
  const m45 = { conductorIdleMs: 45 * 60_000 };
  assert.notEqual(derive(s, T + 44 * 60_000, m45).agents.main.leaving, true);
  assert.equal(derive(s, T + 45 * 60_000 + 1000, m45).agents.main.leaving, true);
  assert.equal(derive(s, T + 31 * 60_000).agents.main, undefined, 'and is gone after the walk-out');
});

test('parseConductorIdleMin: unset or empty is 30 min with no warning', () => {
  for (const raw of [undefined, '', '   ']) {
    assert.deepEqual(parseConductorIdleMin(raw), { ms: 30 * 60_000, minutes: 30, warning: null }, String(raw));
  }
});

test('parseConductorIdleMin: positive minutes are used as given', () => {
  assert.deepEqual(parseConductorIdleMin('45'), { ms: 45 * 60_000, minutes: 45, warning: null });
  assert.equal(parseConductorIdleMin(' 2.5 ').ms, 2.5 * 60_000);
});

test('parseConductorIdleMin: invalid, zero, negative, NaN or infinite is 30 min with a warning (never 0, never NaN)', () => {
  for (const raw of ['abc', '0', '-5', 'NaN', 'Infinity', '30m']) {
    const r = parseConductorIdleMin(raw);
    assert.equal(r.ms, 30 * 60_000, raw);
    assert.equal(r.minutes, 30, raw);
    assert.match(r.warning, /HOSPITAL_CONDUCTOR_IDLE_MIN/, raw);
    assert.match(r.warning, /using 30/, raw);
  }
});

test('a new event revives an agent that was walking out', () => {
  const s1 = run([spawn('r', 'review-agent'), done('r', T + 10)]);
  const s2 = reduce(s1, { t: T + 500, kind: 'tool_start', sessionId: S, agentId: 'r', tool: 'Read', label: 'x', toolUseId: 'u' });
  const v = derive(s2, T + 10 + LEAVE_MS + 1000);
  assert.ok(v.agents.r, 'still drawn');
  assert.notEqual(v.agents.r.leaving, true);
});

test('a subagent idle for IDLE_MS with no tool in flight walks out (no handback needed); a tool in flight keeps it', () => {
  const s = run([spawn('old', 'council-spec', T), spawn('busy', 'implement-agent', T),
    { t: T + 10, kind: 'tool_start', sessionId: S, agentId: 'busy', tool: 'Bash', label: 'npm test', toolUseId: 'u' }]);
  const later = T + IDLE_MS + 1000;
  const v = derive(s, later);
  assert.equal(v.agents.old.leaving, true, 'idle council member walks out');
  assert.equal(v.agents.busy.leaving, false, 'a working agent stays');
  assert.equal(derive(s, T + IDLE_MS + LEAVE_MS).agents.old, undefined, 'and is gone');
});

test('idle ticks prune an idle subagent from the stored state too (bounded memory)', () => {
  const s1 = run([spawn('old', 'council-risk', T)]);
  const s2 = reduce(s1, { t: T + IDLE_MS + LEAVE_MS + 1, kind: 'idle_tick' });
  assert.equal(s2.agents.old, undefined);
});

// Phase 5 hardening: finite and at least 1 minute (0.5 min and overflowing values fall back with a warning).
test('parseConductorIdleMin: values below 1 minute and non-finite minute counts fall back to 30 with a warning', () => {
  for (const raw of ['0.5', '0.99', '1e308', '1e-9']) {
    const r = parseConductorIdleMin(raw);
    assert.equal(r.ms, 30 * 60_000, raw);
    assert.equal(r.minutes, 30, raw);
    assert.match(r.warning, /HOSPITAL_CONDUCTOR_IDLE_MIN/, raw);
  }
  assert.deepEqual(parseConductorIdleMin('1'), { ms: 60_000, minutes: 1, warning: null });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, derive, EMPTY_STATE, IDLE_MS, STALL_MS, HANDBACK_TTL_MS, LEAVE_MS, CONDUCTOR_IDLE_MS } from '../src/state.js';

const T0 = 1_000_000;
const run = (events) => events.reduce((s, ev) => reduce(s, ev), EMPTY_STATE());
const spawn = (agentId, subagentType, t = T0, extra = {}) =>
  ({ t, kind: 'agent_spawn', sessionId: 's1', agentId, subagentType, ...extra });

test('spawn places each role in its room', () => {
  const s = run([
    spawn('main', 'conductor'),
    spawn('p', 'planning-agent'),
    spawn('i', 'implement-agent'),
    spawn('r', 'review-agent'),
    spawn('c', 'council-risk'),
    spawn('x', 'Explore'),
    spawn('a', 'AgentArchitect'),
    spawn('cx', 'codex-agent', T0, { mode: 'review' }),
  ]);
  assert.equal(s.agents.main.room, 'reception');
  assert.equal(s.agents.p.room, 'diagnosis');
  assert.equal(s.agents.i.room, 'operating');
  assert.equal(s.agents.r.room, 'radiology');
  assert.equal(s.agents.c.room, 'council');
  assert.equal(s.agents.x.room, 'specialists');
  assert.equal(s.agents.a.room, 'architect');
  assert.equal(s.agents.cx.room, 'radiology');
});

test('case transitions follow the brief (table-driven)', () => {
  const cases = [
    { name: 'planning moves case to diagnosis', evs: [spawn('p', 'planning-agent')], room: 'diagnosis' },
    { name: 'implement moves case to operating', evs: [spawn('i', 'implement-agent')], room: 'operating' },
    {
      name: 'review FAILED/implementation returns to operating',
      evs: [spawn('r', 'review-agent'), { t: T0 + 1, kind: 'agent_done', agentId: 'r', verdict: 'FAILED', failureOrigin: 'implementation' }],
      room: 'operating',
    },
    {
      name: 'review FAILED/hypothesis returns to diagnosis',
      evs: [spawn('r', 'review-agent'), { t: T0 + 1, kind: 'agent_done', agentId: 'r', verdict: 'FAILED', failureOrigin: 'hypothesis' }],
      room: 'diagnosis',
    },
    {
      name: 'review FAILED/scope returns to triage',
      evs: [spawn('r', 'review-agent'), { t: T0 + 1, kind: 'agent_done', agentId: 'r', verdict: 'FAILED', failureOrigin: 'scope' }],
      room: 'triage',
    },
    {
      name: 'APPROVED on last phase discharges',
      evs: [spawn('r', 'review-agent'), { t: T0 + 1, kind: 'agent_done', agentId: 'r', verdict: 'APPROVED', final: true }],
      room: 'discharge',
      status: 'discharged',
    },
    {
      name: 'case_status STOPPED stops the case',
      evs: [{ t: T0, kind: 'triage', sessionId: 's1', tier: 'M', caseKind: 'feature' }, { t: T0 + 1, kind: 'case_status', sessionId: 's1', status: 'STOPPED' }],
      room: 'stopped',
      status: 'stopped',
    },
  ];
  for (const c of cases) {
    const s = run(c.evs);
    assert.equal(s.cases.s1.room, c.room, c.name);
    if (c.status) assert.equal(s.cases.s1.status, c.status, c.name);
  }
});

test('an agent is in exactly one room and tool_end clears the tool', () => {
  const s = run([
    spawn('i', 'implement-agent'),
    { t: T0 + 1, kind: 'tool_start', agentId: 'i', tool: 'Edit', label: 'src/state.js', toolUseId: 'u1' },
    { t: T0 + 2, kind: 'tool_end', agentId: 'i', toolUseId: 'u1' },
  ]);
  assert.equal(s.agents.i.tool, null);
  assert.equal(s.agents.i.status, 'thinking');
});

test('unknown event kind and unknown agent throw with context', () => {
  assert.throws(() => reduce(EMPTY_STATE(), { t: T0, kind: 'nope' }), /unknown event kind: nope/);
  assert.throws(() => reduce(EMPTY_STATE(), { t: T0, kind: 'tool_start', agentId: 'ghost', tool: 'Read', label: '' }), /unknown agent ghost/);
});

test('derive: sleeping after idle, stalled after long tool, handback pruned', () => {
  const s = run([
    spawn('i', 'implement-agent'),
    { t: T0 + 1, kind: 'tool_start', agentId: 'i', tool: 'Bash', label: 'npm test', toolUseId: 'u1' },
    spawn('h', 'review-agent'),
    { t: T0 + 2, kind: 'agent_done', agentId: 'h' },
  ]);
  const idle = derive(s, T0 + IDLE_MS + 10);
  assert.equal(idle.agents.i.sleeping, true);
  const stalled = derive(s, T0 + 1 + STALL_MS + 10);
  assert.equal(stalled.agents.i.stalled, true);
  const gone = derive(s, T0 + 2 + HANDBACK_TTL_MS + 10);
  assert.equal(gone.agents.h, undefined);
  assert.ok(gone.agents.i, 'working agent is kept');
});

test('state is not mutated by reduce', () => {
  const before = run([spawn('main', 'conductor')]);
  const snapshot = JSON.stringify(before);
  reduce(before, spawn('p', 'planning-agent'));
  assert.equal(JSON.stringify(before), snapshot);
});

test('revisions exhausted (more than 2 implementation loops) escalate to reception, then STOPPED stops the case', () => {
  const loop = (k) => [
    spawn(`i${k}`, 'implement-agent'),
    spawn(`r${k}`, 'review-agent'),
    { t: T0 + k, kind: 'agent_done', agentId: `r${k}`, verdict: 'NEEDS_REVISION' },
  ];
  let s = run([...loop(1), ...loop(2)]);
  assert.equal(s.cases.s1.room, 'operating', 'two loops are still allowed');
  assert.equal(s.cases.s1.status, 'active');
  s = reduce(s, spawn('i3', 'implement-agent'));
  s = reduce(s, spawn('r3', 'review-agent'));
  s = reduce(s, { t: T0 + 3, kind: 'agent_done', agentId: 'r3', verdict: 'NEEDS_REVISION' });
  assert.equal(s.cases.s1.room, 'reception');
  assert.equal(s.cases.s1.status, 'escalated');
  s = reduce(s, { t: T0 + 4, kind: 'case_status', sessionId: 's1', status: 'STOPPED' });
  assert.equal(s.cases.s1.room, 'stopped');
  assert.equal(s.cases.s1.status, 'stopped');
});

// ---- Phase 4b: plan phases (derived view), NEEDS_REVISION, final discharge, undercount, consult isolation ----
const PLAN3 = [{ id: '1', title: 'Intake' }, { id: '2', title: 'Build' }, { id: '3', title: 'Ship' }];
const triagePlan = (plan, t = T0) => ({ t, kind: 'triage', sessionId: 's1', tier: 'L', caseKind: 'feature', phases: plan });
const approve = (k, final = false, t = T0) => [
  spawn(`r${k}`, 'review-agent', t),
  { t: t + 1, kind: 'agent_done', agentId: `r${k}`, verdict: 'APPROVED', final },
];
const phaseStates = (s, now = T0 + 100) => derive(s, now).cases.s1.phases.map((p) => p.state);
const consult = (id, specialty, t = T0) => spawn(id, 'review-agent', t, { mode: 'consult', specialty });

test('derived phase states follow phasesDone (table-driven, 3 phases)', () => {
  const rows = [
    { done: 0, want: ['current', 'waiting', 'waiting'] },
    { done: 1, want: ['done', 'current', 'waiting'] },
    { done: 2, want: ['done', 'done', 'current'] },
    { done: 3, want: ['done', 'done', 'done'] },
  ];
  for (const row of rows) {
    const evs = [triagePlan(PLAN3)];
    for (let k = 1; k <= row.done; k++) evs.push(...approve(k, false, T0 + 10 * k));
    const s = run(evs);
    assert.equal(s.cases.s1.phasesDone, row.done);
    assert.deepEqual(phaseStates(s), row.want, `phasesDone=${row.done}`);
  }
});

test('derived phases carry id, title and state', () => {
  const s = run([triagePlan(PLAN3), ...approve(1, false, T0 + 10)]);
  assert.deepEqual(derive(s, T0 + 100).cases.s1.phases, [
    { id: '1', title: 'Intake', state: 'done' },
    { id: '2', title: 'Build', state: 'current' },
    { id: '3', title: 'Ship', state: 'waiting' },
  ]);
});

test('a case without a plan has no phases', () => {
  const s = run([{ t: T0, kind: 'triage', sessionId: 's1', tier: 'M', caseKind: 'fix' }]);
  assert.deepEqual(derive(s, T0).cases.s1.phases, []);
});

test('derive is pure: the state is unchanged and phases exist only in the view', () => {
  const s = run([triagePlan(PLAN3), ...approve(1, false, T0 + 10)]);
  const before = JSON.stringify(s);
  const v = derive(s, T0 + 20);
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.cases.s1.phases, undefined);
  assert.equal(v.cases.s1.phases.length, 3);
});

test('triage carries the plan; the reducer drops invalid phase ids', () => {
  const s = run([triagePlan([{ id: 'x y', title: 'bad' }, { id: '2', title: 'Good' }])]);
  assert.deepEqual(derive(s, T0).cases.s1.phases, [{ id: '2', title: 'Good', state: 'current' }]);
});

test('NEEDS_REVISION: the current patient goes back to operating and is not discharged', () => {
  const s = run([
    triagePlan(PLAN3),
    ...approve(1, false, T0 + 10),
    spawn('i2', 'implement-agent', T0 + 20),
    spawn('r2', 'review-agent', T0 + 30),
    { t: T0 + 31, kind: 'agent_done', agentId: 'r2', verdict: 'NEEDS_REVISION' },
  ]);
  assert.equal(s.cases.s1.room, 'operating');
  assert.equal(s.cases.s1.status, 'active');
  assert.equal(s.cases.s1.phasesDone, 1);
  assert.deepEqual(phaseStates(s), ['done', 'current', 'waiting']);
});

test('final discharge marks every remaining patient done (discharged), none current', () => {
  const s = run([triagePlan(PLAN3), ...approve(1, true, T0 + 10)]);
  assert.equal(s.cases.s1.status, 'discharged');
  assert.deepEqual(phaseStates(s), ['done', 'done', 'done']);
});

test('undercount after restart (documented limit): approvals before the window are never counted', () => {
  // Phases 1 and 2 were approved before the window; only work on phase 3 is seen, so phase 1 shows as current.
  const s = run([triagePlan(PLAN3), spawn('i3', 'implement-agent', T0 + 10)]);
  assert.equal(s.cases.s1.phasesDone, 0);
  assert.deepEqual(phaseStates(s), ['current', 'waiting', 'waiting']);
});

test('consult: a specialist at its specialty desk, never a reviewer, and it does not move the case', () => {
  const s = run([triagePlan(PLAN3), spawn('i2', 'implement-agent', T0 + 5), consult('c1', 'cost', T0 + 10)]);
  assert.equal(s.agents.c1.reviewer, false);
  assert.equal(s.agents.c1.consult, true);
  assert.equal(s.agents.c1.room, 'specialists');
  assert.equal(s.agents.c1.specialty, 'cost');
  assert.equal(s.cases.s1.room, 'operating');
});

test('consult: a missing or invalid specialty gives the generic specialist desk', () => {
  const s = run([triagePlan(PLAN3), consult('c1', '../x', T0 + 10), consult('c2', undefined, T0 + 11)]);
  assert.equal(s.agents.c1.specialty, null);
  assert.equal(s.agents.c2.specialty, null);
  assert.equal(s.agents.c1.room, 'specialists');
});

test('consult handback APPROVED or FAILED leaves the case deep-equal before and after', () => {
  for (const verdict of ['APPROVED', 'FAILED']) {
    const base = run([triagePlan(PLAN3), spawn('i2', 'implement-agent', T0 + 5), consult('c1', 'perf', T0 + 10)]);
    const before = structuredClone(base.cases);
    const after = reduce(base, { t: T0 + 11, kind: 'agent_done', agentId: 'c1', verdict, failureOrigin: 'implementation', final: true });
    assert.deepEqual(after.cases, before, verdict);
    assert.deepEqual(after.escalations, base.escalations, verdict);
    assert.equal(after.agents.c1.status, 'handback');
  }
});

test('consult never rings the bell: a blocked handback or an approval request is ignored', () => {
  const s = run([triagePlan(PLAN3), consult('c1', 'cost', T0 + 10)]);
  const before = structuredClone(s.cases);
  let next = reduce(s, { t: T0 + 11, kind: 'agent_done', agentId: 'c1', blocked: true });
  next = reduce(next, { t: T0 + 12, kind: 'approval_pending', sessionId: 's1', agentId: 'c1', action: 'git push' });
  assert.deepEqual(next.escalations, []);
  assert.deepEqual(next.cases, before);
  assert.equal(next.agents.c1.holdingAt, undefined, 'a consult never walks to the Direction door');
});

// ---- Phase 4b revision: max(transcripts, state.md header) and COMPLETE -> all done (view only) ----
const withFile = (plan, file, t = T0) => ({ ...triagePlan(plan, t), filePhasesDone: file.count, fileComplete: file.complete });

test('max(transcripts, state.md): the file count wins when the window missed the approvals', () => {
  const s = run([withFile(PLAN3, { count: 2, complete: false })]);
  assert.equal(s.cases.s1.phasesDone, 0);
  assert.deepEqual(phaseStates(s), ['done', 'done', 'current']);
});

test('max(transcripts, state.md): the transcripts win when they are ahead of the file', () => {
  const s = run([withFile(PLAN3, { count: 1, complete: false }), ...approve(1, false, T0 + 10), ...approve(2, false, T0 + 20)]);
  assert.equal(s.cases.s1.phasesDone, 2);
  assert.deepEqual(phaseStates(s), ['done', 'done', 'current']);
});

test('max(transcripts, state.md): the file count never moves a transcript counter back', () => {
  const s = run([...approve(1, false, T0 + 10), ...approve(2, false, T0 + 20), withFile(PLAN3, { count: 1, complete: false }, T0 + 30)]);
  assert.equal(s.cases.s1.phasesDone, 2);
  assert.deepEqual(phaseStates(s), ['done', 'done', 'current']);
});

test('state.md: a file count is clamped to the plan length and ignores non-integers', () => {
  assert.deepEqual(phaseStates(run([withFile(PLAN3, { count: 99, complete: false })])), ['done', 'done', 'done']);
  assert.deepEqual(phaseStates(run([withFile(PLAN3, { count: -1, complete: false })])), ['current', 'waiting', 'waiting']);
  const malformed = { ...triagePlan(PLAN3), filePhasesDone: 'two' };
  assert.deepEqual(phaseStates(run([malformed])), ['current', 'waiting', 'waiting']);
});

test('state.md: a missing header count keeps the transcript count only', () => {
  const s = run([triagePlan(PLAN3), ...approve(1, false, T0 + 10)]);
  assert.deepEqual(phaseStates(s), ['done', 'current', 'waiting']);
});

test('COMPLETE in state.md: every patient done, none current; the case status and room do not change', () => {
  const s = run([withFile(PLAN3, { count: 0, complete: true })]);
  assert.deepEqual(phaseStates(s), ['done', 'done', 'done']);
  const plain = run([withFile(PLAN3, { count: 0, complete: false })]);
  assert.equal(s.cases.s1.status, 'active');
  assert.equal(s.cases.s1.room, plain.cases.s1.room);
});

test('COMPLETE is recomputed, not sticky: a later read without COMPLETE returns to the file count', () => {
  const s = run([withFile(PLAN3, { count: 0, complete: true }), withFile(PLAN3, { count: 1, complete: false }, T0 + 10)]);
  assert.deepEqual(phaseStates(s), ['done', 'current', 'waiting']);
});

test('the view never exposes the file fields (derive keeps the case shape)', () => {
  const v = derive(run([withFile(PLAN3, { count: 1, complete: true })]), T0 + 100).cases.s1;
  assert.equal(v.filePhasesDone, undefined);
  assert.equal(v.fileComplete, undefined);
  assert.equal(v.planPhases, undefined);
});

test('a warning raised after the file count is labelled with the current patient (max count, not the window count)', () => {
  const s = run([withFile(PLAN3, { count: 2, complete: false }), { t: T0 + 10, kind: 'warning_open', sessionId: 's1', agentId: 'i1', items: ['Riesgo sin medir'] }]);
  const w = s.cases.s1.warnings[0];
  assert.equal(w.phase, 3);
});

// Phase 3 (hospital-5b1): idle Conductors are pruned from reducer storage; storage stays bounded.
test('idle_tick prunes an idle Conductor with no children once it has walked out, and keeps it before', () => {
  const s1 = run([spawn('main', 'conductor', T0)]);
  const goneAt = T0 + CONDUCTOR_IDLE_MS + LEAVE_MS;
  assert.ok(reduce(s1, { t: goneAt - 1, kind: 'idle_tick' }).agents.main, 'still stored while walking out');
  assert.equal(reduce(s1, { t: goneAt, kind: 'idle_tick' }).agents.main, undefined, 'pruned at walk-out end');
});

test('idle_tick prunes with the configured conductorIdleMs (carried on the tick)', () => {
  const s1 = run([spawn('main', 'conductor', T0)]);
  const short = 5 * 60_000;
  assert.equal(reduce(s1, { t: T0 + short + LEAVE_MS, kind: 'idle_tick', conductorIdleMs: short }).agents.main, undefined);
  assert.ok(reduce(s1, { t: T0 + short + LEAVE_MS, kind: 'idle_tick' }).agents.main, 'default 30 min keeps it');
});

test('a Conductor with a child in its session is never pruned by time (a holder at the Direction door)', () => {
  const s1 = run([
    spawn('main', 'conductor', T0),
    spawn('impl', 'implement-agent', T0),
    { t: T0 + 1, kind: 'approval_pending', sessionId: 's1', agentId: 'impl', action: 'git push' },
  ]);
  const late = T0 + CONDUCTOR_IDLE_MS + LEAVE_MS + 60_000;
  const s2 = reduce(s1, { t: late, kind: 'idle_tick' });
  assert.ok(s2.agents.main, 'conductor kept while a child is present');
  assert.ok(s2.agents.impl, 'holder kept');
});

test('a pruned Conductor is re-created by the first event of its session (resumed session)', () => {
  // The main transcript's agent id is its session id (tail.js), so the Conductor is 's1' here.
  const s1 = run([spawn('s1', 'conductor', T0)]);
  const s2 = reduce(s1, { t: T0 + CONDUCTOR_IDLE_MS + LEAVE_MS, kind: 'idle_tick' });
  assert.equal(s2.agents.s1, undefined);
  const resumed = T0 + CONDUCTOR_IDLE_MS + LEAVE_MS + 5000;
  const s3 = reduce(s2, { t: resumed, kind: 'tool_start', sessionId: 's1', agentId: 's1', tool: 'Read', label: 'x', toolUseId: 'u' });
  assert.equal(s3.agents.s1.role, 'conductor');
  assert.equal(s3.agents.s1.status, 'working');
  assert.notEqual(derive(s3, resumed).agents.s1.leaving, true, 'a resumed Conductor is not walking out');
});

test('an unknown agent that is not a session Conductor still throws', () => {
  assert.throws(() => reduce(EMPTY_STATE(), { t: T0, kind: 'tool_start', sessionId: 's1', agentId: 'ghost', tool: 'Read', label: '' }), /unknown agent ghost/);
});

test('1000 synthetic sessions: stored agents stay bounded and the storage empties after the last session idles out', () => {
  const SESSIONS = 1000;
  const GAP = 60_000;
  const events = [];
  for (let i = 0; i < SESSIONS; i += 1) {
    const sid = `sess-${i}`;
    const t = T0 + i * GAP;
    events.push({ t, kind: 'agent_spawn', sessionId: sid, agentId: sid, subagentType: 'conductor', parentAgentId: null });
    events.push({ t, kind: 'agent_spawn', sessionId: sid, agentId: `${sid}-c`, subagentType: 'council-spec', parentAgentId: sid });
  }
  const end = T0 + (SESSIONS - 1) * GAP + CONDUCTOR_IDLE_MS + LEAVE_MS + 60_000;
  let s = EMPTY_STATE();
  let maxStored = 0;
  let next = 0;
  for (let tick = T0; tick <= end; tick += 2000) {
    while (next < events.length && events[next].t <= tick) s = reduce(s, events[next++]);
    s = reduce(s, { t: tick, kind: 'idle_tick' });
    maxStored = Math.max(maxStored, Object.keys(s.agents).length);
  }
  assert.ok(maxStored <= 80, `stored agents peaked at ${maxStored}`);
  assert.equal(Object.keys(s.agents).length, 0, 'nothing left stored');
  assert.ok(Object.keys(s.cases).length <= 4, 'cases stay capped');
});

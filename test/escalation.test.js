// Escalation bell (Phase 4): reasons, dedupe, clearing on the next user message, Direction triggers, and
// the unruled dead-end (long-lived unruled items must be visible and escapable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, EMPTY_STATE, STALL_MS } from '../src/state.js';
import { approvalActionOf, approvalOfHandback, isBlockedHandback, ESCALATION_LABEL } from '../src/escalation.js';

const S = 'case-1';
const run = (events) => events.reduce((s, ev) => reduce(s, ev), EMPTY_STATE());
const reasons = (s) => s.escalations.map((e) => e.reason);

test('every escalation reason has a label, including unruled', () => {
  for (const r of ['approve', 'blocked', 'failed', 'stall', 'ask_user', 'exhausted', 'unruled']) {
    assert.equal(typeof ESCALATION_LABEL[r], 'string', r);
    assert.ok(ESCALATION_LABEL[r].length > 0, r);
  }
});

test('approval_pending rings once per case and reason; a repeat does not ring again', () => {
  const s = run([
    { t: 1000, kind: 'approval_pending', sessionId: S, action: 'git merge' },
    { t: 2000, kind: 'approval_pending', sessionId: S, action: 'git merge' },
  ]);
  assert.deepEqual(reasons(s), ['approve']);
  assert.equal(s.cases[S].approval.action, 'git merge');
});

test('a user message clears that session escalations and approval; a later one rings again', () => {
  const s1 = run([
    { t: 1000, kind: 'approval_pending', sessionId: S, action: 'git push' },
    { t: 2000, kind: 'user_message', sessionId: S },
  ]);
  assert.deepEqual(s1.escalations, []);
  assert.equal(s1.cases[S].approval, null);
  const s2 = reduce(s1, { t: 3000, kind: 'approval_pending', sessionId: S, action: 'git push' });
  assert.deepEqual(reasons(s2), ['approve']);
});

test('unruled: a reviewer closing with an open item escalates, and the bell stays until the user answers', () => {
  const impl = { kind: 'agent_spawn', sessionId: S, agentId: 'i1', subagentType: 'implement-agent', t: 1 };
  const rev = { kind: 'agent_spawn', sessionId: S, agentId: 'r1', subagentType: 'review-agent', t: 2 };
  const s = run([
    impl,
    { t: 3, kind: 'warning_open', sessionId: S, agentId: 'i1', items: ['Riesgo sin medir'] },
    rev,
    { t: 4, kind: 'agent_done', sessionId: S, agentId: 'r1', verdict: 'APPROVED' },
  ]);
  assert.equal(s.cases[S].warnings[0].state, 'unruled');
  assert.deepEqual(reasons(s), ['unruled']);
  assert.equal(s.escalations[0].label, ESCALATION_LABEL.unruled);
  // A later per-item ruling resolves the item, but the escalation stays until the user answers.
  const r2 = reduce(s, { t: 5, kind: 'warning_ruling', sessionId: S, agentId: 'r1', index: 0, label: 'Riesgo sin medir', ruling: 'fixed' });
  assert.deepEqual(reasons(r2), ['unruled']);
  const cleared = reduce(r2, { t: 6, kind: 'user_message', sessionId: S });
  assert.deepEqual(cleared.escalations, []);
});

test('accepted risk: only an ACCEPTED_RISK line accepts an acceptable item and lifts the gate', () => {
  const base = [
    { kind: 'agent_spawn', sessionId: S, agentId: 'i1', subagentType: 'implement-agent', t: 1 },
    { t: 2, kind: 'warning_open', sessionId: S, agentId: 'i1', items: ['Nombre de sala por confirmar'] },
    { kind: 'agent_spawn', sessionId: S, agentId: 'r1', subagentType: 'review-agent', t: 3 },
    { t: 4, kind: 'warning_ruling', sessionId: S, agentId: 'r1', index: 0, label: 'Nombre de sala por confirmar', ruling: 'acceptable' },
    { t: 5, kind: 'agent_done', sessionId: S, agentId: 'r1', verdict: 'APPROVED', final: true },
  ];
  const held = run(base);
  assert.equal(held.cases[S].warnings[0].state, 'acceptable');
  assert.equal(held.cases[S].room, 'radiology');
  assert.equal(held.cases[S].held, 'discharge');
  const accepted = reduce(held, {
    t: 6, kind: 'risk_accepted', sessionId: S,
    items: [{ item: 'Nombre de sala por confirmar', userWords: 'ok, déjalo', date: '2026-10-18' }],
  });
  assert.equal(accepted.cases[S].warnings[0].state, 'accepted');
  assert.equal(accepted.cases[S].room, 'discharge');
  assert.equal(accepted.cases[S].accepted[0].userWords, 'ok, déjalo');
});

test('stall: a tool without an end for more than STALL_MS escalates once', () => {
  const base = run([
    { kind: 'agent_spawn', sessionId: S, agentId: 'i1', subagentType: 'implement-agent', t: 1 },
    { t: 1000, kind: 'tool_start', agentId: 'i1', tool: 'Bash', label: 'x', toolUseId: 'u1' },
  ]);
  const t = 1000 + STALL_MS + 1;
  const once = reduce(base, { t, kind: 'idle_tick' });
  assert.deepEqual(reasons(once), ['stall']);
  assert.deepEqual(reasons(reduce(once, { t: t + 2000, kind: 'idle_tick' })), ['stall']);
});

test('ask_user: a question with no later event for 15 s escalates; any event in between cancels it', () => {
  const q = run([{ t: 1000, kind: 'question', sessionId: S }]);
  assert.deepEqual(reasons(reduce(q, { t: 16000, kind: 'idle_tick' })), ['ask_user']);
  const answered = run([
    { kind: 'agent_spawn', sessionId: S, agentId: S, subagentType: 'conductor', t: 500 },
    { t: 1000, kind: 'question', sessionId: S },
    { t: 2000, kind: 'tool_start', agentId: S, tool: 'Read', label: 'x', toolUseId: 'u' },
  ]);
  assert.deepEqual(answered.escalations, []);
});

test('blocked and failed verdicts escalate; FAILED also keeps the case off Discharge', () => {
  const s = run([
    { kind: 'agent_spawn', sessionId: S, agentId: 'a', subagentType: 'planning-agent', t: 1 },
    { t: 2, kind: 'agent_done', sessionId: S, agentId: 'a', blocked: true },
    { kind: 'agent_spawn', sessionId: S, agentId: 'r', subagentType: 'review-agent', t: 3 },
    { t: 4, kind: 'agent_done', sessionId: S, agentId: 'r', verdict: 'FAILED', failureOrigin: 'hypothesis' },
  ]);
  assert.deepEqual(reasons(s).sort(), ['blocked', 'failed']);
  assert.equal(s.cases[S].room, 'diagnosis');
});

test('exhausted: revisions beyond the limit escalate once', () => {
  const ev = [{ kind: 'agent_spawn', sessionId: S, agentId: 'i', subagentType: 'implement-agent', t: 1 }];
  let t = 2;
  for (let k = 0; k < 3; k++) {
    ev.push({ t: t++, kind: 'agent_done', sessionId: S, agentId: 'i', verdict: 'NEEDS_REVISION' });
  }
  const s = run(ev);
  assert.equal(s.cases[S].status, 'escalated');
  assert.deepEqual(reasons(s), ['exhausted']);
});

test('approval triggers: merge, push, docker push and npm publish; git merge-base and git log do not', () => {
  assert.equal(approvalActionOf('git merge main'), 'git merge');
  assert.equal(approvalActionOf('cd /x && git push origin main'), 'git push');
  assert.equal(approvalActionOf('docker push registry/app:1'), 'docker push');
  assert.equal(approvalActionOf('npm publish --access public'), 'npm publish');
  assert.equal(approvalActionOf('git merge-base main HEAD'), null);
  assert.equal(approvalActionOf('git log --oneline'), null);
  assert.equal(approvalActionOf('git status'), null);
});

test('approval triggers from a handback: only BLOCKED with a keyword counts', () => {
  assert.equal(approvalOfHandback('STATUS: BLOCKED\nNo puedo hacer git push sin tu OK'), 'push');
  assert.equal(approvalOfHandback('STATUS: BLOCKED\nmerge pendiente de decisión'), 'merge');
  assert.equal(approvalOfHandback('STATUS: BLOCKED\nFalta el fixture de pruebas'), null);
  assert.equal(approvalOfHandback('STATUS: DONE\nmerge listo'), null);
  assert.equal(isBlockedHandback('STATUS: BLOCKED\nx'), true);
  assert.equal(isBlockedHandback('STATUS: DONE\nNo escribas STATUS: BLOCKED aquí'), false);
});

test('unruled resolve path: a signed ACCEPTED_RISK line also settles an unruled item and releases the held close', () => {
  const held = run([
    { kind: 'agent_spawn', sessionId: S, agentId: 'i1', subagentType: 'implement-agent', t: 1 },
    { t: 2, kind: 'warning_open', sessionId: S, agentId: 'i1', items: ['Riesgo sin medir'] },
    { kind: 'agent_spawn', sessionId: S, agentId: 'r1', subagentType: 'review-agent', t: 3 },
    { t: 4, kind: 'agent_done', sessionId: S, agentId: 'r1', verdict: 'APPROVED', final: true },
  ]);
  assert.equal(held.cases[S].warnings[0].state, 'unruled');
  assert.equal(held.cases[S].held, 'discharge');
  const signed = reduce(held, {
    t: 5, kind: 'risk_accepted', sessionId: S,
    items: [{ item: 'Riesgo sin medir', userWords: 'ok', date: '2026-10-18' }],
  });
  assert.equal(signed.cases[S].warnings[0].state, 'accepted');
  assert.equal(signed.cases[S].room, 'discharge');
});

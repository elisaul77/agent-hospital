// Phase 5a escalation rules (deferred from Phase 4), tokens and hashes only:
//  - two consecutive implement handbacks with STATUS PARTIAL and no files changed -> stall "sin progreso"
//  - the same REQUIRED_CHANGES (hash) from the reviewer twice in a row for one case -> stall "no converge"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, derive, EMPTY_STATE } from '../src/state.js';
import { normalizeLine, progressOf, requiredHashOf } from '../src/normalize.js';
import { ESCALATION_LABEL } from '../src/escalation.js';

const T = 2_000_000;
const S = 'S';
const run = (evs) => evs.reduce((s, ev) => reduce(s, ev), EMPTY_STATE({ trustedDemo: true }));
const spawn = (agentId, subagentType) => ({ t: T, kind: 'agent_spawn', sessionId: S, agentId, subagentType });
const handback = (agentId, t, extra) => ({ t, kind: 'agent_done', sessionId: S, agentId, ...extra });
const stalls = (s) => s.escalations.filter((e) => e.reason === 'stall').map((e) => e.label);
const PARTIAL_NO_FILES = { status: 'PARTIAL', filesChanged: false };

test('labels of the two rules exist and are the user-facing words', () => {
  assert.equal(ESCALATION_LABEL.stall, 'agente detenido >2 min');
  const s = run([spawn('i1', 'implement-agent'), spawn('i2', 'implement-agent'),
    handback('i1', T + 1, PARTIAL_NO_FILES), handback('i2', T + 2, PARTIAL_NO_FILES)]);
  assert.deepEqual(stalls(s), ['sin progreso']);
});

test('one PARTIAL handback with no files changed does not ring', () => {
  const s = run([spawn('i1', 'implement-agent'), handback('i1', T + 1, PARTIAL_NO_FILES)]);
  assert.deepEqual(stalls(s), []);
});

test('two PARTIAL handbacks that changed files do not ring', () => {
  const s = run([spawn('i1', 'implement-agent'), spawn('i2', 'implement-agent'),
    handback('i1', T + 1, { status: 'PARTIAL', filesChanged: true }), handback('i2', T + 2, { status: 'PARTIAL', filesChanged: true })]);
  assert.deepEqual(stalls(s), []);
});

test('a DONE handback between two empty PARTIALs resets the count', () => {
  const s = run([spawn('i1', 'implement-agent'), spawn('i2', 'implement-agent'), spawn('i3', 'implement-agent'),
    handback('i1', T + 1, PARTIAL_NO_FILES), handback('i2', T + 2, { status: 'DONE', filesChanged: false }),
    handback('i3', T + 3, PARTIAL_NO_FILES)]);
  assert.deepEqual(stalls(s), []);
});

test('the same REQUIRED_CHANGES hash from the reviewer twice in a row rings "no converge"', () => {
  const s = run([spawn('r1', 'review-agent'), spawn('r2', 'review-agent'),
    handback('r1', T + 1, { verdict: 'NEEDS_REVISION', requiredHash: 'h1' }),
    handback('r2', T + 2, { verdict: 'NEEDS_REVISION', requiredHash: 'h1' })]);
  assert.ok(stalls(s).includes('no converge'));
});

test('different REQUIRED_CHANGES hashes do not ring "no converge"', () => {
  const s = run([spawn('r1', 'review-agent'), spawn('r2', 'review-agent'),
    handback('r1', T + 1, { verdict: 'NEEDS_REVISION', requiredHash: 'h1' }),
    handback('r2', T + 2, { verdict: 'NEEDS_REVISION', requiredHash: 'h2' })]);
  assert.ok(!stalls(s).includes('no converge'));
});

test('a stall reason label does not hide the other stall label of the same case', () => {
  const s = run([spawn('i1', 'implement-agent'), spawn('i2', 'implement-agent'), spawn('r1', 'review-agent'), spawn('r2', 'review-agent'),
    handback('i1', T + 1, PARTIAL_NO_FILES), handback('i2', T + 2, PARTIAL_NO_FILES),
    handback('r1', T + 3, { verdict: 'NEEDS_REVISION', requiredHash: 'h' }), handback('r2', T + 4, { verdict: 'NEEDS_REVISION', requiredHash: 'h' })]);
  assert.deepEqual(stalls(s).sort(), ['no converge', 'sin progreso']);
});

test('progressOf: STATUS token and FILES_CHANGED presence, never the text', () => {
  assert.deepEqual(progressOf('STATUS: PARTIAL\nFILES_CHANGED: none\n'), { status: 'PARTIAL', filesChanged: false });
  assert.deepEqual(progressOf('STATUS: PARTIAL\nFILES_CHANGED:\n  - src/a.js:1-3 — tocado\n'), { status: 'PARTIAL', filesChanged: true });
  assert.deepEqual(progressOf('STATUS: PARTIAL\nFILES_CHANGED:\n\nREQUIRED_CHANGES: none\n'), { status: 'PARTIAL', filesChanged: false });
  assert.deepEqual(progressOf('STATUS: DONE\n'), { status: 'DONE', filesChanged: null });
  assert.deepEqual(progressOf('no status here'), { status: null, filesChanged: null });
});

test('requiredHashOf: same text (case and spacing aside) gives the same hash; none or absent gives null', () => {
  const a = requiredHashOf('REQUIRED_CHANGES: Arreglar el cálculo\n  - tocar state.js\nFILES_CHANGED: none\n');
  const b = requiredHashOf('REQUIRED_CHANGES:   arreglar el  cálculo\n  - tocar   state.js\nFILES_CHANGED: none\n');
  const c = requiredHashOf('REQUIRED_CHANGES: otra cosa\nFILES_CHANGED: none\n');
  assert.ok(a && /^[0-9a-f]+$/.test(a));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(requiredHashOf('REQUIRED_CHANGES: none\n'), null);
  assert.equal(requiredHashOf('STATUS: APPROVED\n'), null);
});

test('normalizeLine: handback events carry tokens and hashes, never the handback text', () => {
  const msg = 'STATUS: NEEDS_REVISION\nFAILURE_ORIGIN: implementation\nREQUIRED_CHANGES: SECRETWORD arreglar\nFILES_CHANGED: none\n';
  const obj = { type: 'assistant', timestamp: new Date(T).toISOString(),
    message: { content: [{ type: 'tool_use', id: 'u1', name: 'SubagentHandback', input: { message: msg } }] } };
  const evs = normalizeLine(obj, { sessionId: S, agentId: 'r1', owners: new Map(), subagentType: 'review-agent' });
  const done = evs.find((e) => e.kind === 'agent_done');
  assert.equal(done.verdict, 'NEEDS_REVISION');
  assert.equal(done.filesChanged, false);
  assert.match(done.requiredHash, /^[0-9a-f]+$/);
  assert.ok(!JSON.stringify(evs).includes('SECRETWORD'));
  assert.ok(derive(run([spawn('r1', 'review-agent'), ...evs]), T).agents.r1);
});

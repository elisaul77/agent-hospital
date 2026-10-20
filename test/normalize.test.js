// Parser tests against SANITIZED fixtures that mirror the real transcript shape (see plans/hospital-plan.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, normalizeLine, spawnEvents, verdictOf, modeOf, labelOf, opaqueToolId, ownerKey } from '../src/normalize.js';
import { reduce, EMPTY_STATE } from '../src/state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures');
const readLines = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8').split('\n').filter(Boolean);
const SECRETS = ['SYNTHETIC PROMPT', 'SECRET-DO-NOT-FORWARD', 'FAKE_TOKEN_123', 'SYNTHETIC RESULT', 'SECRET'];

test('noise line types are ignored, unknown types do not throw', () => {
  const owners = new Map();
  const ctx = { sessionId: 's', agentId: 's', isMain: true, owners };
  for (const type of ['attachment', 'api-request-blob', 'api-request-shape', 'queue-operation', 'something-new']) {
    assert.deepEqual(normalizeLine({ type, timestamp: '2026-10-18T10:00:00.000Z' }, ctx), [], type);
  }
});

test('parent Agent tool_use registers its owner without forwarding description or prompt', () => {
  const owners = new Map();
  const [line] = readLines('session-main.jsonl').slice(2, 3).map(parseLine);
  const events = normalizeLine(line, { sessionId: 'sess-fixture-1', agentId: 'sess-fixture-1', isMain: true, owners });
  assert.equal(owners.get(ownerKey('sess-fixture-1', 'toolu_fixture_review_1')), 'sess-fixture-1');
  const start = events.find((e) => e.kind === 'tool_start');
  assert.ok(start, 'tool_start emitted');
  assert.equal(start.tool, 'Agent');
  assert.equal(start.label, '');
  assert.equal(start.toolUseId, opaqueToolId('toolu_fixture_review_1'));
  assert.equal(start.t, Date.parse('2026-10-18T10:00:05.000Z'));
  const text = JSON.stringify(events);
  for (const s of SECRETS) assert.ok(!text.includes(s), `leaked: ${s}`);
});

test('untrusted tool ids never leave the normalizer verbatim, but still pair with results', () => {
  const secretId = 'SYNTHETIC_PRIVATE_TOOL_ID_SENTINEL_7301';
  const ctx = { sessionId: 's', agentId: 's', isMain: false, owners: new Map() };
  const assistant = normalizeLine({ type: 'assistant', timestamp: '2026-10-18T10:00:00Z',
    message: { content: [{ type: 'tool_use', id: secretId, name: 'Read', input: {} }] } }, ctx);
  const user = normalizeLine({ type: 'user', timestamp: '2026-10-18T10:00:01Z',
    message: { content: [{ type: 'tool_result', tool_use_id: secretId, content: 'private result' }] } }, ctx);
  assert.equal(assistant[0].toolUseId, user[0].toolUseId);
  assert.ok(!JSON.stringify([...assistant, ...user]).includes(secretId));
});

test('spawn links the child to exactly one parent through meta.toolUseId', () => {
  const owners = new Map([[ownerKey('sess-fixture-1', 'toolu_fixture_review_1'), 'sess-fixture-1']]);
  const meta = JSON.parse(fs.readFileSync(path.join(FIX, 'subagents/agent-fixrev1.meta.json'), 'utf8'));
  const evs = spawnEvents({ sessionId: 'sess-fixture-1', agentId: 'fixrev1', meta, t: 1, owners });
  const spawn = evs.find((e) => e.kind === 'agent_spawn');
  const link = evs.find((e) => e.kind === 'agent_link');
  assert.equal(spawn.subagentType, 'review-agent');
  assert.equal(spawn.parentAgentId, 'sess-fixture-1');
  assert.equal(spawn.description, '');
  assert.equal(link.toolUseId, opaqueToolId('toolu_fixture_review_1'));
  assert.equal(link.agentId, 'fixrev1');
});

test('spawn without a known parent falls back to the session and emits no link (team members)', () => {
  const evs = spawnEvents({ sessionId: 's9', agentId: 'alfa', meta: { agentType: 'alfa', spawnDepth: 0 }, t: 5, owners: new Map() });
  assert.deepEqual(evs.map((e) => e.kind), ['agent_spawn']);
  assert.equal(evs[0].parentAgentId, 's9');
});

test('a repeated tool id in another session cannot steal the parent link', () => {
  const owners = new Map([[ownerKey('session-a', 'shared-tool'), 'child-a']]);
  const [spawn] = spawnEvents({ sessionId: 'session-b', agentId: 'child-b',
    meta: { agentType: 'planning-agent', toolUseId: 'shared-tool' }, t: 1, owners });
  assert.equal(spawn.parentAgentId, 'session-b');
});

test('child tool_use forwards tool name and a safe label, tool_result closes the tool', () => {
  const owners = new Map();
  const ctx = { sessionId: 'sess-fixture-1', agentId: 'fixrev1', isMain: false, owners };
  const lines = readLines('subagents/agent-fixrev1.jsonl').map(parseLine);
  const bash = normalizeLine(lines[2], ctx);
  assert.equal(bash[0].kind, 'tool_start');
  assert.equal(bash[0].tool, 'Bash');
  assert.equal(bash[0].label, '', 'Bash description and command are private');
  const end = normalizeLine(lines[3], ctx);
  assert.deepEqual(end, [{ t: Date.parse('2026-10-18T10:00:09.000Z'), kind: 'tool_end', sessionId: 'sess-fixture-1', agentId: 'fixrev1', toolUseId: opaqueToolId('toolu_fixture_bash_1') }]);
  const read = normalizeLine(lines[4], ctx)[0];
  assert.equal(read.tool, 'Read');
  assert.equal(read.label, 'src/state.js', 'file paths are cut to the last two segments');
  const text = JSON.stringify([bash, end, read]);
  for (const s of SECRETS) assert.ok(!text.includes(s), `leaked: ${s}`);
});

test('SubagentHandback yields agent_done with verdict and failure origin for review-agent', () => {
  const ctx = { sessionId: 'sess-fixture-1', agentId: 'fixrev1', isMain: false, owners: new Map(), subagentType: 'review-agent', mode: undefined };
  const hb = normalizeLine(parseLine(readLines('subagents/agent-fixrev1.jsonl')[6]), ctx);
  const done = hb.find((e) => e.kind === 'agent_done');
  assert.equal(done.agentId, 'fixrev1');
  assert.equal(done.verdict, 'FAILED');
  assert.equal(done.failureOrigin, 'implementation');
  assert.ok(!JSON.stringify(hb).includes('SYNTHETIC finding'), 'findings text is not forwarded');
});

test('codex-agent handback in review mode: APPROVED with origin none becomes null', () => {
  const ctx = { sessionId: 'sess-fixture-1', agentId: 'fixcodex1', isMain: false, owners: new Map(), subagentType: 'codex-agent', mode: 'review' };
  const hb = normalizeLine(parseLine(readLines('subagents/agent-fixcodex1.jsonl')[1]), ctx);
  const done = hb.find((e) => e.kind === 'agent_done');
  assert.equal(done.verdict, 'APPROVED');
  assert.equal(done.failureOrigin, null);
});

test('verdict is parsed only for reviewers; planning STATUS lines do not move a case', () => {
  const msg = 'STATUS: APPROVED\nFAILURE_ORIGIN: none\n';
  assert.equal(verdictOf(msg, 'planning-agent', undefined), null);
  assert.deepEqual(verdictOf(msg, 'review-agent', undefined), { verdict: 'APPROVED', failureOrigin: null });
  assert.equal(verdictOf('no status here', 'review-agent', undefined), null);
  assert.equal(verdictOf('STATUS: MAYBE\n', 'review-agent', undefined), null, 'unknown verdict is ignored');
});

test('codex mode is read from the prompt prefix as a token only', () => {
  assert.equal(modeOf('mode=review SYNTHETIC CODEX PROMPT'), 'review');
  assert.equal(modeOf('mode=implement x'), 'implement');
  assert.equal(modeOf('mode=other x'), undefined);
  assert.equal(modeOf('Mode=implement x'), 'implement', 'real prompts also use a capital M');
  assert.equal(modeOf('mode=plan x'), undefined, 'plan/preflight/browser go to the specialist pool');
  assert.equal(modeOf('no prefix mode=review here at position beyond 200'.padEnd(300, '.') + 'mode=review'), undefined);
});

test('timestamps are UTC ISO parsed to epoch ms', () => {
  const [line] = readLines('session-main.jsonl').slice(1, 2).map(parseLine);
  const ev = normalizeLine(line, { sessionId: 's', agentId: 's', isMain: true, owners: new Map() });
  assert.deepEqual(ev, []);
  assert.equal(Date.parse(line.timestamp), Date.parse('2026-10-18T10:00:01.000Z'));
});

test('labels are single-line and at most 60 characters', () => {
  const label = labelOf('Bash', { command: 'x', description: `line1\nline2 ${'y'.repeat(100)}` });
  assert.ok(label.length <= 60);
  assert.ok(!label.includes('\n'));
  assert.equal(label, '');
  assert.equal(labelOf('Grep', { pattern: 'SECRET-DO-NOT-FORWARD' }), '');
  assert.equal(labelOf('Agent', { description: 'SECRET-DO-NOT-FORWARD' }), '');
  assert.equal(labelOf('Unknown', { anything: 'secret' }), '');
});

test('parseLine: blank line is null, malformed JSON throws with a short message', () => {
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('   '), null);
  assert.throws(() => parseLine('{"type":"assistant","message":'), /malformed/);
});

test('fixture replay through the reducer: spawn, tools, FAILED handback moves the case back to operating', () => {
  const owners = new Map();
  const events = [];
  const mainCtx = { sessionId: 'sess-fixture-1', agentId: 'sess-fixture-1', isMain: true, owners };
  events.push(...spawnEvents({ sessionId: 'sess-fixture-1', agentId: 'sess-fixture-1', meta: { agentType: 'conductor' }, t: 0, owners }));
  for (const l of readLines('session-main.jsonl')) events.push(...normalizeLine(parseLine(l), mainCtx));
  const subCtx = { sessionId: 'sess-fixture-1', agentId: 'fixrev1', isMain: false, owners, subagentType: 'review-agent', mode: undefined };
  const meta = JSON.parse(fs.readFileSync(path.join(FIX, 'subagents/agent-fixrev1.meta.json'), 'utf8'));
  events.push(...spawnEvents({ sessionId: 'sess-fixture-1', agentId: 'fixrev1', meta, t: 0, owners }));
  for (const l of readLines('subagents/agent-fixrev1.jsonl')) events.push(...normalizeLine(parseLine(l), subCtx));
  const state = events.reduce((s, ev) => reduce(s, ev), EMPTY_STATE({ trustedDemo: true }));
  assert.equal(state.agents.fixrev1.parentAgentId, 'sess-fixture-1');
  assert.equal(state.agents.fixrev1.status, 'handback');
  assert.equal(state.cases['sess-fixture-1'].verdict, 'FAILED');
  assert.equal(state.cases['sess-fixture-1'].room, 'operating');
});

test('implementer handback with WARNINGS opens warnings (items only, never the handback body)', () => {
  const owners = new Map();
  const lines = readLines('subagents/agent-fiximpl1.jsonl').map(parseLine);
  const ctx = { sessionId: 'sess-fixture-1', agentId: 'fiximpl1', subagentType: 'implement-agent', owners };
  const events = lines.flatMap((l) => normalizeLine(l, ctx));
  const open = events.find((e) => e.kind === 'warning_open');
  assert.ok(open, 'warning_open emitted');
  assert.deepEqual(open.items, ['Synthetic edge case without a test', 'Synthetic name to confirm with the user']);
  assert.ok(!events.some((e) => e.kind === 'warning_ruling'));
  const done = events.find((e) => e.kind === 'agent_done');
  assert.equal(done.verdict, undefined, 'implementers carry no verdict');
  const text = JSON.stringify(events);
  for (const s of SECRETS.concat(['STATUS: DONE', 'NEXT: complete'])) assert.ok(!text.includes(s), `leaked: ${s}`);
});

// ---- Phase 4b: consult (review-agent mode=consult specialty=x) is a non-reviewer specialist ----
const normalize4b = await import('../src/normalize.js');
const { specialtyOf } = normalize4b;

test('consult mode and specialty come from the prompt prefix (token only, lowercased, validated)', () => {
  assert.equal(modeOf('mode=consult specialty=cost SYNTHETIC PROMPT'), 'consult');
  assert.equal(specialtyOf('mode=consult specialty=COST SYNTHETIC PROMPT'), 'cost', 'lowercased');
  assert.equal(specialtyOf('mode=consult specialty=ops-2 x'), 'ops-2');
  assert.equal(specialtyOf('mode=consult specialty=../etc x'), null, 'traversal token rejected');
  assert.equal(specialtyOf(`mode=consult specialty=${'a'.repeat(24)} x`), 'a'.repeat(24));
  assert.equal(specialtyOf(`mode=consult specialty=${'a'.repeat(25)} x`), null, 'longer than 24 chars');
  assert.equal(specialtyOf('mode=consult x'), null, 'missing specialty');
  assert.equal(specialtyOf('mode=review specialty=cost'), null, 'specialty is read for consult only');
  assert.equal(specialtyOf(`${'x'.repeat(250)} mode=consult specialty=cost`), null, 'beyond the first 200 chars');
});

test('consult handback is not a verdict and opens no warnings or approvals', () => {
  const ctx = { sessionId: 's', agentId: 'c1', isMain: false, owners: new Map(), subagentType: 'review-agent', mode: 'consult' };
  const msg = 'STATUS: FAILED\nFAILURE_ORIGIN: implementation\nWARNINGS_RULING:\n- x: must fix\nNEXT: complete';
  const line = { type: 'assistant', timestamp: '2026-10-18T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'SubagentHandback', input: { message: msg } }] } };
  const evs = normalizeLine(line, ctx);
  assert.deepEqual(evs.map((e) => e.kind), ['agent_done']);
  assert.equal(evs[0].verdict, undefined);
  assert.equal(evs[0].blocked, undefined);
  assert.equal(verdictOf(msg, 'review-agent', 'consult'), null);
});

test('consult Bash git push is shown as a tool only, never as an approval request', () => {
  const ctx = { sessionId: 's', agentId: 'c1', isMain: false, owners: new Map(), subagentType: 'review-agent', mode: 'consult' };
  const line = { type: 'assistant', timestamp: '2026-10-18T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'git push', description: 'Push' } }] } };
  const evs = normalizeLine(line, ctx);
  assert.equal(evs.some((e) => e.kind === 'approval_pending'), false);
  assert.equal(evs.find((e) => e.kind === 'tool_start').label, '');
});

test('consult spawn forwards the specialty token and mode, nothing else from the prompt', () => {
  const meta = { agentType: 'review-agent', description: 'Cost check' };
  const evs = spawnEvents({ sessionId: 's', agentId: 'c1', meta, t: 1, owners: new Map(), mode: 'consult', specialty: 'cost' });
  const sp = evs.find((e) => e.kind === 'agent_spawn');
  assert.equal(sp.mode, 'consult');
  assert.equal(sp.specialty, 'cost');
  assert.ok(!JSON.stringify(evs).includes('SYNTHETIC PROMPT'));
});

test('only an explicit Skill tool invocation confirms subagent-pool', () => {
  const ctx = { sessionId: 'claude-test', agentId: 'claude-test', isMain: true, owners: new Map() };
  const line = (name, input) => ({ type: 'assistant', timestamp: '2026-10-20T03:00:00Z',
    message: { content: [{ type: 'tool_use', id: 'tool-1', name, input },
      { type: 'text', text: 'subagent-pool SECRET-DO-NOT-FORWARD' }] } });
  assert.equal(normalizeLine(line('Read', { skill: 'subagent-pool' }), ctx).some((e) => e.kind === 'workflow_confirmed'), false);
  const confirmed = normalizeLine(line('Skill', { skill: 'subagent-pool', prompt: 'SECRET-DO-NOT-FORWARD' }), ctx);
  assert.deepEqual(confirmed.filter((e) => e.kind === 'workflow_confirmed').map((e) =>
    ({ workflow: e.workflow, runtime: e.runtime, reason: e.reason })),
  [{ workflow: 'subagent-pool', runtime: 'claude', reason: 'skill_invocation' }]);
  assert.ok(!JSON.stringify(confirmed).includes('SECRET-DO-NOT-FORWARD'));
});

test('SendMessage recipient uses the Claude namespace without forwarding the body', () => {
  const ctx = { sessionId: 'claude-session', agentId: 'claude-sender', owners: new Map() };
  const line = { type: 'assistant', timestamp: '2026-10-20T03:00:00Z', message: { content: [
    { type: 'tool_use', id: 'send-1', name: 'SendMessage', input: { to: 'reviewer', message: 'SECRET-DO-NOT-FORWARD' } },
  ] } };
  const events = normalizeLine(line, ctx);
  assert.equal(events.find((e) => e.kind === 'message_send').to, 'claude-reviewer');
  assert.ok(!JSON.stringify(events).includes('SECRET-DO-NOT-FORWARD'));
});

test('free-form tool labels and child descriptions never expose a sentinel', () => {
  const ctx = { sessionId: 'claude-s', agentId: 'claude-s', owners: new Map() };
  const blocks = ['Bash', 'Grep', 'Glob', 'Agent', 'Task'].map((name, i) => ({ type: 'tool_use',
    id: `tool-${i}`, name, input: { description: 'SECRET-DO-NOT-FORWARD', pattern: 'SECRET-DO-NOT-FORWARD',
      command: 'SECRET-DO-NOT-FORWARD', prompt: 'SECRET-DO-NOT-FORWARD' } }));
  const events = normalizeLine({ type: 'assistant', timestamp: '2026-10-20T03:00:00Z',
    message: { content: blocks } }, ctx);
  assert.deepEqual(events.filter((e) => e.kind === 'tool_start').map((e) => e.tool),
    ['Bash', 'Grep', 'Glob', 'Agent', 'Task']);
  assert.ok(!JSON.stringify(events).includes('SECRET-DO-NOT-FORWARD'));
  assert.ok(!JSON.stringify(spawnEvents({ sessionId: 'claude-s', agentId: 'claude-c',
    meta: { agentType: 'review-agent', description: 'SECRET-DO-NOT-FORWARD' }, t: 1,
    owners: new Map() })).includes('SECRET-DO-NOT-FORWARD'));
});

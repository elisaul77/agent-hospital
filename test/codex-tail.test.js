import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexTailer } from '../src/codex-tail.js';
import { reduce, EMPTY_STATE } from '../src/state.js';

const T = Date.parse('2026-10-20T12:00:00Z');
const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const GRANDCHILD_ID = '00000000-0000-4000-8000-000000000001';
const SECRET = 'SENTINEL_PROMPT_COMMAND_OUTPUT_9381';
const line = (type, payload, t = T) => JSON.stringify({ timestamp: new Date(t).toISOString(), type, payload }) + '\n';
const meta = (id, extra = {}, t = T - 3_600_000) => line('session_meta', { id, cwd: '/tmp/synthetic-project', ...extra }, t);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-test-'));
  const day = path.join(root, '2026', '10', '01');
  fs.mkdirSync(day, { recursive: true });
  const file = (id) => path.join(day, `rollout-2026-10-01T00-00-00-${id}.jsonl`);
  const write = (id, content) => {
    const p = file(id);
    fs.writeFileSync(p, content);
    fs.utimesSync(p, new Date(T), new Date(T));
    return p;
  };
  return { root, day, file, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function waitFor(predicate, message = 'tailer did not emit expected events') {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function start(root, events, logs = [], extra = {}) {
  const tailer = createCodexTailer({ root, windowMs: 60_000, now: () => T, pollMs: 10, emit: (batch) => events.push(...batch), log: (msg) => logs.push(msg), ...extra });
  tailer.start();
  return tailer;
}

test('namespaces root and child, links real parent, and emits only safe tool metadata', async () => {
  const f = fixture();
  const events = [], logs = [], cwd = [];
  const rootContent = meta(ROOT_ID) + line('response_item', { type: 'function_call', name: 'functions.exec_command', call_id: 'call-1', arguments: SECRET }) + line('response_item', { type: 'function_call_output', call_id: 'call-1', output: SECRET });
  const childContent = meta(CHILD_ID, { source: { subagent: { thread_spawn: { parent_thread_id: ROOT_ID, agent_role: 'review-agent', agent_nickname: SECRET } } } })
    + line('response_item', { type: 'custom_tool_call', name: 'functions.wait', call_id: 'call-2', input: SECRET })
    + line('response_item', { type: 'custom_tool_call_output', call_id: 'call-2', output: SECRET })
    + line('event_msg', { type: 'task_complete', last_agent_message: SECRET })
    + line('event_msg', { type: 'task_complete', last_agent_message: SECRET });
  f.write(ROOT_ID, rootContent);
  f.write(CHILD_ID, childContent);
  const tailer = start(f.root, events, logs, { onCwd: (id, value, startedAt) => cwd.push([id, value, startedAt]) });
  try {
    await waitFor(() => events.some((e) => e.kind === 'agent_done'));
    const rootId = `codex-${ROOT_ID}`, childId = `codex-${CHILD_ID}`;
    assert.deepEqual(events.filter((e) => e.kind === 'agent_spawn').map((e) => [e.agentId, e.parentAgentId, e.subagentType, e.workflow, e.runtime]).sort(), [[rootId, null, 'assistant', 'unknown', 'codex'], [childId, rootId, 'review-agent', 'unknown', 'codex']].sort());
    assert.ok(events.every((e) => e.sessionId === rootId));
    assert.deepEqual(events.filter((e) => e.kind === 'tool_start').map((e) => [e.agentId, e.tool, e.label]), [[rootId, 'functions.exec_command', ''], [childId, 'functions.wait', '']]);
    assert.equal(events.filter((e) => e.kind === 'tool_end').length, 2);
    const starts = events.filter((e) => e.kind === 'tool_start');
    const ends = events.filter((e) => e.kind === 'tool_end');
    assert.ok(starts.every((e) => /^codex-tool-[0-9a-f-]{36}$/.test(e.toolUseId)));
    assert.deepEqual(starts.map((e) => e.toolUseId).sort(), ends.map((e) => e.toolUseId).sort());
    assert.equal(events.filter((e) => e.kind === 'agent_done').length, 1);
    assert.equal(Object.hasOwn(events.find((e) => e.kind === 'agent_done'), 'verdict'), false);
    assert.deepEqual(tailer.sessions(), [{ sessionId: rootId, project: 'synthetic-project', lastT: T, provider: 'codex' }]);
    assert.deepEqual(cwd, [[rootId, '/tmp/synthetic-project', T - 3_600_000]]);
    assert.ok(!JSON.stringify({ events, logs }).includes(SECRET));
    assert.ok(!JSON.stringify(events).includes('/tmp/synthetic-project'));
  } finally { tailer.stop(); f.cleanup(); }
});

test('holds partial lines, resumes after restart, and excludes old events', async () => {
  const f = fixture();
  const events = [];
  const p = f.write(ROOT_ID, meta(ROOT_ID) + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'old' }, T - 120_000));
  const tail = start(f.root, events);
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(events.some((e) => e.kind === 'agent_spawn'), false);
    const complete = line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'new' });
    fs.appendFileSync(p, complete.slice(0, -1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(events.filter((e) => e.kind === 'tool_start').length, 0);
    fs.appendFileSync(p, '\n');
    fs.utimesSync(p, new Date(T), new Date(T));
    await waitFor(() => events.some((e) => e.kind === 'tool_start'));
    assert.equal(events.filter((e) => e.kind === 'tool_start').length, 1);
  } finally { tail.stop(); }
  const replay = [];
  const again = start(f.root, replay);
  try {
    await waitFor(() => replay.some((e) => e.kind === 'tool_start'));
    assert.equal(replay.filter((e) => e.kind === 'tool_start').length, 1);
  } finally { again.stop(); f.cleanup(); }
});

test('rejects symlinks, invalid meta and substituted files', async () => {
  const f = fixture();
  const events = [], logs = [];
  const outside = path.join(f.root, 'outside.jsonl');
  fs.writeFileSync(outside, meta(CHILD_ID) + line('response_item', { type: 'function_call', name: SECRET, call_id: 'bad' }));
  fs.symlinkSync(outside, f.file(CHILD_ID));
  const invalid = '33333333-3333-4333-8333-333333333333';
  f.write(invalid, meta(ROOT_ID) + line('response_item', { type: 'function_call', name: SECRET, call_id: 'bad2' }));
  const p = f.write(ROOT_ID, meta(ROOT_ID) + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'first' }));
  const tail = start(f.root, events, logs);
  try {
    await waitFor(() => events.some((e) => e.kind === 'tool_start'));
    const firstCount = events.length;
    fs.renameSync(p, `${p}.old`);
    fs.writeFileSync(p, meta(ROOT_ID) + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'replacement' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(events.length, firstCount);
    assert.ok(!JSON.stringify({ events, logs }).includes(SECRET));
    assert.ok(!JSON.stringify(events).includes('/tmp/synthetic-project'));
  } finally { tail.stop(); f.cleanup(); }
});


test('skips overlong records, resumes at next line, ignores guardians and keeps Claude IDs distinct', async () => {
  const f = fixture();
  const events = [], logs = [];
  const guardian = '44444444-4444-4444-8444-444444444444';
  const huge = '55555555-5555-4555-8555-555555555555';
  f.write(guardian, meta(guardian, { source: { subagent: { other: 'guardian' } } }) + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'guardian' }));
  const oversized = line('event_msg', { type: 'item_completed', item: { type: 'command_execution', command: SECRET.repeat(30_000), stdout: SECRET, stderr: SECRET } });
  assert.ok(Buffer.byteLength(oversized) > 256 * 1024);
  f.write(huge, meta(huge) + oversized + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'after-limit' }));
  f.write(ROOT_ID, meta(ROOT_ID) + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'safe' }));
  const tail = start(f.root, events, logs);
  try {
    await waitFor(() => events.some((e) => e.agentId === `codex-${ROOT_ID}` && e.kind === 'tool_start'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await waitFor(() => events.some((e) => e.agentId === `codex-${huge}` && e.kind === 'tool_start'));
    assert.equal(events.some((e) => e.agentId === `codex-${guardian}`), false);
    assert.ok(events.every((e) => !e.sessionId?.startsWith('claude-')));
    assert.ok(events.every((e) => !e.agentId?.startsWith('claude-')));
    assert.ok(!JSON.stringify({ events, logs, sessions: tail.sessions() }).includes(SECRET));
  } finally { tail.stop(); f.cleanup(); }
});


test('child completion is once per turn and can complete after a later send_input turn', async () => {
  const f = fixture();
  const events = [];
  f.write(ROOT_ID, meta(ROOT_ID));
  const child = f.write(CHILD_ID, meta(CHILD_ID, { source: { subagent: { thread_spawn: { parent_thread_id: ROOT_ID, agent_role: 'implement-agent' } } } })
    + line('event_msg', { type: 'task_started', turn_id: 'turn-a' })
    + line('event_msg', { type: 'task_complete', turn_id: 'turn-a' })
    + line('event_msg', { type: 'task_complete', turn_id: 'turn-a' }));
  const tail = start(f.root, events);
  try {
    await waitFor(() => events.filter((e) => e.kind === 'agent_done').length === 1);
    let state = events.reduce(reduce, EMPTY_STATE());
    state = reduce(state, { kind: 'idle_tick', t: T + 5000 });
    assert.equal(state.agents[`codex-${CHILD_ID}`], undefined, 'completed child left the reducer');
    const later = T + 6000;
    fs.appendFileSync(child, line('event_msg', { type: 'task_started', turn_id: 'turn-b' }, later)
      + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'turn-b-tool' }, later)
      + line('response_item', { type: 'function_call_output', call_id: 'turn-b-tool', output: SECRET }, later)
      + line('event_msg', { type: 'task_complete', turn_id: 'turn-b' }, later)
      + line('event_msg', { type: 'task_complete', turn_id: 'turn-b' }, later)
      + line('event_msg', { type: 'task_complete', turn_id: 'turn-c' }, later));
    await waitFor(() => events.filter((e) => e.kind === 'agent_done').length === 2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(events.filter((e) => e.kind === 'agent_done').length, 2);
    assert.equal(events.filter((e) => e.kind === 'agent_spawn' && e.agentId === `codex-${CHILD_ID}`).length, 2,
      'a child resumed after completion must reappear before its next tools');
    for (const event of events.filter((e) => e.t === later)) state = reduce(state, event);
    assert.equal(state.agents[`codex-${CHILD_ID}`]?.status, 'handback');
    const starts = events.filter((e) => e.kind === 'tool_start');
    const ends = events.filter((e) => e.kind === 'tool_end');
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(starts[0].toolUseId, ends[0].toolUseId);
  } finally { tail.stop(); f.cleanup(); }
});

test('resolves nested parent ancestry before emitting a grandchild rollout', async () => {
  const f = fixture();
  const events = [];
  f.write(GRANDCHILD_ID, meta(GRANDCHILD_ID, { source: { subagent: { thread_spawn: { parent_thread_id: CHILD_ID, agent_role: 'review-agent' } } } })
    + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'grandchild' }));
  f.write(CHILD_ID, meta(CHILD_ID, { source: { subagent: { thread_spawn: { parent_thread_id: ROOT_ID, agent_role: 'implement-agent' } } } }));
  f.write(ROOT_ID, meta(ROOT_ID));
  const tail = start(f.root, events);
  try {
    await waitFor(() => events.some((e) => e.agentId === `codex-${GRANDCHILD_ID}` && e.kind === 'tool_start'));
    assert.ok(events.every((e) => e.sessionId === `codex-${ROOT_ID}`));
    assert.deepEqual(tail.sessions().map((s) => s.sessionId), [`codex-${ROOT_ID}`]);
  } finally { tail.stop(); f.cleanup(); }
});

test('metadata-only descendants spawn once after grandchild-first ancestry resolution', async () => {
  const f = fixture();
  const events = [];
  f.write(GRANDCHILD_ID, meta(GRANDCHILD_ID, { source: { subagent: { thread_spawn: { parent_thread_id: CHILD_ID, agent_role: 'review-agent' } } } }, T));
  f.write(CHILD_ID, meta(CHILD_ID, { source: { subagent: { thread_spawn: { parent_thread_id: ROOT_ID, agent_role: 'implement-agent' } } } }, T));
  f.write(ROOT_ID, meta(ROOT_ID, {}, T));
  const tail = start(f.root, events);
  try {
    await waitFor(() => events.filter((e) => e.kind === 'agent_spawn').length === 3,
      'metadata-only rollouts did not emit all spawns');
    assert.deepEqual(events.filter((e) => e.kind === 'agent_spawn')
      .map((e) => [e.agentId, e.parentAgentId, e.sessionId, e.subagentType]).sort(), [
      [`codex-${ROOT_ID}`, null, `codex-${ROOT_ID}`, 'assistant'],
      [`codex-${CHILD_ID}`, `codex-${ROOT_ID}`, `codex-${ROOT_ID}`, 'implement-agent'],
      [`codex-${GRANDCHILD_ID}`, `codex-${CHILD_ID}`, `codex-${ROOT_ID}`, 'review-agent'],
    ].sort());
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(events.filter((e) => e.kind === 'agent_spawn').length, 3);
  } finally { tail.stop(); f.cleanup(); }
});

test('continues a capped day scan to discover its 4501st rollout', async () => {
  const f = fixture();
  const events = [];
  for (let n = 0; n < 4501; n++) {
    const id = `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    fs.writeFileSync(f.file(id), '');
  }
  const directory = await fsp.opendir(f.day);
  const order = [];
  for await (const entry of directory) order.push(entry.name);
  const lastId = order[4500].match(/([0-9a-f]{8}-0000-4000-8000-000000000000)\.jsonl$/)[1];
  f.write(lastId, meta(lastId) + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'late' }));
  const tail = start(f.root, events);
  try {
    await waitFor(() => events.some((e) => e.agentId === `codex-${lastId}` && e.kind === 'tool_start'),
      '4501st rollout stayed hidden behind the per-day entry cap');
  } finally { tail.stop(); f.cleanup(); }
});

test('rotates 256 partial tracked files without losing a pending record', async () => {
  const f = fixture();
  const events = [];
  for (let n = 0; n < 257; n++) {
    const id = `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    fs.writeFileSync(f.file(id), '');
  }
  const directory = await fsp.opendir(f.day);
  const order = [];
  for await (const entry of directory) order.push(entry.name.match(/([0-9a-f]{8}-0000-4000-8000-000000000000)\.jsonl$/)[1]);
  for (let n = 0; n < 256; n++) {
    const id = order[n];
    const partial = line('response_item', { type: 'function_call', name: 'functions.wait', call_id: `partial-${n}` }).slice(0, -1);
    f.write(id, meta(id) + partial);
  }
  const firstId = order[0], lastId = order[256];
  const firstPath = f.file(firstId);
  f.write(lastId, meta(lastId) + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'last' }));
  const tail = start(f.root, events);
  try {
    await waitFor(() => events.some((e) => e.agentId === `codex-${lastId}` && e.kind === 'tool_start'),
      '257th rollout stayed hidden by partial tracked files');
    fs.appendFileSync(firstPath, '\n');
    fs.utimesSync(firstPath, new Date(T), new Date(T));
    await waitFor(() => events.some((e) => e.agentId === `codex-${firstId}` && e.kind === 'tool_start'),
      'retired partial record did not resume');
    assert.equal(events.filter((e) => e.agentId === `codex-${firstId}` && e.kind === 'tool_start').length, 1);
  } finally { tail.stop(); f.cleanup(); }
});

test('old metadata with fresh mtime stays inactive until a recent event', async () => {
  const f = fixture();
  const events = [];
  const p = f.write(ROOT_ID, meta(ROOT_ID));
  let clock = T;
  const tail = start(f.root, events, [], { now: () => clock });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(events.some((e) => e.kind === 'agent_spawn'), false);
    assert.deepEqual(tail.sessions(), []);
    fs.appendFileSync(p, line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'recent' }));
    fs.utimesSync(p, new Date(T), new Date(T));
    await waitFor(() => events.some((e) => e.kind === 'tool_start'));
    assert.equal(events.filter((e) => e.kind === 'agent_spawn').length, 1);
    assert.equal(tail.sessions()[0].lastT, T);
    clock += 120_000;
    assert.deepEqual(tail.sessions(), []);
  } finally { tail.stop(); f.cleanup(); }
});

test('rotates a full file set so the 257th active rollout is visible', async () => {
  const f = fixture();
  const events = [];
  let firstPath;
  for (let n = 0; n < 257; n++) {
    const id = `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const p = f.write(id, meta(id) + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: `call-${n}` }));
    if (n === 0) firstPath = p;
  }
  const lastId = '00000100-0000-4000-8000-000000000000';
  const firstId = '00000000-0000-4000-8000-000000000000';
  const tail = start(f.root, events);
  try {
    await waitFor(() => events.some((e) => e.agentId === `codex-${lastId}` && e.kind === 'tool_start'), '257th rollout stayed invisible');
    fs.appendFileSync(firstPath, line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'resumed' }));
    fs.utimesSync(firstPath, new Date(T), new Date(T));
    await waitFor(() => events.filter((e) => e.agentId === `codex-${firstId}` && e.kind === 'tool_start').length === 2,
      'evicted active rollout did not resume');
    assert.equal(events.filter((e) => e.agentId === `codex-${firstId}` && e.kind === 'agent_spawn').length, 1);
  } finally { tail.stop(); f.cleanup(); }
});

test('never exports a prompt sentinel embedded in call_id', async () => {
  const f = fixture();
  const events = [];
  f.write(ROOT_ID, meta(ROOT_ID) + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: SECRET })
    + line('response_item', { type: 'function_call_output', call_id: SECRET }));
  const tail = start(f.root, events);
  try {
    await waitFor(() => events.some((e) => e.kind === 'tool_end'));
    const pair = events.filter((e) => e.kind === 'tool_start' || e.kind === 'tool_end');
    assert.equal(pair[0].toolUseId, pair[1].toolUseId);
    assert.ok(/^codex-tool-[0-9a-f-]{36}$/.test(pair[0].toolUseId));
    assert.ok(!JSON.stringify({ events, sessions: tail.sessions() }).includes(SECRET));
  } finally { tail.stop(); f.cleanup(); }
});

test('streams directory entries without materializing an unbounded readdir result', async () => {
  const f = fixture();
  const events = [];
  f.write(ROOT_ID, meta(ROOT_ID) + line('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'streamed' }));
  const original = fsp.readdir;
  fsp.readdir = async () => { throw new Error('unbounded readdir used'); };
  const tail = start(f.root, events);
  try {
    await waitFor(() => events.some((e) => e.kind === 'tool_start'));
  } finally { tail.stop(); fsp.readdir = original; f.cleanup(); }
});

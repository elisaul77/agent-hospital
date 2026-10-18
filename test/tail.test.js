// Tailer tests: partial-line buffering, deferred subagents, no duplicates, nothing leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeCompleteLines, createTailer } from '../src/tail.js';
import { roleOf } from '../src/roles.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures');

test('takeCompleteLines keeps the unterminated tail for the next read', () => {
  const r = takeCompleteLines(Buffer.from('a\nb\npart'));
  assert.deepEqual(r.lines, ['a', 'b']);
  assert.equal(r.consumed, 4);
});

test('takeCompleteLines does not split a multi-byte UTF-8 character', () => {
  const full = Buffer.from('ñ\n', 'utf8');
  const first = takeCompleteLines(full.subarray(0, 1));
  assert.deepEqual(first, { lines: [], consumed: 0 });
  const second = takeCompleteLines(full);
  assert.deepEqual(second.lines, ['ñ']);
});

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hospital-tail-'));
  const proj = path.join(root, '-home-example');
  fs.mkdirSync(path.join(proj, 'sess-fixture-1', 'subagents'), { recursive: true });
  return { root, proj, sub: path.join(proj, 'sess-fixture-1', 'subagents') };
}

function collector() {
  const batches = [];
  return { batches, all: () => batches.flat(), emit: (evs) => batches.push(evs), log: () => {} };
}

test('tailer turns a real-shaped session and its subagent into spawn, link, verdict; no content leaks', async () => {
  const { root, proj, sub } = mkRoot();
  fs.copyFileSync(path.join(FIX, 'session-main.jsonl'), path.join(proj, 'sess-fixture-1.jsonl'));
  fs.copyFileSync(path.join(FIX, 'subagents/agent-fixrev1.jsonl'), path.join(sub, 'agent-fixrev1.jsonl'));
  fs.copyFileSync(path.join(FIX, 'subagents/agent-fixrev1.meta.json'), path.join(sub, 'agent-fixrev1.meta.json'));
  const c = collector();
  const tailer = createTailer({ root, windowMs: 3_600_000, emit: c.emit, log: c.log, now: () => Date.now() });
  await tailer.tick();
  const evs = c.all();
  const spawn = evs.find((e) => e.kind === 'agent_spawn' && e.agentId === 'fixrev1');
  assert.equal(spawn.parentAgentId, 'sess-fixture-1');
  assert.ok(evs.find((e) => e.kind === 'agent_link' && e.toolUseId === 'toolu_fixture_review_1'));
  const done = evs.find((e) => e.kind === 'agent_done');
  assert.equal(done.verdict, 'FAILED');
  assert.equal(done.failureOrigin, 'implementation');
  const text = JSON.stringify(evs);
  for (const s of ['SYNTHETIC PROMPT', 'SECRET', 'FAKE_TOKEN_123']) assert.ok(!text.includes(s), `leaked ${s}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a partial last line is held back until its newline arrives, then emitted once', async () => {
  const { root, proj } = mkRoot();
  const file = path.join(proj, 'sess-fixture-1.jsonl');
  const lines = fs.readFileSync(path.join(FIX, 'session-main.jsonl'), 'utf8').split('\n').filter(Boolean);
  const cut = Math.floor(lines[2].length / 2);
  fs.writeFileSync(file, lines[0] + '\n' + lines[2].slice(0, cut));
  const c = collector();
  const tailer = createTailer({ root, windowMs: 3_600_000, emit: c.emit, log: c.log });
  await tailer.tick();
  assert.ok(!c.all().some((e) => e.toolUseId === 'toolu_fixture_review_1'), 'partial line must not emit');
  fs.appendFileSync(file, lines[2].slice(cut) + '\n');
  await tailer.tick();
  const starts = c.all().filter((e) => e.kind === 'tool_start' && e.toolUseId === 'toolu_fixture_review_1');
  assert.equal(starts.length, 1);
  await tailer.tick();
  assert.equal(c.all().filter((e) => e.kind === 'tool_start' && e.toolUseId === 'toolu_fixture_review_1').length, 1, 'no duplicate on idle tick');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a subagent file is not consumed until its meta sidecar exists', async () => {
  const { root, proj, sub } = mkRoot();
  fs.copyFileSync(path.join(FIX, 'session-main.jsonl'), path.join(proj, 'sess-fixture-1.jsonl'));
  fs.copyFileSync(path.join(FIX, 'subagents/agent-fixrev1.jsonl'), path.join(sub, 'agent-fixrev1.jsonl'));
  const c = collector();
  const tailer = createTailer({ root, windowMs: 3_600_000, emit: c.emit, log: c.log });
  await tailer.tick();
  assert.ok(!c.all().some((e) => e.agentId === 'fixrev1'), 'nothing for the child before its meta');
  fs.copyFileSync(path.join(FIX, 'subagents/agent-fixrev1.meta.json'), path.join(sub, 'agent-fixrev1.meta.json'));
  await tailer.tick();
  assert.ok(c.all().some((e) => e.kind === 'agent_spawn' && e.agentId === 'fixrev1'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('sessions outside the time window are not tailed', async () => {
  const { root, proj } = mkRoot();
  const file = path.join(proj, 'sess-fixture-1.jsonl');
  fs.copyFileSync(path.join(FIX, 'session-main.jsonl'), file);
  const old = new Date(Date.now() - 10 * 3_600_000);
  fs.utimesSync(file, old, old);
  const c = collector();
  const tailer = createTailer({ root, windowMs: 3_600_000, emit: c.emit, log: c.log });
  await tailer.tick();
  assert.equal(c.all().length, 0);
  assert.deepEqual(tailer.sessions(), []);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- Phase 4b: window limit. A reviewer outside the window is never tracked, so its APPROVED never reaches the
// reducer: phasesDone undercounts after a restart (documented limit). The tailer must not throw.
import { reduce, EMPTY_STATE } from '../src/state.js';

test('a reviewer outside the window is never tracked: no verdict is emitted and tick does not throw', async () => {
  const { root, proj, sub } = mkRoot();
  fs.copyFileSync(path.join(FIX, 'session-main.jsonl'), path.join(proj, 'sess-fixture-1.jsonl'));
  fs.copyFileSync(path.join(FIX, 'subagents/agent-fixrev1.jsonl'), path.join(sub, 'agent-fixrev1.jsonl'));
  fs.copyFileSync(path.join(FIX, 'subagents/agent-fixrev1.meta.json'), path.join(sub, 'agent-fixrev1.meta.json'));
  const old = new Date(Date.now() - 3 * 3600_000);
  fs.utimesSync(path.join(sub, 'agent-fixrev1.jsonl'), old, old);
  const c = collector();
  const tailer = createTailer({ root, windowMs: 3_600_000, emit: c.emit, log: c.log, now: () => Date.now() });
  await tailer.tick();
  const evs = c.all();
  assert.equal(evs.some((e) => e.agentId === 'fixrev1'), false, 'nothing from the old reviewer');
  assert.equal(evs.some((e) => e.kind === 'agent_done' && e.verdict), false, 'no verdict (undercount limit)');
  assert.doesNotThrow(() => evs.reduce(reduce, EMPTY_STATE()));
  fs.rmSync(root, { recursive: true, force: true });
});

// Phase 4: a council member spawned as "architect5" is recorded as council-architect (meta customAgentType).
test('a council member with a free name is spawned with its real type and lands in the Council room', async () => {
  const { root, proj, sub } = mkRoot();
  fs.copyFileSync(path.join(FIX, 'session-main.jsonl'), path.join(proj, 'sess-fixture-1.jsonl'));
  fs.copyFileSync(path.join(FIX, 'subagents/agent-fixcouncil1.jsonl'), path.join(sub, 'agent-fixcouncil1.jsonl'));
  fs.copyFileSync(path.join(FIX, 'subagents/agent-fixcouncil1.meta.json'), path.join(sub, 'agent-fixcouncil1.meta.json'));
  const c = collector();
  const tailer = createTailer({ root, windowMs: 3_600_000, emit: c.emit, log: c.log, now: () => Date.now() });
  await tailer.tick();
  const spawn = c.all().find((e) => e.kind === 'agent_spawn' && e.agentId === 'fixcouncil1');
  assert.equal(spawn.subagentType, 'council-architect');
  assert.deepEqual(roleOf(spawn.subagentType), { role: 'council-architect', room: 'council' });
  fs.rmSync(root, { recursive: true, force: true });
});

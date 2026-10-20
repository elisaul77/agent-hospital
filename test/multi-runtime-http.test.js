import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src/server.js');
const CLAUDE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODEX = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECRET = 'SYNTHETIC_PROMPT_COMMAND_OUTPUT_SECRET_4141';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonl = (type, payload, timestamp) => JSON.stringify({ type, payload, timestamp }) + '\n';

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(() => resolve(port));
    });
  });
}
async function waitFor(fn, message, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await sleep(80);
  }
  assert.fail(message);
}
async function start(root, codexRoot, caseRoot) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env,
    HOST: '127.0.0.1', PORT: String(port), HOSPITAL_MODE: 'live', HOSPITAL_PROJECTS_DIR: root,
    HOSPITAL_CODEX_DIR: codexRoot, HOSPITAL_CASE_DIRS: caseRoot, HOSPITAL_WINDOW_H: '6',
    HOSPITAL_ALLOWED_HOSTS: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (b) => { errors += b; });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`server exited: ${errors}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, `server not ready: ${errors}`);
  return { child, base, errors: () => errors };
}
async function getJson(base, route) {
  const response = await fetch(base + route);
  return { status: response.status, body: await response.json(), headers: response.headers };
}
function sseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next() {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) return { event, data: JSON.parse(data) };
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE closed');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    close() { reader.cancel(); },
  };
}

test('both live runtimes share state/SSE; session selection and case inference stay isolated', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hospital-multi-http-'));
  const claudeRoot = path.join(baseDir, 'claude');
  const codexRoot = path.join(baseDir, 'codex');
  const project = path.join(baseDir, 'project');
  const claudeProject = path.join(claudeRoot, '-synthetic');
  const date = new Date(Date.now() - 4000).toISOString();
  const claudeFile = path.join(claudeProject, `${CLAUDE}.jsonl`);
  const codexFile = path.join(codexRoot, '2026', '10', '20', `rollout-2026-10-20T00-00-00-${CODEX}.jsonl`);
  const childFile = path.join(codexRoot, '2026', '10', '20', `rollout-2026-10-20T00-00-00-${CHILD}.jsonl`);
  const stateFile = path.join(project, 'plans', 'synthetic-state.md');
  write(claudeFile, JSON.stringify({ type: 'user', timestamp: date, cwd: path.join(baseDir, 'claude-project'),
    message: { content: SECRET } }) + '\n');
  write(codexFile, jsonl('session_meta', { id: CODEX, cwd: project }, date)
    + jsonl('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'initial', arguments: SECRET }, date));
  write(childFile, jsonl('session_meta', { id: CHILD, cwd: project,
    source: { subagent: { thread_spawn: { parent_thread_id: CODEX, agent_role: 'planning-agent' } } } }, date)
    + jsonl('event_msg', { type: 'task_complete', turn_id: 'synthetic-child-turn' }, date));
  write(stateFile, 'STATUS: IN_PROGRESS\nClassification: Tier M · feature\nOwner: Conductor\nPlan file: plans/synthetic-plan.md\n');
  const old = new Date(Date.now() - 86_400_000);
  fs.utimesSync(stateFile, old, old);
  let server;
  try {
    server = await start(claudeRoot, codexRoot, baseDir);
    const ids = [`claude-${CLAUDE}`, `codex-${CODEX}`];
    await waitFor(async () => {
      const sessions = (await getJson(server.base, '/api/sessions')).body.sessions;
      return ids.every((id) => sessions.some((s) => s.sessionId === id)) && sessions;
    }, 'both providers missing');
    const sessions = (await getJson(server.base, '/api/sessions')).body.sessions;
    assert.deepEqual(new Set(sessions.map((s) => s.provider)), new Set(['claude', 'codex']));
    for (const id of ids) {
      const state = (await getJson(server.base, `/api/state?mode=live&session=${id}`)).body;
      assert.deepEqual(Object.keys(state.workflows), [id]);
      assert.ok(Object.values(state.agents).every((a) => a.sessionId === id));
      assert.deepEqual(state.cases, {}, 'old unrelated state file cannot create a case');
      assert.deepEqual(state.messages, []);
      assert.deepEqual(state.escalations, []);
    }
    const invalid = await getJson(server.base, '/api/state?mode=live&session=../../etc/passwd');
    assert.equal(invalid.status, 400);
    const stream = await fetch(`${server.base}/events?mode=live&session=codex-${CODEX}`);
    assert.equal(stream.status, 200);
    const events = sseReader(stream);
    try {
      const snapshot = await events.next();
      assert.equal(snapshot.event, 'snapshot');
      assert.deepEqual(Object.keys(snapshot.data.workflows), [`codex-${CODEX}`]);
      assert.ok(Object.values(snapshot.data.agents).every((a) => a.sessionId === `codex-${CODEX}`));
      fs.appendFileSync(codexFile, jsonl('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'later', arguments: SECRET }, new Date().toISOString()));
      const delta = await Promise.race([waitFor(async () => {
        const next = await events.next();
        return next.event === 'delta' && next.data.events.some((e) => e.kind === 'tool_start' && e.tool === 'functions.wait') ? next : null;
      }, 'Codex delta missing', 5000), sleep(6000).then(() => { throw new Error('SSE delta timed out'); })]);
      assert.deepEqual(Object.keys(delta.data.state.workflows), [`codex-${CODEX}`]);
      assert.ok(delta.data.events.every((e) => !e.sessionId || e.sessionId === `codex-${CODEX}`));
      assert.ok(!JSON.stringify(delta).includes(SECRET));
    } finally { events.close(); }
    assert.ok(!JSON.stringify((await getJson(server.base, `/api/state?mode=live&session=codex-${CODEX}`)).body).includes(SECRET));
    const claudeStream = await fetch(`${server.base}/events?mode=live&session=claude-${CLAUDE}`);
    const claudeEvents = sseReader(claudeStream);
    try {
      assert.equal((await claudeEvents.next()).event, 'snapshot');
      fs.appendFileSync(claudeFile, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
        message: { content: [
          { type: 'tool_use', id: 'private-bash', name: 'Bash', input: { description: SECRET, command: SECRET } },
          { type: 'tool_use', id: 'private-grep', name: 'Grep', input: { pattern: SECRET } },
        ] } }) + '\n');
      const delta = await Promise.race([waitFor(async () => {
        const next = await claudeEvents.next();
        return next.event === 'delta' && next.data.events.some((e) => e.kind === 'tool_start' && e.tool === 'Grep') ? next : null;
      }, 'Claude delta missing', 5000), sleep(6000).then(() => { throw new Error('Claude SSE timed out'); })]);
      assert.deepEqual(delta.data.events.filter((e) => e.kind === 'tool_start').map((e) => e.tool), ['Bash', 'Grep']);
      assert.ok(!JSON.stringify(delta).includes(SECRET));
    } finally { claudeEvents.close(); }
    const overflowFiles = Array.from({ length: 256 }, (_, n) => path.join(project, 'plans', `extra-${n}-state.md`));
    for (const file of overflowFiles) fs.writeFileSync(file, 'synthetic');
    await waitFor(() => server.errors().includes('case directory entry cap exceeded (256)'),
      'case directory overflow did not log its count-only diagnostic', 7000);
    for (const file of overflowFiles) fs.unlinkSync(file);
    fs.writeFileSync(stateFile, 'STATUS: IN_PROGRESS\nClassification: Tier M · feature\nOwner: Conductor\nPlan file: plans/synthetic-plan.md\nHospital session: codex-unrelated\n');
    await sleep(3300);
    assert.notEqual((await getJson(server.base, `/api/state?mode=live&session=codex-${CODEX}`)).body.workflows[`codex-${CODEX}`]?.workflow,
      'subagent-pool', 'an unrelated case must not confirm this Codex session');
    fs.writeFileSync(stateFile, `STATUS: IN_PROGRESS\nClassification: Tier M · feature\nOwner: Conductor\nPlan file: plans/synthetic-plan.md\nHospital session: codex-${CODEX}\n`);
    await waitFor(async () => (await getJson(server.base, `/api/state?mode=live&session=codex-${CODEX}`)).body.workflows[`codex-${CODEX}`]?.workflow === 'subagent-pool',
      'fresh corroborated Codex state did not confirm pool', 7000);
    const claude = (await getJson(server.base, `/api/state?mode=live&session=claude-${CLAUDE}`)).body;
    assert.equal(claude.workflows[`claude-${CLAUDE}`].workflow, 'unknown');
    assert.deepEqual(claude.cases, {});
    // Two explicitly confirmed Claude sessions can share this cwd and the fresh state file.
    const shared = ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'];
    const skillTime = new Date(Date.now() - 1000).toISOString();
    for (const id of shared) write(path.join(claudeProject, `${id}.jsonl`),
      JSON.stringify({ type: 'user', timestamp: skillTime, cwd: project, message: { content: 'synthetic' } }) + '\n'
      + JSON.stringify({ type: 'assistant', timestamp: skillTime, cwd: project,
        message: { content: [{ type: 'tool_use', id: `skill-${id}`, name: 'Skill', input: { skill: 'subagent-pool' } }] } }) + '\n');
    await waitFor(async () => (await getJson(server.base, '/api/sessions')).body.sessions.filter((s) => shared.some((id) => s.sessionId === `claude-${id}`)).length === 2,
      'shared Claude sessions missing');
    fs.writeFileSync(stateFile, 'STATUS: IN_PROGRESS\nClassification: Tier M · feature\nOwner: Conductor\nPlan file: plans/synthetic-plan.md\n');
    await waitFor(async () => {
      const views = await Promise.all(shared.map((id) => getJson(server.base, `/api/state?mode=live&session=claude-${id}`)));
      return views.every(({ body }, i) => body.workflows[`claude-${shared[i]}`]?.reason === 'skill_invocation'
        && body.cases[`claude-${shared[i]}`]?.archiveId);
    }, 'explicit Claude pool sessions did not attach their shared fresh case', 7000);
    const archive = await getJson(server.base, '/api/archive');
    assert.equal(archive.status, 200);
    const wrongOrigin = await fetch(`${server.base}/api/state`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(wrongOrigin.status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(new URL(server.base).port), '127.0.0.1');
      let reply = '';
      socket.on('data', (chunk) => { reply += chunk.toString('latin1'); });
      socket.on('end', () => resolve(reply));
      socket.on('error', reject);
      socket.write('GET /api/state HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
    });
    assert.match(wrongHost, /^HTTP\/1\.1 421 /);
  } finally {
    server?.child.kill('SIGTERM');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('missing Codex root leaves Claude live', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hospital-missing-codex-'));
  const claudeRoot = path.join(baseDir, 'claude');
  const project = path.join(baseDir, 'project');
  write(path.join(claudeRoot, '-synthetic', `${CLAUDE}.jsonl`), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: project,
    message: { content: SECRET } }) + '\n');
  let server;
  try {
    server = await start(claudeRoot, path.join(baseDir, 'missing'), baseDir);
    await waitFor(async () => (await getJson(server.base, '/api/sessions')).body.sessions.some((s) => s.sessionId === `claude-${CLAUDE}`),
      'Claude session disappeared with absent Codex root');
    assert.equal((await getJson(server.base, '/api/health')).status, 200);
  } finally {
    server?.child.kill('SIGTERM');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('old Codex session_meta can confirm against a fresh file predating synthetic spawn', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hospital-old-meta-'));
  const project = path.join(baseDir, 'project');
  const codexRoot = path.join(baseDir, 'codex');
  const day = path.join(codexRoot, '2026', '10', '20');
  const metaTime = new Date(Date.now() - 8 * 3600_000).toISOString();
  const activityTime = new Date(Date.now() - 3000).toISOString();
  write(path.join(day, `rollout-2026-10-20T00-00-00-${CODEX}.jsonl`),
    jsonl('session_meta', { id: CODEX, cwd: project }, metaTime)
    + jsonl('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'recent' }, activityTime));
  write(path.join(day, `rollout-2026-10-20T00-00-00-${CHILD}.jsonl`),
    jsonl('session_meta', { id: CHILD, cwd: project,
      source: { subagent: { thread_spawn: { parent_thread_id: CODEX, agent_role: 'planning-agent' } } } }, metaTime)
    + jsonl('response_item', { type: 'function_call', name: 'functions.wait', call_id: 'child-recent' }, activityTime)
    + jsonl('event_msg', { type: 'task_complete', turn_id: 'old-meta-child-turn' }, activityTime));
  const stateFile = path.join(project, 'plans', 'synthetic-state.md');
  write(stateFile, `STATUS: IN_PROGRESS\nClassification: Tier M · feature\nOwner: Conductor\nPlan file: plans/synthetic-plan.md\nHospital session: codex-${CODEX}\n`);
  let server;
  try {
    server = await start(path.join(baseDir, 'missing-claude'), codexRoot, baseDir);
    await waitFor(async () => {
      const state = (await getJson(server.base, `/api/state?mode=live&session=codex-${CODEX}`)).body;
      return state.workflows[`codex-${CODEX}`]?.reason === 'matched_case_file';
    }, 'session_meta timestamp was not used for Codex confirmation', 7000);
  } finally {
    server?.child.kill('SIGTERM');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

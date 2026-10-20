// Phase 2 (hospital-5b1): HTTP surface of the archive. Real server processes on ephemeral ports with a fixture
// root in a temp dir; Host and Sec-Fetch probes are raw bytes so nothing is normalized. In-process checks cover
// the archive's log lines and the O_NONBLOCK opens on a FIFO.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createArchive, caseId, ARCHIVE_CAP } from '../src/archive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '..', 'src', 'server.js');
const ARCHIVE_URL = pathToFileURL(path.resolve(here, '..', 'src', 'archive.js')).href;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-fake-payload')]);
const CSP = "default-src 'none'; sandbox";
const SECRETS = [
  'token sk-AAAAAAAAAAAAAAAAAAAAAAAA',
  'gh ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'Authorization Bearer abcdefghijklmnopqrst',
  'password=hunter2',
];
const STATE = (plan = 'plans/alpha-plan.md', status = 'IN_PROGRESS') => [
  `STATUS: ${status}`,
  'Classification: Tier L · feature · single · urgency normal · uncertainty med · risk low',
  'Owner: Conductor',
  `Plan file: ${plan}`,
  'Objective: SYNTHETIC archive fixture',
  '',
].join('\n');

function write(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

// root/proj/plans (alpha: full set), root/beta (no plan, escaping council links), root/gamma (debate over the cap).
function makeFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-http-')));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  const alpha = path.join(root, 'proj', 'plans');
  write(path.join(alpha, 'alpha-state.md'), STATE());
  write(path.join(alpha, 'alpha-plan.md'), '## Phase 1: Intake\n');
  write(path.join(alpha, 'council', 'alpha', 'decisions.md'), 'D1 decided\n');
  write(path.join(alpha, 'council', 'alpha', 'debate.log'), `${SECRETS.join('\n')}\nplain line\n`);
  write(path.join(alpha, 'shots', 'p1.png'), PNG);
  write(path.join(alpha, 'shots', 'fake.png'), 'this is text, not a png\n');
  execFileSync('mkfifo', [path.join(alpha, 'fifo-state.md')]);
  fs.symlinkSync(path.join(outside, 'state-out.md'), path.join(alpha, 'leak-state.md'));
  write(path.join(outside, 'secret.md'), 'TOP SECRET outside\n');
  write(path.join(outside, 'state-out.md'), STATE());
  write(path.join(root, 'beta', 'plans', 'beta-state.md'), STATE('none.md'));
  fs.mkdirSync(path.join(root, 'beta', 'plans', 'council', 'beta'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'beta', 'plans', 'council', 'beta', 'decisions.md'));
  write(path.join(root, 'gamma', 'plans', 'gamma-state.md'), STATE('none.md'));
  write(path.join(root, 'gamma', 'plans', 'council', 'gamma', 'debate.log'), 'x'.repeat(1024).concat('\n').repeat(300));
  return { base, root, outside, alpha, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

let fx;
let main;
const servers = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Raw HTTP/1.x request. `headers` is an explicit list of [name, value]; nothing is added except Connection: close.
function send(port, { method = 'GET', target = '/api/health', headers = [['Host', `127.0.0.1:${port}`]], proto = 'HTTP/1.1' } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', reject);
    sock.on('end', () => {
      try {
        resolve(parse(Buffer.concat(chunks)));
      } catch (err) {
        reject(err);
      }
    });
    let head = `${method} ${target} ${proto}\r\n`;
    for (const [k, v] of headers) head += `${k}: ${v}\r\n`;
    head += 'Connection: close\r\n\r\n';
    sock.write(head);
  });
}

function parse(buf) {
  const idx = buf.indexOf('\r\n\r\n');
  if (idx < 0) throw new Error(`no header end: ${buf.toString('latin1').slice(0, 200)}`);
  const lines = buf.subarray(0, idx).toString('latin1').split('\r\n');
  const m = /^HTTP\/\d\.\d (\d{3})/.exec(lines[0]);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    headers[k] = headers[k] === undefined ? v : `${headers[k]}, ${v}`;
  }
  const raw = buf.subarray(idx + 4);
  return { status: Number(m?.[1]), headers, body: headers['transfer-encoding'] === 'chunked' ? dechunk(raw) : raw };
}

function dechunk(buf) {
  const out = [];
  let p = 0;
  for (;;) {
    const e = buf.indexOf('\r\n', p);
    if (e < 0) throw new Error('bad chunked body');
    const size = parseInt(buf.subarray(p, e).toString('latin1'), 16);
    p = e + 2;
    if (size === 0) break;
    out.push(buf.subarray(p, p + size));
    p += size + 2;
  }
  return Buffer.concat(out);
}

const get = (port, target, headers) => send(port, { target, headers: headers ?? [['Host', `127.0.0.1:${port}`]] });
const noDate = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'date'));

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', HOSPITAL_MODE: 'demo',
    HOSPITAL_CASE_DIRS: fx.root, HOSPITAL_ALLOWED_HOSTS: '',
    ...extraEnv,
  };
  if (!('HOSPITAL_CONDUCTOR_IDLE_MIN' in extraEnv)) delete env.HOSPITAL_CONDUCTOR_IDLE_MIN;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const srv = { child, port, stderr: () => stderr };
  servers.push(srv);
  const end = Date.now() + 8000;
  for (;;) {
    try {
      if ((await get(port, '/api/health')).status === 200) return srv;
    } catch {
      // not listening yet
    }
    if (Date.now() > end || child.exitCode !== null) throw new Error(`server on ${port} not healthy; stderr: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  fx = makeFixture();
  main = await startServer();
});

after(() => {
  for (const s of servers) if (s.child.exitCode === null) s.child.kill('SIGTERM');
  if (fx) fx.cleanup();
});

const ALPHA_STATE = () => path.join(fx.alpha, 'alpha-state.md');
const alphaId = () => caseId(fs.realpathSync(ALPHA_STATE()));
const betaId = () => caseId(path.join(fs.realpathSync(fx.root), 'beta', 'plans', 'beta-state.md'));
const gammaId = () => caseId(path.join(fs.realpathSync(fx.root), 'gamma', 'plans', 'gamma-state.md'));

// ---- Host guard (risk R1, decisions row 7) ----

test('Host guard: loopback names pass on any port, case-insensitively', async () => {
  for (const host of ['localhost', 'localhost:8700', 'LOCALHOST:8700', '127.0.0.1:1', '127.0.0.1', '[::1]:8700', '[::1]', 'localhost:65535']) {
    const r = await get(main.port, '/api/health', [['Host', host]]);
    assert.equal(r.status, 200, host);
  }
});

test('Host guard: anything else is 421, including trailing-dot, userinfo, bad ports and rebinding names', async () => {
  for (const host of [
    'evil.test', 'evil.example:8700', 'localhost.:8700', 'localhost:8700@evil', 'localhost:8700@evil.example',
    'localhost:99999', 'localhost:', '127.0.0.1.evil.test', 'localhost:8700/x', '[::2]:8700', 'localhost\\evil', 'localhost evil',
  ]) {
    const r = await get(main.port, '/api/health', [['Host', host]]);
    assert.equal(r.status, 421, `${host} -> ${r.status}`);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
});

test('Host guard: an empty Host is 421', async () => {
  assert.equal((await get(main.port, '/api/health', [['Host', '']])).status, 421);
});

test('Host guard: duplicate Host headers are 421 even when both values are valid', async () => {
  const r = await get(main.port, '/api/health', [['Host', 'localhost'], ['Host', 'localhost']]);
  assert.equal(r.status, 421);
  const mixed = await get(main.port, '/api/health', [['Host', 'localhost'], ['Host', 'evil.test']]);
  assert.equal(mixed.status, 421);
});

test('Host guard: a missing Host is refused. HTTP/1.0 gets 421; Node itself answers HTTP/1.1 without Host with 400', async () => {
  assert.equal((await send(main.port, { proto: 'HTTP/1.0', headers: [] })).status, 421);
  const h11 = await send(main.port, { headers: [] });
  assert.equal(h11.status, 400, 'node parser refuses it before the guard; never served');
});

test('Host guard runs first on every route: /api/*, /events, static and the archive', async () => {
  for (const target of ['/api/state', '/api/sessions', '/api/archive', `/api/doc?case=${alphaId()}&doc=state`, '/events', '/', '/index.html']) {
    const r = await get(main.port, target, [['Host', 'evil.test:8700']]);
    assert.equal(r.status, 421, target);
  }
});

test('Host guard: HOSPITAL_ALLOWED_HOSTS admits listed LAN names (case-insensitive) and nothing else', async () => {
  const lan = await startServer({ HOSPITAL_ALLOWED_HOSTS: ' 192.0.2.80, Box.LAN ,[fd00::5]' });
  for (const host of ['192.0.2.80:8700', 'box.lan:8700', 'BOX.lan', '[fd00::5]:8700']) {
    assert.equal((await get(lan.port, '/api/health', [['Host', host]])).status, 200, host);
  }
  for (const host of ['192.0.2.81:8700', 'box.lan.evil:8700', 'evil.box.lan']) {
    assert.equal((await get(lan.port, '/api/health', [['Host', host]])).status, 421, host);
  }
  assert.equal((await get(lan.port, '/api/health', [['Host', 'localhost:8700']])).status, 200, 'loopback still allowed');
});

test('HOSPITAL_ALLOWED_HOSTS: an invalid entry is logged and ignored, never a boot failure', async () => {
  const lan = await startServer({ HOSPITAL_ALLOWED_HOSTS: 'good.lan,bad entry/x' });
  assert.match(lan.stderr(), /HOSPITAL_ALLOWED_HOSTS entry ignored/);
  assert.ok(!lan.stderr().includes('bad entry/x'), 'invalid host value stays out of logs');
  assert.equal((await get(lan.port, '/api/health', [['Host', 'good.lan:8700']])).status, 200);
  assert.equal((await get(lan.port, '/api/health', [['Host', 'bad.lan:8700']])).status, 421);
});

// ---- Sec-Fetch-Site / Origin on /api/* ----

test('Sec-Fetch-Site: cross-site and same-site are 403 on /api/*; same-origin, none and absent pass', async () => {
  const h = (v) => [['Host', `127.0.0.1:${main.port}`], ['Sec-Fetch-Site', v]];
  for (const v of ['cross-site', 'same-site', 'Cross-Site', 'same-origin, cross-site']) {
    assert.equal((await get(main.port, '/api/state', h(v))).status, 403, v);
  }
  for (const v of ['same-origin', 'none']) {
    assert.equal((await get(main.port, '/api/state', h(v))).status, 200, v);
  }
  assert.equal((await get(main.port, '/api/archive', h('cross-site'))).status, 403);
  assert.equal((await get(main.port, '/api/state')).status, 200, 'absent header (curl) passes');
});

test('Sec-Fetch-Site is not checked on static files (only /api/*)', async () => {
  assert.equal((await get(main.port, '/', [['Host', `127.0.0.1:${main.port}`], ['Sec-Fetch-Site', 'cross-site']])).status, 200);
});

test('Origin: hostname and port must both match Host on /api/*', async () => {
  const h = (o) => [['Host', `127.0.0.1:${main.port}`], ['Origin', o]];
  for (const o of ['http://evil.test', 'null', 'http://localhost.evil.test:8700', 'ftp://localhost']) {
    assert.equal((await get(main.port, '/api/state', h(o))).status, 403, o);
  }
  assert.equal((await get(main.port, '/api/state', h(`http://127.0.0.1:${main.port}`))).status, 200);
  assert.equal((await get(main.port, '/api/state', h(`http://localhost:${main.port}`))).status, 403);
  assert.equal((await get(main.port, '/api/state', h(`http://[::1]:${main.port}`))).status, 403);
});

test('Origin port must equal the Host port: a loopback origin on another port is 403 (hardening, Phase 5)', async () => {
  const h = (o) => [['Host', `127.0.0.1:${main.port}`], ['Origin', o]];
  for (const o of [`http://localhost:${main.port + 1}`, 'http://localhost:8700', 'http://localhost', 'http://[::1]']) {
    assert.equal((await get(main.port, '/api/state', h(o))).status, 403, o);
  }
});

// ---- headers, methods ----

test('no response carries an Access-Control-* header (no CORS anywhere)', async () => {
  const targets = ['/api/health', '/api/state', '/api/archive', `/api/doc?case=${alphaId()}&doc=state`, '/', '/nope'];
  for (const t of targets) {
    const r = await get(main.port, t);
    for (const k of Object.keys(r.headers)) assert.ok(!k.startsWith('access-control-'), `${t} sends ${k}`);
  }
  const pre = await send(main.port, { method: 'OPTIONS', target: '/api/state' });
  assert.equal(pre.status, 405);
  for (const k of Object.keys(pre.headers)) assert.ok(!k.startsWith('access-control-'), `preflight sends ${k}`);
});

test('non-GET methods are 405 (and a foreign Host is still 421 first)', async () => {
  assert.equal((await send(main.port, { method: 'POST', target: '/api/archive' })).status, 405);
  assert.equal((await send(main.port, { method: 'PUT', target: `/api/doc?case=${alphaId()}&doc=state` })).status, 405);
  assert.equal((await send(main.port, { method: 'DELETE', target: '/api/state' })).status, 405);
  const foreign = await send(main.port, { method: 'POST', target: '/api/archive', headers: [['Host', 'evil.test']] });
  assert.equal(foreign.status, 421);
});

// ---- /api/archive ----

test('GET /api/archive lists the fixture cases with opaque ids, no path, and the fixed doc kinds', async () => {
  const r = await get(main.port, '/api/archive');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/json/);
  const body = JSON.parse(r.body.toString('utf8'));
  assert.equal(body.truncated, false);
  assert.deepEqual(body.cases.map((c) => c.name).sort(), ['alpha', 'beta', 'gamma']);
  for (const c of body.cases) assert.match(c.id, /^[0-9a-f]{16}$/);
  const text = r.body.toString('utf8');
  assert.ok(!text.includes(fx.base), 'no absolute path in the listing');
  assert.ok(!text.includes('..'), 'no .. in the listing');
  const alpha = body.cases.find((c) => c.name === 'alpha');
  assert.equal(alpha.id, alphaId());
  assert.deepEqual(alpha.docs.map((d) => d.kind), ['state', 'plan', 'council-0-decisions', 'council-0-debate', 'shot-0']);
  assert.equal(alpha.docs[2].label, 'alpha', 'the council label is the dir name');
  assert.equal(alpha.live, false, 'demo mode has no live cases');
  assert.deepEqual(body.cases.find((c) => c.name === 'beta').docs.map((d) => d.kind), ['state']);
});

// ---- /api/doc: success headers ----

test('text doc: text/plain, nosniff, CSP default-src none; sandbox, no-store, CORP same-origin, counts in headers', async () => {
  const r = await get(main.port, `/api/doc?case=${alphaId()}&doc=state`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['content-security-policy'], CSP);
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-truncated'], 'false');
  assert.equal(r.headers['x-redacted-count'], '0');
  assert.equal(r.body.toString('utf8'), STATE());
});

test('text doc: named secrets never reach the browser verbatim; the redaction count is shown', async () => {
  const r = await get(main.port, `/api/doc?case=${alphaId()}&doc=council-0-debate`);
  assert.equal(r.status, 200);
  const text = r.body.toString('utf8');
  for (const needle of ['sk-AAAA', 'ghp_BBBB', 'abcdefghijklmnopqrst', 'hunter2']) assert.ok(!text.includes(needle), needle);
  assert.ok(text.includes('[redacted]'));
  assert.equal(r.headers['x-redacted-count'], String(SECRETS.length));
  assert.ok(text.includes('plain line'));
});

test('text doc over the cap is cut at a line with an explicit marker and X-Truncated: true', async () => {
  const r = await get(main.port, `/api/doc?case=${gammaId()}&doc=council-0-debate`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-truncated'], 'true');
  assert.ok(r.body.length <= 256 * 1024 + 64, `body ${r.body.length} bytes`);
  assert.ok(r.body.toString('utf8').endsWith('[recortado]\n'));
});

test('HEAD on a text doc: same headers, empty body', async () => {
  const r = await send(main.port, { method: 'HEAD', target: `/api/doc?case=${alphaId()}&doc=state` });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-security-policy'], CSP);
  assert.equal(r.body.length, 0);
});

test('png doc: image/png, nosniff, CSP, exact bytes', async () => {
  const r = await get(main.port, `/api/doc?case=${alphaId()}&doc=shot-0`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['content-security-policy'], CSP);
  assert.ok(r.body.equals(PNG));
});

// ---- /api/doc: one identical 404 for every refusal ----

test('every refusal from /api/doc is the same 404: identical status, headers and body, byte for byte', async () => {
  const id = alphaId();
  const refusals = {
    'unknown id': `case=0123456789abcdef&doc=state`,
    'uppercase id': `case=${id.toUpperCase()}&doc=state`,
    'short id': `case=0123&doc=state`,
    'dot-dot id': `case=..%2F..%2Fetc&doc=state`,
    'encoded dot-dot id': `case=%2e%2e%2f%2e%2e%2fetc&doc=state`,
    'backslash id': `case=..%5c..%5cetc&doc=state`,
    'NUL id': `case=%00&doc=state`,
    'path as id': `case=${encodeURIComponent(ALPHA_STATE())}&doc=state`,
    'unlisted kind': `case=${id}&doc=plan-x`,
    'kind traversal': `case=${id}&doc=..%2Fstate`,
    'kind NUL': `case=${id}&doc=state%00`,
    'kind upper': `case=${id}&doc=STATE`,
    'shot out of range': `case=${id}&doc=shot-9`,
    'shot zero-padded': `case=${id}&doc=shot-01`,
    'fifo is not a kind': `case=${id}&doc=fifo`,
    'plan not referenced': `case=${betaId()}&doc=plan`,
    'symlink out (decisions)': `case=${betaId()}&doc=council-0-decisions`,
    'other case index (beta has no council)': `case=${betaId()}&doc=council-0-debate`,
    'council index out of range': `case=${id}&doc=council-3-decisions`,
    'council index with dot-dot': `case=${id}&doc=council-..%2F..-decisions`,
    'council index zero-padded': `case=${id}&doc=council-00-decisions`,
    'bare legacy kind (decisions)': `case=${id}&doc=decisions`,
    'missing params': ``,
    'only case': `case=${id}`,
    'only doc': `doc=state`,
    'duplicate case': `case=${id}&case=${id}&doc=state`,
    'extra key': `case=${id}&doc=state&x=1`,
  };
  const baseline = await get(main.port, `/api/doc?case=0123456789abcdef&doc=state`);
  assert.equal(baseline.status, 404);
  assert.equal(baseline.headers['content-security-policy'], CSP);
  assert.equal(baseline.headers['x-content-type-options'], 'nosniff');
  for (const [why, q] of Object.entries(refusals)) {
    const r = await get(main.port, `/api/doc${q ? `?${q}` : ''}`);
    assert.equal(r.status, 404, `${why} -> ${r.status}`);
    assert.deepEqual(noDate(r.headers), noDate(baseline.headers), `${why}: headers differ`);
    assert.ok(r.body.equals(baseline.body), `${why}: body differs`);
  }
});

test('a refusal leaves the server healthy and the listed docs still served', async () => {
  assert.equal((await get(main.port, `/api/doc?case=..%2F..&doc=state`)).status, 404);
  assert.equal((await get(main.port, `/api/doc?case=${alphaId()}&doc=state`)).status, 200);
  assert.equal(main.child.exitCode, null, `server exited; stderr: ${main.stderr()}`);
});

// ---- boot with the idle env (Phase 3 env rule) ----

test('an invalid HOSPITAL_CONDUCTOR_IDLE_MIN logs a warning and boots with 30 min (never exits)', async () => {
  for (const raw of ['abc', '0', '-5']) {
    const srv = await startServer({ HOSPITAL_CONDUCTOR_IDLE_MIN: raw });
    assert.match(srv.stderr(), /HOSPITAL_CONDUCTOR_IDLE_MIN.*using 30/, raw);
    assert.ok(!srv.stderr().includes(`HOSPITAL_CONDUCTOR_IDLE_MIN=${raw}`), 'invalid environment value stays private');
    assert.equal(srv.child.exitCode, null, raw);
  }
});

// ---- archive logging and the non-blocking opens ----

test('list() logs scan error codes only (no path), and records the scan', () => {
  const logs = [];
  const blocked = path.join(fx.root, 'beta', 'plans');
  const realReaddir = fs.readdirSync;
  const fsx = {
    ...fs,
    readdirSync: (p, o) => {
      if (p === blocked) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' });
      return realReaddir(p, o);
    },
  };
  const arc = createArchive({ roots: [fs.realpathSync(fx.root)], fsx, log: (m) => logs.push(m) });
  const r = arc.list();
  assert.ok(logs.some((m) => /EACCES/.test(m)), `no EACCES log: ${JSON.stringify(logs)}`);
  assert.ok(!logs.some((m) => m.includes(fx.base)), 'log lines carry no path');
  assert.ok(r.errors.includes('EACCES'));
  assert.equal(r.cases.length, 2, 'the readable cases are still listed');
});

test('a scan over the cap logs that it was truncated, and lists exactly ARCHIVE_CAP cases', () => {
  const many = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-many-')));
  try {
    for (let i = 0; i <= ARCHIVE_CAP; i += 1) write(path.join(many, `c${i}`, 'plans', `c${i}-state.md`), STATE('none.md'));
    const logs = [];
    const r = createArchive({ roots: [many], log: (m) => logs.push(m) }).list();
    assert.equal(r.truncated, true);
    assert.equal(r.cases.length, ARCHIVE_CAP);
    assert.ok(logs.some((m) => /truncated/.test(m)), JSON.stringify(logs));
  } finally {
    fs.rmSync(many, { recursive: true, force: true });
  }
});

test('readTextDoc and readPngDoc never block on a FIFO (O_NONBLOCK): a FIFO swapped in is refused, not waited on', () => {
  const fifo = path.join(fx.base, 'swapped-state.md');
  execFileSync('mkfifo', [fifo]);
  let out;
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { readTextDoc, readPngDoc } = await import(${JSON.stringify(ARCHIVE_URL)});
      const file = process.argv[1];
      console.log(JSON.stringify([readTextDoc(file, 'state'), readPngDoc(file, 'shot-0')]));
    `, fifo], { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    assert.fail(`the read blocked on a FIFO (${err.code ?? err.message})`);
  } finally {
    fs.rmSync(fifo, { force: true });
  }
  assert.equal(out.trim(), '[null,null]');
});

test('a malformed request target is 400 and the process stays up (a URL parse error used to be an uncaught exception)', async () => {
  const r = await get(main.port, '//[');
  assert.equal(r.status, 400);
  assert.equal((await get(main.port, '/api/health')).status, 200);
  assert.equal(main.child.exitCode, null, `server exited; stderr: ${main.stderr()}`);
});

test('static files carry X-Content-Type-Options: nosniff', async () => {
  const r = await get(main.port, '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

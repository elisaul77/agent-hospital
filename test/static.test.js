// Regression tests for the static/HTTP surface. Starts the real server process on an ephemeral
// port (demo mode) and talks raw HTTP so encoded/malformed paths reach the server unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '..', 'src', 'server.js');

let child;
let port;
let stderr = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
  });
}

// Raw request: `path` is sent exactly as given (no URL normalization).
function raw(method, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForHealth(timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await raw('GET', '/api/health');
      if (r.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > end) throw new Error(`server not healthy within ${timeoutMs} ms; stderr: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  port = await freePort();
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HOSPITAL_MODE: 'demo' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (c) => { stderr += c; });
  await waitForHealth();
});

after(() => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
});

test('GET /%00 is rejected with 400 and does not crash the process', async () => {
  const r = await raw('GET', '/%00');
  assert.equal(r.status, 400);
  assert.equal(child.exitCode, null, `server exited; stderr: ${stderr}`);
});

test('encoded NUL or backslash in the static path is rejected with 400', async () => {
  for (const p of ['/index.html%00', '/js%5Cmap.js', '/%5c']) {
    const r = await raw('GET', p);
    assert.equal(r.status, 400, `${p} -> ${r.status}`);
  }
});

test('path traversal with encoded backslashes never serves server source', async () => {
  const r = await raw('GET', '/js/..%5c..%5csrc/server.js');
  assert.ok([400, 403, 404].includes(r.status), `unexpected ${r.status}`);
  assert.ok(!r.body.includes('import http'), 'server source leaked');
});

test('plain traversal outside public/ is not served', async () => {
  const r = await raw('GET', '/../src/server.js');
  assert.notEqual(r.status, 200);
});

test('POST / returns 405 with a JSON body', async () => {
  const r = await raw('POST', '/');
  assert.equal(r.status, 405);
  assert.deepEqual(JSON.parse(r.body), { error: 'method not allowed' });
});

test('static index is still served on GET /', async () => {
  const r = await raw('GET', '/');
  assert.equal(r.status, 200);
});

test('/api/health is still 200 after the hostile requests above', async () => {
  const r = await raw('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, mode: 'demo' });
  assert.equal(child.exitCode, null, `server exited; stderr: ${stderr}`);
});

// Archive (hospital-5b1 Phase 1): bounded scan of plans/ probes, server-minted case ids, fixed doc kinds,
// serve-time confinement, PNG magic + size cap, text cap, best-effort named-token redaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  caseId, redactText, isPngBuffer, scanCases, createArchive,
  ARCHIVE_CAP, ARCHIVE_TTL_MS, TEXT_MAX_BYTES, PNG_MAX_BYTES, SHOTS_MAX, SCAN_DIR_BUDGET,
} from '../src/archive.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-fake-payload')]);
const STATE = (plan = 'plans/alpha-plan.md', status = 'IN_PROGRESS') => [
  `STATUS: ${status}`,
  'Classification: Tier L · feature · single · urgency normal · uncertainty med · risk low',
  'Owner: Conductor',
  plan === null ? 'Objective: no plan line' : `Plan file: ${plan}`,
  'Objective: SYNTHETIC archive fixture',
  '',
].join('\n');

function write(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

// Tree with: alpha (live, full artifacts + probes), beta (escaping council links), other (COMPLETE, no plan line).
function makeTree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-arch-')));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  const alpha = path.join(root, 'proj', 'plans');
  write(path.join(alpha, 'alpha-state.md'), STATE());
  write(path.join(alpha, 'alpha-plan.md'), '## Phase 1: Intake\n');
  write(path.join(alpha, 'council', 'alpha', 'decisions.md'), 'D1 decided\n');
  write(path.join(alpha, 'council', 'alpha', 'debate.log'), 'debate line\n');
  write(path.join(alpha, 'shots', 'p1 delta ñ.png'), PNG);
  write(path.join(alpha, 'shots', 'fake.png'), 'this is text, not a png\n');
  write(path.join(alpha, 'shots', 'big.png'), Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
  write(path.join(alpha, 'bin-state.md'), Buffer.from([...Buffer.from('STATUS: DONE\n'), 0, 1, 2]));
  write(path.join(outside, 'secret.md'), 'TOP SECRET outside\n');
  write(path.join(outside, 'state-out.md'), STATE());
  write(path.join(outside, 'leak.png'), PNG);
  write(path.join(outside, 'plans', 'x-state.md'), STATE());
  fs.symlinkSync(path.join(outside, 'state-out.md'), path.join(alpha, 'leak-state.md'));
  fs.symlinkSync(path.join(outside, 'leak.png'), path.join(alpha, 'shots', 'leak.png'));
  execFileSync('mkfifo', [path.join(alpha, 'fifo-state.md')]);
  fs.symlinkSync(outside, path.join(root, 'linkdir'));
  fs.mkdirSync(path.join(root, 'evil'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'plans'), path.join(root, 'evil', 'plans'));
  write(path.join(root, 'beta', 'plans', 'beta-state.md'), STATE('none.md'));
  fs.mkdirSync(path.join(root, 'beta', 'plans', 'council', 'beta'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'beta', 'plans', 'council', 'beta', 'decisions.md'));
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'beta', 'plans', 'council', 'beta', 'debate.log'));
  write(path.join(root, 'other', 'plans', 'other-state.md'), STATE(null, 'COMPLETE'));
  return {
    base, root, outside, alpha,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

const idOf = (file) => caseId(fs.realpathSync(file));
const byName = (list) => Object.fromEntries(list.map((c) => [c.name, c]));

test('caseId: 16 lowercase hex, stable for one real path, different for another, never shows the path', () => {
  const id = caseId('/home/x/root/proj/plans/alpha-state.md');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(caseId('/home/x/root/proj/plans/alpha-state.md'), id);
  assert.notEqual(caseId('/home/x/root2/proj/plans/alpha-state.md'), id, 'same project name in another root');
  assert.ok(!id.includes('home') && !id.includes('alpha'));
});

test('scan lists regular, confined, text state files only; symlinks, FIFOs, binaries and escapes are not listed', () => {
  const f = makeTree();
  try {
    const got = scanCases([f.root]);
    assert.deepEqual(Object.keys(byName(got.cases)).sort(), ['alpha', 'beta', 'other']);
    assert.equal(got.cases.length, 3);
    assert.equal(got.truncated, false);
    assert.ok(!got.cases.some((c) => c.name === 'x'), 'a symlinked plans dir is never walked');
  } finally {
    f.cleanup();
  }
});

test('the public listing has no absolute path and no dot-dot anywhere', () => {
  const f = makeTree();
  try {
    const { cases } = createArchive({ roots: [f.root], now: () => 0 }).list();
    const text = JSON.stringify(cases);
    assert.ok(!text.includes(f.base), 'no absolute path');
    assert.ok(!text.includes('..'), 'no dot-dot');
    assert.deepEqual(Object.keys(cases[0]).sort(), ['docs', 'id', 'mtime', 'name', 'project', 'status', 'tier']);
  } finally {
    f.cleanup();
  }
});

test('a case lists only its fixed doc kinds; oversize and fake PNG shots are not listed, indexes are contiguous', () => {
  const f = makeTree();
  try {
    const a = byName(createArchive({ roots: [f.root], now: () => 0 }).list().cases).alpha;
    assert.deepEqual(a.docs, [
      { kind: 'state' }, { kind: 'plan' },
      { kind: 'council-0-decisions', label: 'alpha' }, { kind: 'council-0-debate', label: 'alpha' },
      { kind: 'shot-0', name: 'p1 delta ñ.png' },
    ]);
    assert.equal(a.status, 'IN_PROGRESS');
    assert.equal(a.tier, 'L');
    assert.equal(a.project, 'proj');
    assert.equal(a.name, 'alpha');
  } finally {
    f.cleanup();
  }
});

test('escaping council links are not listed as docs; a plan line pointing outside plans/ gives no plan doc', () => {
  const f = makeTree();
  try {
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const beta = byName(archive.list().cases).beta;
    assert.deepEqual(beta.docs, [{ kind: 'state' }]);
    const other = byName(archive.list().cases).other;
    assert.deepEqual(other.docs, [{ kind: 'state' }], 'no plan line, no plan doc');
    assert.equal(other.status, 'COMPLETE');
  } finally {
    f.cleanup();
  }
});

test('readDoc: each case reads only its own docs; another case id never reaches a file of a different case', () => {
  const f = makeTree();
  try {
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const alphaId = idOf(path.join(f.alpha, 'alpha-state.md'));
    const otherId = idOf(path.join(f.root, 'other', 'plans', 'other-state.md'));
    assert.match(archive.readDoc(otherId, 'state').body, /STATUS: COMPLETE/);
    assert.equal(archive.readDoc(otherId, 'council-0-decisions'), null, 'alpha has decisions, other does not');
    assert.equal(archive.readDoc(otherId, 'shot-0'), null, 'alpha has a shot, other does not');
    assert.match(archive.readDoc(alphaId, 'council-0-decisions').body, /D1 decided/);
  } finally {
    f.cleanup();
  }
});

test('readDoc: unknown or malformed kinds and ids give null (no oracle, no path)', () => {
  const f = makeTree();
  try {
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const alphaId = idOf(path.join(f.alpha, 'alpha-state.md'));
    // Bare council kinds are gone (Fix B): only council-<n>-<type> with a server index is in the enum.
    const kinds = ['exe', 'shot-1', 'shot-01', 'shot-', '../state', 'state/../plan', '%2e%2e%2fstate', 'STATE', '', undefined,
      'decisions', 'debate', 'brief', 'council-0-state', 'council-1-debate', 'council-01-decisions', 'council--1-debate',
      'council-20-decisions', 'council-../decisions', 'council-0/../decisions', 'council-0-decisions/../state'];
    for (const kind of kinds) {
      assert.equal(archive.readDoc(alphaId, kind), null, `kind ${JSON.stringify(kind)}`);
    }
    for (const id of ['../x', '/etc/passwd', '%2e%2e%2f', 'a\u0000b', 'a\\b', alphaId.toUpperCase(), alphaId.slice(1), '0'.repeat(16), '', undefined]) {
      assert.equal(archive.readDoc(id, 'state'), null, `id ${JSON.stringify(id)}`);
    }
  } finally {
    f.cleanup();
  }
});

test('readDoc: a state file that became a symlink after the listing is refused at serve time', () => {
  const f = makeTree();
  try {
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const alphaId = idOf(path.join(f.alpha, 'alpha-state.md'));
    assert.ok(archive.readDoc(alphaId, 'state'));
    fs.rmSync(path.join(f.alpha, 'alpha-state.md'));
    fs.symlinkSync(path.join(f.outside, 'secret.md'), path.join(f.alpha, 'alpha-state.md'));
    assert.equal(archive.readDoc(alphaId, 'state'), null, 'TOCTOU: the link out is not served');
  } finally {
    f.cleanup();
  }
});

test('readDoc: a FIFO or a symlinked shot is refused and never opened', () => {
  const f = makeTree();
  try {
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const alphaId = idOf(path.join(f.alpha, 'alpha-state.md'));
    assert.equal(archive.readDoc(alphaId, 'shot-1'), null, 'the symlinked leak.png is never a listed shot');
    fs.rmSync(path.join(f.alpha, 'shots', 'p1 delta ñ.png'));
    execFileSync('mkfifo', [path.join(f.alpha, 'shots', 'p1 delta ñ.png')]);
    assert.equal(archive.readDoc(alphaId, 'shot-0'), null, 'a FIFO in place of a shot');
  } finally {
    f.cleanup();
  }
});

test('PNG: magic bytes are checked; served as image/png with the file bytes', () => {
  const f = makeTree();
  try {
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const alphaId = idOf(path.join(f.alpha, 'alpha-state.md'));
    const shot = archive.readDoc(alphaId, 'shot-0');
    assert.equal(shot.contentType, 'image/png');
    assert.equal(shot.truncated, false);
    assert.ok(Buffer.isBuffer(shot.body));
    assert.ok(shot.body.equals(PNG));
    assert.equal(isPngBuffer(PNG), true);
    assert.equal(isPngBuffer(Buffer.from('this is text, not a png')), false);
    assert.equal(isPngBuffer(PNG.subarray(0, 7)), false, 'short signature');
  } finally {
    f.cleanup();
  }
});

test('PNG size cap: 2 MB; an oversize PNG is excluded from the listing and any read', () => {
  assert.equal(PNG_MAX_BYTES, 2 * 1024 * 1024);
  const f = makeTree();
  try {
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const alpha = byName(archive.list().cases).alpha;
    assert.ok(!alpha.docs.some((d) => d.name === 'big.png'));
    assert.equal(alpha.docs.filter((d) => d.kind.startsWith('shot-')).length, 1);
  } finally {
    f.cleanup();
  }
});

test('text cap: 256 KB; an oversize plan is cut before a whole line, flagged truncated, with the marker', () => {
  assert.equal(TEXT_MAX_BYTES, 256 * 1024);
  const f = makeTree();
  try {
    fs.writeFileSync(path.join(f.alpha, 'alpha-plan.md'), `## Phase 1: Early\n${'x'.repeat(99)}\n`.repeat(3000));
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const alphaId = idOf(path.join(f.alpha, 'alpha-state.md'));
    const plan = archive.readDoc(alphaId, 'plan');
    assert.equal(plan.contentType, 'text/plain; charset=utf-8');
    assert.equal(plan.truncated, true);
    assert.ok(plan.body.includes('[recortado]'));
    assert.ok(Buffer.byteLength(plan.body, 'utf8') <= TEXT_MAX_BYTES + 64);
    assert.ok(plan.body.startsWith('## Phase 1: Early\n'));
    const state = archive.readDoc(alphaId, 'state');
    assert.equal(state.truncated, false);
  } finally {
    f.cleanup();
  }
});

test('text: a NUL byte refuses the doc (renamed binary); a BOM and CRLF survive; invalid UTF-8 is replaced', () => {
  const f = makeTree();
  try {
    write(path.join(f.alpha, 'council', 'alpha', 'decisions.md'), Buffer.from([0x41, 0x00, 0x42]));
    write(path.join(f.alpha, 'council', 'alpha', 'debate.log'), Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('linea\r\n'), 0xff, 0xfe, 0x0a]));
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const alphaId = idOf(path.join(f.alpha, 'alpha-state.md'));
    assert.equal(archive.readDoc(alphaId, 'council-0-decisions'), null, 'NUL is refused');
    const debate = archive.readDoc(alphaId, 'council-0-debate');
    assert.ok(!debate.body.startsWith('﻿'), 'BOM stripped');
    assert.ok(debate.body.startsWith('linea\r\n'), 'CRLF kept');
    assert.ok(debate.body.includes('�'), 'invalid UTF-8 replaced');
  } finally {
    f.cleanup();
  }
});

test('zero-byte state file is listed with null header fields, never guessed', () => {
  const f = makeTree();
  try {
    write(path.join(f.root, 'empty', 'plans', 'empty-state.md'), '');
    const e = byName(createArchive({ roots: [f.root], now: () => 0 }).list().cases).empty;
    assert.equal(e.status, null);
    assert.equal(e.tier, null);
  } finally {
    f.cleanup();
  }
});

test('redaction: sk-, ghp_, Bearer, AKIA, PEM, key=value and JWT are replaced; SHAs and hex/base64 runs are not', () => {
  const samples = [
    'key sk-proj-AbCdEf1234567890XyZ here',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here',
    'Authorization: Bearer abcdef1234567890TOKENvalue',
    'aws AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD\n-----END RSA PRIVATE KEY-----',
    'OPENAI_API_KEY=abc123def456',
    'password: hunter2hunter2',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  ];
  for (const s of samples) {
    const r = redactText(s);
    assert.equal(r.redacted, 1, s);
    assert.ok(!/sk-proj-AbCd|ghp_abcdef|abcdef1234567890TOKEN|AKIAIOSFODNN|MIIBOgIB|abc123def456|hunter2|eyJhbGciOi/.test(r.text), r.text);
  }
  const sha = 'commit 3f786850e387550fdab836ed7e6dc881de23001b and 9fceb02d0ae598e95dc970b74767f19372d61af8';
  assert.deepEqual(redactText(sha), { text: sha, redacted: 0 });
  const b64 = 'blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbg==';
  assert.deepEqual(redactText(b64), { text: b64, redacted: 0 });
});

test('redaction: the debate.log fixture never returns a secret verbatim and reports the count', () => {
  const f = makeTree();
  try {
    const debate = [
      'Round 1: the key was sk-proj-AbCdEf1234567890XyZ in the env',
      'git push used ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'curl -H "Authorization: Bearer abcdef1234567890TOKENvalue"',
      'aws AKIAIOSFODNN7EXAMPLE leaked',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=',
      '-----END OPENSSH PRIVATE KEY-----',
      'DB_PASSWORD=hunter2hunter2',
      'commit 3f786850e387550fdab836ed7e6dc881de23001b stays',
    ].join('\n');
    write(path.join(f.alpha, 'council', 'alpha', 'debate.log'), debate);
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const got = archive.readDoc(idOf(path.join(f.alpha, 'alpha-state.md')), 'council-0-debate');
    for (const secret of ['sk-proj-AbCdEf', 'ghp_abcdef', 'abcdef1234567890TOKEN', 'AKIAIOSFODNN7', 'b3BlbnNzaC1r', 'hunter2hunter2']) {
      assert.ok(!got.body.includes(secret), secret);
    }
    assert.ok(got.body.includes('3f786850e387550fdab836ed7e6dc881de23001b'), 'SHA untouched');
    assert.equal(got.redacted, 6);
  } finally {
    f.cleanup();
  }
});

test('scan bounds: 500 plans dirs finish under 500 ms and list at most 200 cases, flagged truncated', () => {
  assert.equal(ARCHIVE_CAP, 200);
  assert.equal(SHOTS_MAX, 50);
  assert.equal(SCAN_DIR_BUDGET, 2000);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-bulk-')));
  const root = path.join(base, 'root');
  try {
    for (let i = 0; i < 500; i += 1) write(path.join(root, `p${i}`, 'plans', `s${i}-state.md`), STATE());
    const t0 = performance.now();
    const got = scanCases([root]);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `scan took ${ms.toFixed(0)} ms`);
    assert.equal(got.cases.length, 200);
    assert.equal(got.truncated, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('scan order: newest mtime first; the 200-cap keeps the newest', () => {
  const f = makeTree();
  try {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(f.root, 'other', 'plans', 'other-state.md'), old, old);
    const names = scanCases([f.root]).cases.map((c) => c.name);
    assert.equal(names.at(-1), 'other', 'the COMPLETE case 30 days old stays listed, last');
    assert.equal(names.length, 3);
  } finally {
    f.cleanup();
  }
});

test('two roots with the same project name give two cases with different ids', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-twin-')));
  try {
    write(path.join(base, 'r1', 'proj', 'plans', 'alpha-state.md'), STATE());
    write(path.join(base, 'r2', 'proj', 'plans', 'alpha-state.md'), STATE());
    const got = scanCases([path.join(base, 'r1'), path.join(base, 'r2')]).cases;
    assert.equal(got.length, 2);
    assert.notEqual(got[0].id, got[1].id);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an empty plans dir and an absent root are a plain empty listing, not an error', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-empty-')));
  try {
    fs.mkdirSync(path.join(base, 'proj', 'plans'), { recursive: true });
    const got = scanCases([path.join(base, 'proj'), path.join(base, 'absent')]);
    assert.deepEqual(got.cases, []);
    assert.equal(got.truncated, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('per-dir errors are isolated: an unreadable directory is recorded and the other cases are still listed', () => {
  const f = makeTree();
  try {
    const locked = path.join(f.root, 'locked');
    write(path.join(locked, 'plans', 'locked-state.md'), STATE());
    fs.chmodSync(locked, 0o000);
    try {
      const got = scanCases([f.root]);
      const names = Object.keys(byName(got.cases));
      for (const n of ['alpha', 'beta', 'other']) assert.ok(names.includes(n), `${n} still listed`);
      // root (the container's test stage) reads a 000 directory; any other uid gets EACCES and no case from it.
      if (process.getuid?.() === 0) {
        assert.ok(names.includes('locked'), 'root can read the directory');
        assert.deepEqual(got.errors, []);
      } else {
        assert.ok(!names.includes('locked'));
        assert.ok(got.errors.includes('EACCES'), JSON.stringify(got.errors));
      }
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  } finally {
    f.cleanup();
  }
});

test('cache: a hit does no disk walk; after 30 s the next list rescans', () => {
  assert.equal(ARCHIVE_TTL_MS, 30_000);
  const f = makeTree();
  try {
    let reads = 0;
    const fsx = Object.create(fs);
    fsx.readdirSync = (...args) => { reads += 1; return fs.readdirSync(...args); };
    let clock = 0;
    const archive = createArchive({ roots: [f.root], now: () => clock, fsx });
    archive.list();
    const afterFirst = reads;
    assert.ok(afterFirst > 0);
    clock = 29_000;
    archive.list();
    assert.equal(reads, afterFirst, 'cache hit: no readdir');
    clock = 31_000;
    archive.list();
    assert.ok(reads > afterFirst, 'expired: rescanned');
  } finally {
    f.cleanup();
  }
});

test('cache miss refresh is throttled to 1 s, so bogus ids cannot force a walk per request', () => {
  const f = makeTree();
  try {
    let reads = 0;
    const fsx = Object.create(fs);
    fsx.readdirSync = (...args) => { reads += 1; return fs.readdirSync(...args); };
    let clock = 0;
    const archive = createArchive({ roots: [f.root], now: () => clock, fsx });
    archive.list();
    const base = reads;
    const newFile = path.join(f.root, 'late', 'plans', 'late-state.md');
    write(newFile, STATE());
    clock = 500;
    assert.equal(archive.readDoc('0123456789abcdef', 'state'), null);
    assert.equal(reads, base, 'within 1 s: no walk');
    clock = 1500;
    assert.equal(archive.readDoc(idOf(newFile), 'state')?.contentType, 'text/plain; charset=utf-8', 'after 1 s: a new case is found');
    assert.ok(reads > base);
  } finally {
    f.cleanup();
  }
});

test('the same case id for the live case (realpath of the state file) and its archive entry', () => {
  const f = makeTree();
  try {
    const listed = byName(createArchive({ roots: [f.root], now: () => 0 }).list().cases).alpha;
    assert.equal(listed.id, caseId(fs.realpathSync(path.join(f.alpha, 'alpha-state.md'))));
  } finally {
    f.cleanup();
  }
});

// ---- Phase 5 hardening: live flag bookkeeping (pure helpers used by server.js) ----

test('pruneAbsent drops the keys not in the keep set and returns them; kept keys stay', async () => {
  const { pruneAbsent } = await import('../src/archive.js');
  const map = new Map([['s1', { caseId: 'a' }], ['s2', { caseId: 'b' }], ['s3', { caseId: 'c' }]]);
  const dropped = pruneAbsent(map, new Set(['s2']));
  assert.deepEqual(dropped.sort(), ['s1', 's3']);
  assert.deepEqual([...map.keys()], ['s2']);
});

test('viewWithArchiveIds puts each case its archive id (null without a state file) and does not mutate the view', async () => {
  const { viewWithArchiveIds } = await import('../src/archive.js');
  const view = { agents: {}, cases: { s1: { caseId: 's1', room: 'diagnosis' }, s2: { caseId: 's2' } } };
  const before = JSON.stringify(view);
  const out = viewWithArchiveIds(view, new Map([['s1', { caseId: 'abcdef0123456789' }]]));
  assert.equal(out.cases.s1.archiveId, 'abcdef0123456789');
  assert.equal(out.cases.s1.room, 'diagnosis');
  assert.equal(out.cases.s2.archiveId, null);
  assert.equal(JSON.stringify(view), before);
});

// ---- Fix B (hospital-5b1): every direct subdirectory of plans/council, server index n, label = dir name ----

function makeCouncilTree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-council-')));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  const plans = path.join(root, 'hosp', 'plans');
  write(path.join(plans, 'hosp-state.md'), STATE('none.md'));
  write(path.join(plans, 'council', 'hospital-4b', 'decisions.md'), 'D 4b\n');
  write(path.join(plans, 'council', 'hospital-4b', 'debate.log'), 'debate 4b\n');
  write(path.join(plans, 'council', 'hospital-4b', 'brief.md'), 'brief 4b\n');
  write(path.join(plans, 'council', 'hospital-5b1', 'decisions.md'), 'D 5b1\n');
  // Escapes: a symlinked council dir, a dot dir, a dir whose decisions is a link out, and a whole council/ link out.
  write(path.join(outside, 'council-x', 'decisions.md'), 'SECRET council outside\n');
  fs.symlinkSync(path.join(outside, 'council-x'), path.join(plans, 'council', 'linked'));
  write(path.join(plans, 'council', '.hidden', 'decisions.md'), 'hidden dot dir\n');
  fs.mkdirSync(path.join(plans, 'council', 'leaky'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'council-x', 'decisions.md'), path.join(plans, 'council', 'leaky', 'decisions.md'));
  write(path.join(root, 'sym', 'plans', 'sym-state.md'), STATE('none.md'));
  fs.symlinkSync(path.join(outside, 'council-x'), path.join(root, 'sym', 'plans', 'council'));
  write(path.join(root, 'other', 'plans', 'other-state.md'), STATE(null, 'COMPLETE'));
  return {
    base, root, plans, cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test('council: every direct subdirectory is listed (not one stem), each with decisions, debate and brief; labels are the dir names', () => {
  const f = makeCouncilTree();
  try {
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const hosp = byName(archive.list().cases).hosp;
    assert.deepEqual(hosp.docs, [
      { kind: 'state' },
      { kind: 'council-0-decisions', label: 'hospital-4b' },
      { kind: 'council-0-debate', label: 'hospital-4b' },
      { kind: 'council-0-brief', label: 'hospital-4b' },
      { kind: 'council-1-decisions', label: 'hospital-5b1' },
    ]);
    const id = idOf(path.join(f.plans, 'hosp-state.md'));
    assert.match(archive.readDoc(id, 'council-0-brief').body, /brief 4b/);
    assert.match(archive.readDoc(id, 'council-1-decisions').body, /D 5b1/);
  } finally {
    f.cleanup();
  }
});

test('council confinement: symlinked council dir, dot dir, dir with a link out and a symlinked council/ are never listed or served', () => {
  const f = makeCouncilTree();
  try {
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const cases = byName(archive.list().cases);
    assert.deepEqual(cases.sym.docs, [{ kind: 'state' }], 'council/ itself a symlink: no council docs');
    const labels = cases.hosp.docs.filter((d) => d.label).map((d) => d.label);
    for (const bad of ['linked', '.hidden', 'leaky']) assert.ok(!labels.includes(bad), bad);
    assert.ok(!JSON.stringify(archive.list()).includes('SECRET'), 'no outside content in the listing');
    const hospId = idOf(path.join(f.plans, 'hosp-state.md'));
    assert.equal(archive.readDoc(hospId, 'council-2-decisions'), null, 'no index 2: the escapes are not listed');
    assert.equal(archive.readDoc(idOf(path.join(f.root, 'sym', 'plans', 'sym-state.md')), 'council-0-decisions'), null);
  } finally {
    f.cleanup();
  }
});

test('council index probes: ../ in the index, an index out of range, and another case\'s index are all null', () => {
  const f = makeCouncilTree();
  try {
    const archive = createArchive({ roots: [f.root], now: () => 0 });
    const hospId = idOf(path.join(f.plans, 'hosp-state.md'));
    const otherId = idOf(path.join(f.root, 'other', 'plans', 'other-state.md'));
    for (const kind of ['council-../decisions', 'council-0/../decisions', 'council-2-decisions', 'council-9-debate', 'council-19-brief', 'council-20-decisions']) {
      assert.equal(archive.readDoc(hospId, kind), null, kind);
    }
    assert.equal(archive.readDoc(otherId, 'council-0-decisions'), null, 'other has no council: its index 0 is nothing');
    assert.equal(archive.readDoc(otherId, 'council-1-decisions'), null, 'hosp index 1 is not other');
    assert.match(archive.readDoc(hospId, 'council-1-decisions').body, /D 5b1/);
  } finally {
    f.cleanup();
  }
});

test('council: at most 20 council dirs are listed, in name order; the 21st is never reachable', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-cap-')));
  try {
    const plans = path.join(base, 'root', 'big', 'plans');
    write(path.join(plans, 'big-state.md'), STATE('none.md'));
    for (let i = 0; i < 25; i += 1) write(path.join(plans, 'council', `d${String(i).padStart(2, '0')}`, 'decisions.md'), `D${i}\n`);
    const archive = createArchive({ roots: [path.join(base, 'root')], now: () => 0 });
    const decisions = byName(archive.list().cases).big.docs.filter((d) => d.kind.endsWith('-decisions'));
    assert.equal(decisions.length, 20);
    assert.deepEqual(decisions.map((d) => d.label).slice(0, 2), ['d00', 'd01']);
    assert.equal(decisions[19].label, 'd19');
    const id = idOf(path.join(plans, 'big-state.md'));
    assert.equal(archive.readDoc(id, 'council-19-decisions').body, 'D19\n');
    assert.equal(archive.readDoc(id, 'council-20-decisions'), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

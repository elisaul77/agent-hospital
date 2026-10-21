// Case-file counters (Phase 4 revision): `Re-routes: N` and `Diagnosis rounds without new evidence: N` in the
// state file header drive the `exhausted` and `stall` (sin evidencia) escalations. Thresholds: >=3 and >=2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCounters, loadCaseFile } from '../src/casefile.js';
import { reduce, EMPTY_STATE } from '../src/state.js';

const S = 'case-counters';
const T = 2_000_000;
const counters = (reroutes, diagnosisRounds) => ({ t: T, kind: 'case_counters', sessionId: S, reroutes, diagnosisRounds });
const apply = (ev) => reduce(EMPTY_STATE({ trustedDemo: true }), ev);
const reasons = (s) => s.escalations.map((e) => e.reason);

test('parseCounters reads both counters from the header and null when absent', () => {
  const text = 'STATUS: IN_PROGRESS\nRe-routes: 3\nDiagnosis rounds without new evidence: 2\n';
  assert.deepEqual(parseCounters(text), { reroutes: 3, diagnosisRounds: 2 });
  assert.deepEqual(parseCounters('STATUS: DONE\n'), { reroutes: null, diagnosisRounds: null });
});

test('parseCounters ignores counters that appear only after the header (line 40 onwards)', () => {
  const body = `${'filler\n'.repeat(40)}Re-routes: 5\n`;
  assert.equal(parseCounters(body).reroutes, null);
});

test('loadCaseFile carries the counters next to the header fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hospital-counters-'));
  const file = path.join(dir, 'x-state.md');
  fs.writeFileSync(file, 'STATUS: IN_PROGRESS\nRe-routes: 1\nDiagnosis rounds without new evidence: 0\n');
  try {
    const cf = loadCaseFile(file);
    assert.equal(cf.status, 'IN_PROGRESS');
    assert.deepEqual(cf.counters, { reroutes: 1, diagnosisRounds: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Re-routes >= 3 from the case file escalates exhausted; 2 does not', () => {
  assert.deepEqual(reasons(apply(counters(3, null))), ['exhausted']);
  assert.equal(apply(counters(3, null)).escalations[0].caseId, S);
  assert.deepEqual(reasons(apply(counters(2, null))), []);
});

test('2 diagnosis rounds without new evidence escalate stall with the sin evidencia label; 1 does not', () => {
  const s = apply(counters(null, 2));
  assert.deepEqual(reasons(s), ['stall']);
  assert.match(s.escalations[0].label, /sin evidencia/);
  assert.deepEqual(reasons(apply(counters(null, 1))), []);
});

test('null or missing counters escalate nothing, and the case file never invents a count', () => {
  assert.deepEqual(reasons(apply(counters(null, null))), []);
});

test('a repeated case-file counter does not ring twice until the user answers', () => {
  const s1 = apply(counters(3, 2));
  const s2 = reduce(s1, { ...counters(3, 2), t: T + 1000 });
  assert.deepEqual(reasons(s2).sort(), ['exhausted', 'stall']);
  const cleared = reduce(s2, { t: T + 2000, kind: 'user_message', sessionId: S });
  assert.deepEqual(cleared.escalations, []);
});

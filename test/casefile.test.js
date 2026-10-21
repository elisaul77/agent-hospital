// Case-file header parser (plans/*-state.md) and the case-directory confinement (Phase 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseCaseFile, parseAcceptedRisks, parseCaseDirs, resolveCaseDir, latestCaseFile, DEFAULT_CASE_DIRS,
} from '../src/casefile.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('parses STATUS, Tier, case kind and plan file from the header', () => {
  const text = fs.readFileSync(path.join(here, 'fixtures', 'case-state.md'), 'utf8');
  assert.deepEqual(parseCaseFile(text), {
    status: 'IN_PROGRESS', tier: 'L', caseKind: 'feature', planFile: 'plans/fixture-plan.md',
  });
});

test('missing or unknown header fields are null, never invented', () => {
  const r = parseCaseFile('Owner: someone\nno status here\n');
  assert.equal(r.status, null);
  assert.equal(r.tier, null);
  assert.equal(r.planFile, null);
});

test('an unknown tier letter is rejected', () => {
  assert.equal(parseCaseFile('STATUS: DONE\nClassification: Tier Z · fix\n').tier, null);
});

test('ACCEPTED_RISK needs item, em dash, user words and an ISO date; malformed lines are ignored', () => {
  const text = [
    'ACCEPTED_RISK: Nombre de sala por confirmar — ok, déjalo así — 2026-10-18',
    'ACCEPTED_RISK: Sin fecha — ok —',
    'ACCEPTED_RISK: Guion en vez de raya - ok - 2026-10-18',
    'Entiendo que aceptas el riesgo, ok 2026-10-18',
  ].join('\n');
  assert.deepEqual(parseAcceptedRisks(text), [
    { item: 'Nombre de sala por confirmar', userWords: 'ok, déjalo así', date: '2026-10-18' },
  ]);
});

test('case dirs default to the two mounted roots; invalid entries are rejected, not guessed', () => {
  assert.deepEqual(parseCaseDirs(undefined).roots, DEFAULT_CASE_DIRS);
  assert.deepEqual(parseCaseDirs('').roots, DEFAULT_CASE_DIRS);
  const r = parseCaseDirs('/data/a:relative/b:/data/c');
  assert.deepEqual(r.roots, ['/data/a', '/data/c']);
  assert.deepEqual(r.rejected, ['relative/b']);
});

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-case-')));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'proj', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, 'root-evil', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj', 'plans', 'x-state.md'), 'STATUS: DONE\n');
  fs.writeFileSync(path.join(root, 'root-evil', 'plans', 'e-state.md'), 'STATUS: DONE\n');
  fs.writeFileSync(path.join(outside, 'plans', 'y-state.md'), 'STATUS: DONE\n');
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.symlinkSync(path.join(outside, 'plans', 'y-state.md'), path.join(root, 'proj', 'plans', 'evil-state.md'));
  return { base, root, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('case dirs are confined to the mounted roots, symlinks and prefix siblings included', () => {
  const f = fixture();
  try {
    const roots = [f.root];
    assert.equal(resolveCaseDir(path.join(f.root, 'proj'), roots), path.join(f.root, 'proj', 'plans'));
    assert.equal(resolveCaseDir(path.join(f.root, 'link'), roots), null, 'symlink escapes the root');
    assert.equal(resolveCaseDir(f.outside, roots), null, 'outside the root');
    assert.equal(resolveCaseDir(f.root + '-evil', roots), null, 'prefix sibling');
    assert.equal(resolveCaseDir(path.join(f.root, 'proj', '..', '..', 'outside'), roots), null, 'dot-dot');
    assert.equal(resolveCaseDir('relative/path', roots), null, 'relative');
    assert.equal(resolveCaseDir(path.join(f.root, 'missing'), roots), null, 'missing');
  } finally {
    f.cleanup();
  }
});

test('latest state file skips symlinks that resolve outside the roots', () => {
  const f = fixture();
  try {
    const got = latestCaseFile(path.join(f.root, 'proj', 'plans'), [f.root]);
    assert.equal(got?.file, path.join(f.root, 'proj', 'plans', 'x-state.md'));
    assert.equal(typeof got?.key, 'string');
  } finally {
    f.cleanup();
  }
});

// ---- Phase 4b: plan headings, plan confinement, read cap, reducer seam ----
// Namespace import: the new names may be missing until src/casefile.js gets them, so only these tests fail.
const casefile4b = await import('../src/casefile.js');
const { parsePlanPhases, planFileOf, loadPlanPhases, normalizePhases, PLAN_MAX_BYTES, PHASES_MAX, PHASE_TITLE_MAX } = casefile4b;

test('plan parser: ## Phase headings give id and title, in document order', () => {
  const text = '# Plan\n\n## Phase 1: Intake\nbody\n\n## Phase 2 — Tests\n\n## Phase 3b. Late fix\n';
  assert.deepEqual(parsePlanPhases(text), [
    { id: '1', title: 'Intake' },
    { id: '2', title: 'Tests' },
    { id: '3b', title: 'Late fix' },
  ]);
});

test('plan parser: nested ### headings are ignored when ## Phase headings exist', () => {
  const text = '## Phase 1: Real\n### Phase 1.1: Summary copy\n## Phase 2: Next\n';
  assert.deepEqual(parsePlanPhases(text).map((p) => p.id), ['1', '2']);
});

test('plan parser: ### Phase headings are the fallback only when there is no ## Phase heading', () => {
  const text = '## Phases\n### Phase 1: Visible app\n### Phase 2: Live\n';
  assert.deepEqual(parsePlanPhases(text), [{ id: '1', title: 'Visible app' }, { id: '2', title: 'Live' }]);
});

test('plan parser: fenced code blocks are ignored (backtick and tilde fences)', () => {
  const text = '```md\n## Phase 9: Example\n```\n~~~\n## Phase 8: Also example\n~~~\n## Phase 1: Real\n';
  assert.deepEqual(parsePlanPhases(text), [{ id: '1', title: 'Real' }]);
});

test('plan parser: a duplicate id keeps the first heading (summaries repeat "Phase 1")', () => {
  const text = '## Phase 1: First\n## Phase 2: Two\n## Phase 1: Summary again\n';
  assert.deepEqual(parsePlanPhases(text), [{ id: '1', title: 'First' }, { id: '2', title: 'Two' }]);
});

test('plan parser: at most 24 phases and titles at most 40 characters', () => {
  assert.equal(PHASES_MAX, 24);
  assert.equal(PHASE_TITLE_MAX, 40);
  const many = Array.from({ length: 30 }, (_, i) => `## Phase ${i + 1}: Step ${i + 1}`).join('\n');
  const got = parsePlanPhases(many);
  assert.equal(got.length, 24);
  assert.equal(got.at(-1).id, '24');
  const long = parsePlanPhases(`## Phase 1: ${'x'.repeat(100)}`)[0].title;
  assert.equal(long.length, 40);
});

test('plan parser: a heading without a title is named by its id; control characters are removed', () => {
  assert.deepEqual(parsePlanPhases('## Phase 4\n'), [{ id: '4', title: 'Phase 4' }]);
  assert.deepEqual(parsePlanPhases('## Phase 5: a\u0007b\n'), [{ id: '5', title: 'a b' }]);
});

test('plan parser: no phase headings, or non-text input, gives []', () => {
  assert.deepEqual(parsePlanPhases('# Only a title\n'), []);
  assert.deepEqual(parsePlanPhases(undefined), []);
});

test('plan parser: real-shaped sample (### fallback, fence, dupe, 3b, long title)', () => {
  const text = fs.readFileSync(path.join(here, 'fixtures', 'hospital-plan-sample.md'), 'utf8');
  assert.deepEqual(parsePlanPhases(text), [
    { id: '1', title: 'Visible app in Docker, demo mode' },
    { id: '3b', title: 'Late fix with a very long title that goe' },
  ]);
});

test('normalizePhases (reducer seam) drops ids that are not phase ids, clips titles and caps', () => {
  assert.deepEqual(normalizePhases([
    { id: '1', title: 'ok' }, { id: '../x', title: 'bad' }, { id: '2', title: 'y'.repeat(60) },
  ]), [{ id: '1', title: 'ok' }, { id: '2', title: 'y'.repeat(40) }]);
  assert.deepEqual(normalizePhases(null), []);
});

function planFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-plan-')));
  const root = path.join(base, 'root');
  const plans = path.join(root, 'proj', 'plans');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(plans, 'hospital-plan.md'), '## Phase 1: Ok\n');
  fs.writeFileSync(path.join(outside, 'secret.md'), '## Phase 9: Leaked\n');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(plans, 'link-plan.md'));
  return { base, root, plans, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('plan file is resolved by basename inside the confined plans dir; traversal, absolute, NUL and symlinks rejected', () => {
  const f = planFixture();
  try {
    const roots = [f.root];
    assert.equal(planFileOf(f.plans, 'plans/hospital-plan.md', roots)?.file, path.join(f.plans, 'hospital-plan.md'));
    assert.equal(planFileOf(f.plans, '../../outside/secret.md', roots), null, 'dot-dot escape');
    assert.equal(planFileOf(f.plans, '/etc/hospital-plan.md', roots), null, 'absolute path');
    assert.equal(planFileOf(f.plans, 'plans/../hospital-plan.md', roots), null, 'dot-dot inside the ref');
    assert.equal(planFileOf(f.plans, 'hospital-plan.md\u0000', roots), null, 'NUL byte');
    assert.equal(planFileOf(f.plans, 'link-plan.md', roots), null, 'symlink escapes plans dir');
    assert.equal(planFileOf(f.plans, 'absent.md', roots), null, 'missing file');
    assert.equal(planFileOf(f.plans, undefined, roots), null, 'no plan reference');
  } finally {
    f.cleanup();
  }
});

test('plan read is capped at 256 KB: headings past the cap are not read', () => {
  const f = planFixture();
  try {
    assert.equal(PLAN_MAX_BYTES, 256 * 1024);
    fs.writeFileSync(path.join(f.plans, 'hospital-plan.md'), `## Phase 1: Early\n${'x'.repeat(PLAN_MAX_BYTES)}\n## Phase 2: Too late\n`);
    const got = loadPlanPhases(f.plans, 'plans/hospital-plan.md', [f.root]);
    assert.deepEqual(got.phases, [{ id: '1', title: 'Early' }]);
    assert.equal(typeof got.key, 'string');
  } finally {
    f.cleanup();
  }
});

test('no readable plan gives no phases and a null key (never guessed)', () => {
  const f = planFixture();
  try {
    assert.deepEqual(loadPlanPhases(f.plans, 'plans/absent.md', [f.root]), { phases: [], key: null });
    assert.deepEqual(loadPlanPhases(f.plans, 'link-plan.md', [f.root]), { phases: [], key: null });
  } finally {
    f.cleanup();
  }
});

// ---- Phase 4b revision (2026-10-18, user options a+d): header progress from state.md ----
// Namespace again: these names are new, so only the tests below fail before src/casefile.js has them.
const casefileRev = await import('../src/casefile.js');
const PLAN_3B = '## Phase 1: A\n## Phase 2: B\n## Phase 3: C\n## Phase 3b: C fix\n## Phase 4: D\n## Phase 5: E\n';
const PLAN_NO_3B = '## Phase 1: A\n## Phase 2: B\n## Phase 3: C\n## Phase 4: D\n## Phase 5: E\n';

test('header progress: Completed tokens (3b included), APPROVED lines, parens and ; are read as ids only', () => {
  const text = fs.readFileSync(path.join(here, 'fixtures', 'case-state-mixed.md'), 'utf8');
  assert.deepEqual(casefileRev.parseCaseProgress(text), {
    doneIds: ['1', '2', '3b', '3', '4'], currentId: '5', complete: false,
  });
});

test('header progress: a sub-phase id maps to the plan heading with the same id (3b)', () => {
  const text = fs.readFileSync(path.join(here, 'fixtures', 'case-state-mixed.md'), 'utf8');
  const plan = casefileRev.parsePlanPhases(PLAN_3B);
  // 1,2,3,3b,4 done; the current patient is 5 (index 5): the file says 5 phases are behind it.
  assert.equal(casefileRev.phasesDoneFromFile(casefileRev.parseCaseProgress(text), plan), 5);
});

test('header progress: an id the plan lacks is ignored; the done prefix stops at the first open phase', () => {
  const text = fs.readFileSync(path.join(here, 'fixtures', 'case-state-mixed.md'), 'utf8');
  const plan = casefileRev.parsePlanPhases(PLAN_NO_3B);
  // 3b is not in this plan. 1..4 are done and 5 is current: 4 phases behind it.
  assert.equal(casefileRev.phasesDoneFromFile(casefileRev.parseCaseProgress(text), plan), 4);
});

test('header progress: the last Current line wins over a stale one', () => {
  const plan = casefileRev.parsePlanPhases(PLAN_NO_3B);
  const text = 'Current: Phase 2 (old)\nCurrent: Phase 4 (new)\n';
  assert.equal(casefileRev.parseCaseProgress(text).currentId, '4');
  assert.equal(casefileRev.phasesDoneFromFile(casefileRev.parseCaseProgress(text), plan), 3);
});

test('header progress: a number inside parentheses is not a completed phase', () => {
  assert.deepEqual(casefileRev.parseCaseProgress('Completed phases: 1 (see 2; 3b)\n').doneIds, ['1']);
});

test('header progress: STATUS: COMPLETE is terminal and case-insensitive; other values are not', () => {
  assert.equal(casefileRev.parseCaseProgress('STATUS: COMPLETE\n').complete, true);
  assert.equal(casefileRev.parseCaseProgress('STATUS: complete\n').complete, true);
  assert.equal(casefileRev.parseCaseProgress('STATUS: Complete\n').complete, true);
  assert.equal(casefileRev.parseCaseProgress('STATUS: IN_PROGRESS\nSTATUS: COMPLETE\n').complete, false);
  assert.equal(casefileRev.parseCaseProgress('STATUS: COMPLETE — done\n').complete, false);
});

test('header progress: malformed or missing lines give no ids, so the transcripts decide (0 here)', () => {
  const plan = casefileRev.parsePlanPhases(PLAN_3B);
  for (const text of ['', 'Completed phases: ??? ; x\nCurrent: none\n', 'Current: Phase 99 (not in plan)\n', 'STATUS: DONE\n']) {
    const p = casefileRev.parseCaseProgress(text);
    assert.equal(casefileRev.phasesDoneFromFile(p, plan), 0, JSON.stringify(text));
  }
});

test('header progress: only the first 40 lines are read', () => {
  const text = `${'filler\n'.repeat(40)}Completed phases: 1\n`;
  assert.deepEqual(casefileRev.parseCaseProgress(text).doneIds, []);
});

test('loadCaseFile carries the progress next to the header fields', () => {
  const file = path.join(here, 'fixtures', 'case-state-mixed.md');
  const cf = casefileRev.loadCaseFile(file);
  assert.equal(cf.progress.currentId, '5');
  assert.deepEqual(cf.progress.doneIds, ['1', '2', '3b', '3', '4']);
});

test('loadCaseFile refuses a swapped symlink or FIFO without following or blocking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-case-swap-'));
  const file = path.join(dir, 'current-state.md');
  const other = path.join(dir, 'other-state.md');
  try {
    fs.writeFileSync(file, 'STATUS: IN_PROGRESS\n');
    fs.writeFileSync(other, 'STATUS: COMPLETE\n');
    const st = fs.statSync(file);
    const expected = { file, dev: st.dev, ino: st.ino, size: st.size };
    fs.unlinkSync(file);
    fs.symlinkSync(other, file);
    assert.throws(() => casefileRev.loadCaseFile(file, 1024, expected));
    fs.unlinkSync(file);
    execFileSync('mkfifo', [file]);
    assert.throws(() => casefileRev.loadCaseFile(file, 1024, expected));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- Phase 1 (hospital-5b1): one shared confinement helper for plans/ files (planFileOf uses it) ----
// Namespace import: confineInPlans is new, so only these tests fail before src/casefile.js has it.
const casefile5b1 = await import('../src/casefile.js');
const confine = (plansDir, segments, roots) => casefile5b1.confineInPlans(plansDir, segments, roots);

test('confineInPlans: plain segments inside plans/ resolve to the real file; the same key shape as planFileOf', () => {
  const f = planFixture();
  try {
    const got = confine(f.plans, ['hospital-plan.md'], [f.root]);
    assert.equal(got?.file, path.join(f.plans, 'hospital-plan.md'));
    assert.match(got.key, /\|\d+(\.\d+)?\|\d+$/);
  } finally {
    f.cleanup();
  }
});

test('confineInPlans: dot-dot, dot, empty, absolute, NUL, backslash and extra segments are refused', () => {
  const f = planFixture();
  try {
    const roots = [f.root];
    for (const segs of [['..'], ['.'], [''], ['a/../hospital-plan.md'], ['/etc/passwd'], ['hospital-plan.md\u0000'],
      ['a\\b'], [], ['hospital-plan.md', '..'], ['..', 'plans', 'hospital-plan.md']]) {
      assert.equal(confine(f.plans, segs, roots), null, JSON.stringify(segs));
    }
  } finally {
    f.cleanup();
  }
});

test('confineInPlans: a symlink that leaves plans/ is refused, through a file or a directory alike', () => {
  const f = planFixture();
  try {
    const roots = [f.root];
    assert.equal(confine(f.plans, ['link-plan.md'], roots), null, 'file symlink out');
    fs.symlinkSync(path.join(f.base, 'outside'), path.join(f.plans, 'council-out'));
    assert.equal(confine(f.plans, ['council-out', 'secret.md'], roots), null, 'directory symlink out');
    assert.equal(confine(f.plans, ['hospital-plan.md', 'x'], roots), null, 'a file is not a directory');
  } finally {
    f.cleanup();
  }
});

test('confineInPlans: a nested regular file is accepted; a directory, a missing name and a root-less plans dir are not', () => {
  const f = planFixture();
  try {
    fs.mkdirSync(path.join(f.plans, 'council', 'a'), { recursive: true });
    fs.writeFileSync(path.join(f.plans, 'council', 'a', 'decisions.md'), 'D1\n');
    assert.equal(confine(f.plans, ['council', 'a', 'decisions.md'], [f.root])?.file,
      path.join(f.plans, 'council', 'a', 'decisions.md'));
    assert.equal(confine(f.plans, ['council'], [f.root]), null, 'directory, not a file');
    assert.equal(confine(f.plans, ['absent.md'], [f.root]), null, 'missing');
    assert.equal(confine(f.plans, ['hospital-plan.md'], [path.join(f.base, 'elsewhere')]), null, 'outside every root');
  } finally {
    f.cleanup();
  }
});

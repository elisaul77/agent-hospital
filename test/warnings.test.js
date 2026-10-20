// Warnings gate (subagent-pool v9.12): parser shapes checked against real handbacks, then the
// reducer rules: nothing reaches Discharge or the next phase while a warning is open/acceptable/must fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warningsOf, rulingsOf, WARNING_TEXT_MAX, WARNING_ITEMS_MAX } from '../src/warnings.js';
import { reduce, EMPTY_STATE } from '../src/state.js';

// ---- parser: WARNINGS: block (implementer handback) ----

test('no WARNINGS line means zero warnings', () => {
  assert.deepEqual(warningsOf('STATUS: DONE\nNOT_VERIFIED: nothing\nNEXT: complete').items, []);
});

test('WARNINGS: none (inline or as a bullet) means zero warnings', () => {
  assert.deepEqual(warningsOf('WARNINGS: none\nNEXT: complete').items, []);
  assert.deepEqual(warningsOf('WARNINGS:\n- none\nNEXT: complete').items, []);
  assert.deepEqual(warningsOf('WARNINGS: None.').items, []);
});

test('two bullets make two items and the block ends at the next KEY line', () => {
  const msg = 'STATUS: DONE\nWARNINGS:\n- Live state keeps every agent.\n- Source starts on first request.\nNOT_VERIFIED: soak\nNEXT: complete';
  assert.deepEqual(warningsOf(msg).items, ['Live state keeps every agent.', 'Source starts on first request.']);
});

test('a wrapped bullet is joined into its item; numbered lists work too', () => {
  const wrapped = 'WARNINGS:\n- first item that\n  wraps onto two lines\n- second';
  assert.deepEqual(warningsOf(wrapped).items, ['first item that wraps onto two lines', 'second']);
  assert.deepEqual(warningsOf('WARNINGS:\n1. one\n2. two\nNEXT: x').items, ['one', 'two']);
});

test('plain text without bullets is one item (whole text fallback)', () => {
  assert.deepEqual(warningsOf('WARNINGS: edge case not covered\nNEXT: complete').items, ['edge case not covered']);
});

test('items are truncated to 120 chars, sanitized, and capped in count', () => {
  const long = 'x'.repeat(200);
  assert.equal(warningsOf(`WARNINGS:\n- ${long}`).items[0].length, WARNING_TEXT_MAX);
  const ctl = warningsOf('WARNINGS:\n- a\u0007b\u001bc\nNEXT: x').items;
  assert.deepEqual(ctl, ['a b c']);
  const many = Array.from({ length: 30 }, (_, i) => `- item ${i}`).join('\n');
  assert.equal(warningsOf(`WARNINGS:\n${many}`).items.length, WARNING_ITEMS_MAX);
});

test('the key is case-sensitive and WARNINGS_RULING is not a WARNINGS block', () => {
  assert.deepEqual(warningsOf('warnings: lower case is not a key\n- x').items, []);
  assert.deepEqual(warningsOf('WARNINGS_RULING:\n- a: fixed').items, []);
});

// ---- parser: WARNINGS_RULING: block (reviewer handback) ----

test('rulings map fixed, acceptable and must fix per line and stop at the next KEY', () => {
  const msg = 'STATUS: NEEDS_REVISION\nWARNINGS_RULING:\n- Falta prueba de borde: fixed\n- Nombre de sala — acceptable\n- Riesgo de tiempo: must fix\nDEVIATION_VERDICT:\n  - ok';
  assert.deepEqual(rulingsOf(msg), [
    { index: 0, label: 'Falta prueba de borde', ruling: 'fixed' },
    { index: 1, label: 'Nombre de sala', ruling: 'acceptable' },
    { index: 2, label: 'Riesgo de tiempo', ruling: 'must_fix' },
  ]);
});

test('a prose ruling without a label separator is not a ruling (item stays open)', () => {
  const msg = 'WARNINGS_RULING: The prompt did not include a separate list, which I rule acceptable.\nDEVIATION_VERDICT:';
  assert.deepEqual(rulingsOf(msg), []);
});

test('bare token, label with a colon, unknown token, and an ALL-CAPS label', () => {
  const msg = 'WARNINGS_RULING:\n- fixed\n- a: b: fixed\n- maybe later\n- API: must fix\n';
  assert.deepEqual(rulingsOf(msg), [
    { index: 0, label: '', ruling: 'fixed' },
    { index: 1, label: 'a: b', ruling: 'fixed' },
    { index: 2, label: 'API', ruling: 'must_fix' },
  ]);
});

test('no WARNINGS_RULING line means no rulings', () => {
  assert.deepEqual(rulingsOf('STATUS: APPROVED\nWARNINGS: none'), []);
});

// ---- reducer: the gate ----

const T0 = 2_000_000;
const run = (evs) => evs.reduce((s, ev) => reduce(s, ev), EMPTY_STATE({ trustedDemo: true }));
const spawn = (agentId, subagentType) => ({ t: T0, kind: 'agent_spawn', sessionId: 'c1', agentId, subagentType, parentAgentId: 'main' });
const open = (items, agentId = 'i1') => ({ t: T0 + 1, kind: 'warning_open', sessionId: 'c1', agentId, items });
const rule = (label, index, ruling, agentId = 'r1') => ({ t: T0 + 2, kind: 'warning_ruling', sessionId: 'c1', agentId, label, index, ruling });
const done = (agentId, verdict, extra = {}) => ({ t: T0 + 3, kind: 'agent_done', sessionId: 'c1', agentId, verdict, ...extra });
const caseOf = (s) => s.cases.c1;
const stateOf = (s) => caseOf(s).warnings.map((w) => w.state);

test('no warnings: APPROVED on the last phase discharges', () => {
  const c = caseOf(run([spawn('i1', 'implement-agent'), spawn('r1', 'review-agent'), done('r1', 'APPROVED', { final: true })]));
  assert.equal(c.room, 'discharge');
  assert.equal(c.status, 'discharged');
});

test('WARNINGS: none is the same as no warnings', () => {
  const c = caseOf(run([spawn('i1', 'implement-agent'), spawn('r1', 'review-agent'), done('r1', 'APPROVED', { final: true })]));
  assert.equal(c.warnings.length, 0);
});

test('APPROVED with only an acceptable item is held at the gate, never discharged', () => {
  const s = run([spawn('i1', 'implement-agent'), open(['Nombre de sala']), spawn('r1', 'review-agent'),
    rule('Nombre de sala', 0, 'acceptable'), done('r1', 'APPROVED', { final: true })]);
  const c = caseOf(s);
  assert.deepEqual(stateOf(s), ['acceptable']);
  assert.equal(c.held, 'discharge');
  assert.equal(c.room, 'radiology');
  assert.equal(c.status, 'active');
  assert.equal(c.phasesDone, 0);
});

test('APPROVED with a must fix ruling is NEEDS_REVISION: back to operating, phase not closed', () => {
  const s = run([spawn('i1', 'implement-agent'), open(['Falta prueba']), spawn('r1', 'review-agent'),
    rule('Falta prueba', 0, 'must_fix'), done('r1', 'APPROVED', { final: true })]);
  const c = caseOf(s);
  assert.equal(c.room, 'operating');
  assert.equal(c.status, 'active');
  assert.equal(c.phasesDone, 0);
  assert.equal(c.held, null);
});

test('an unruled open warning becomes unruled when the reviewer closes; it holds APPROVED; a later ruling releases the held close', () => {
  const s1 = run([spawn('i1', 'implement-agent'), open(['Riesgo de tiempo']), spawn('r1', 'review-agent'),
    done('r1', 'APPROVED', { final: true })]);
  assert.deepEqual(stateOf(s1), ['unruled']);
  assert.equal(caseOf(s1).held, 'discharge');
  assert.equal(caseOf(s1).status, 'active');
  const s2 = reduce(s1, rule('Riesgo de tiempo', 0, 'fixed'));
  assert.deepEqual(stateOf(s2), ['fixed']);
  assert.equal(caseOf(s2).room, 'discharge');
  assert.equal(caseOf(s2).status, 'discharged');
});

test('prose-only rulings: the reviewer closes, its open items become unruled, and the gate stays closed', () => {
  const s = run([spawn('i1', 'implement-agent'), open(['Riesgo de tiempo', 'Nombre de sala']), spawn('r1', 'review-agent'),
    done('r1', 'APPROVED', { final: true })]);
  const c = caseOf(s);
  assert.deepEqual(stateOf(s), ['unruled', 'unruled']);
  assert.equal(c.held, 'discharge');
  assert.equal(c.status, 'active');
  assert.equal(c.room, 'radiology');
});

test('a per-item ruling after a prose close resolves its unruled item; the held close waits for the whole gate', () => {
  const s1 = run([spawn('i1', 'implement-agent'), open(['Riesgo de tiempo', 'Nombre de sala']), spawn('r1', 'review-agent'),
    done('r1', 'APPROVED', { final: true })]);
  const s2 = reduce(s1, rule('Riesgo de tiempo', 0, 'fixed', 'r2'));
  assert.deepEqual(stateOf(s2), ['fixed', 'unruled']);
  assert.equal(caseOf(s2).held, 'discharge');
  assert.equal(caseOf(s2).status, 'active');
  const s3 = reduce(s2, rule('Nombre de sala', 1, 'fixed', 'r2'));
  assert.deepEqual(stateOf(s3), ['fixed', 'fixed']);
  assert.equal(caseOf(s3).room, 'discharge');
  assert.equal(caseOf(s3).status, 'discharged');
});

test('a reviewer handback without a STATUS does not close: its items stay open', () => {
  const s = run([spawn('i1', 'implement-agent'), open(['alpha item']), spawn('r1', 'review-agent'), done('r1')]);
  assert.deepEqual(stateOf(s), ['open']);
});

test('a codex review handback closes like a review-agent: its open items become unruled', () => {
  const s = run([spawn('i1', 'implement-agent'), open(['alpha item']), { ...spawn('c1', 'codex-agent'), mode: 'review' },
    done('c1', 'NEEDS_REVISION')]);
  assert.deepEqual(stateOf(s), ['unruled']);
});

test('an implementer handback never turns its own open items into unruled', () => {
  const s = run([spawn('i1', 'implement-agent'), open(['alpha item']), done('i1', 'NEEDS_REVISION')]);
  assert.deepEqual(stateOf(s), ['open']);
});

test('a ruling with no matching label falls back to the item index of the latest batch', () => {
  const s = run([spawn('i1', 'implement-agent'), open(['alpha item', 'beta item']), spawn('r1', 'review-agent'),
    rule('zzz unrelated', 1, 'fixed'), rule('zzz unrelated', 0, 'acceptable')]);
  assert.deepEqual(stateOf(s), ['acceptable', 'fixed']);
});

test('a ruling that matches nothing leaves the item open', () => {
  const s = run([spawn('i1', 'implement-agent'), open(['alpha item']), spawn('r1', 'review-agent'), rule('other', 5, 'fixed')]);
  assert.deepEqual(stateOf(s), ['open']);
});

test('the three rulings give three distinct states on one handback', () => {
  const s = run([spawn('i1', 'implement-agent'), open(['uno aviso', 'dos aviso', 'tres aviso']), spawn('r1', 'review-agent'),
    rule('uno aviso', 0, 'fixed'), rule('dos aviso', 1, 'acceptable'), rule('tres aviso', 2, 'must_fix'), done('r1', 'NEEDS_REVISION')]);
  assert.deepEqual(stateOf(s), ['fixed', 'acceptable', 'must_fix']);
  assert.equal(caseOf(s).room, 'operating');
});

test('a case with an open warning on its last phase never reaches discharge, whatever the verdict order', () => {
  const s = run([spawn('i1', 'implement-agent'), open(['pendiente']), spawn('r1', 'review-agent'),
    done('r1', 'APPROVED', { final: true }), done('r1', 'APPROVED', { final: true })]);
  assert.notEqual(caseOf(s).status, 'discharged');
  assert.notEqual(caseOf(s).room, 'discharge');
});

test('warning_open on a closed case is ignored (closed cases do not reopen)', () => {
  const s = run([spawn('i1', 'implement-agent'), spawn('r1', 'review-agent'), done('r1', 'APPROVED', { final: true }),
    open(['tarde'])]);
  assert.equal(caseOf(s).status, 'discharged');
  assert.equal(caseOf(s).warnings.length, 0);
});

// ---- randomized event orders: the gate invariant holds after every event ----

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRun(seed, steps = 120) {
  const r = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const texts = ['aviso uno', 'aviso dos', 'aviso tres', 'otro punto'];
  let s = run([{ t: T0, kind: 'triage', sessionId: 'c1', tier: 'M', caseKind: 'feature' }]);
  const reviewers = [];
  const implementers = [];
  let n = 0;
  for (let k = 0; k < steps; k++) {
    const roll = r();
    let ev;
    if (roll < 0.2 || (!reviewers.length && !implementers.length)) {
      const agentId = `a${++n}`;
      const type = pick(['planning-agent', 'implement-agent', 'review-agent']);
      if (type === 'review-agent') reviewers.push(agentId); else if (type === 'implement-agent') implementers.push(agentId);
      ev = { t: T0 + k, kind: 'agent_spawn', sessionId: 'c1', agentId, subagentType: type, parentAgentId: 'main' };
    } else if (roll < 0.4) {
      const items = Array.from({ length: Math.floor(r() * 4) }, () => pick(texts));
      ev = { t: T0 + k, kind: 'warning_open', sessionId: 'c1', agentId: pick(implementers.length ? implementers : ['x']), items };
      if (!implementers.length) continue;
    } else if (roll < 0.65) {
      const c = caseOf(s);
      const label = r() < 0.7 && c?.warnings.length ? pick(c.warnings).text : '';
      ev = { t: T0 + k, kind: 'warning_ruling', sessionId: 'c1', agentId: pick(reviewers.length ? reviewers : ['x']),
        label, index: Math.floor(r() * 3), ruling: pick(['fixed', 'acceptable', 'must_fix']) };
      if (!reviewers.length) continue;
    } else if (roll < 0.9) {
      const all = [...reviewers, ...implementers];
      if (!all.length) continue;
      const agentId = pick(all);
      ev = { t: T0 + k, kind: 'agent_done', sessionId: 'c1', agentId,
        verdict: pick([undefined, 'APPROVED', 'APPROVED', 'NEEDS_REVISION', 'FAILED']),
        failureOrigin: pick([null, 'implementation', 'hypothesis', 'scope']), final: r() < 0.4 };
    } else if (roll < 0.95) {
      ev = { t: T0 + k, kind: 'triage', sessionId: 'c1', tier: 'M', caseKind: 'feature' };
    } else {
      ev = { t: T0 + k, kind: 'case_status', sessionId: 'c1', status: pick(['ACTIVE', 'STOPPED']) };
    }
    s = reduce(s, ev);
  }
  return s;
}

test('randomized event orders: nothing in discharge while any warning blocks, and held implies a pending close', () => {
  let discharged = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const s = randomRun(seed);
    const c = caseOf(s);
    if (!c) continue;
    const blocking = c.warnings.some((w) => ['open', 'unruled', 'acceptable', 'must_fix'].includes(w.state));
    if (c.room === 'discharge' || c.status === 'discharged') {
      discharged++;
      assert.equal(blocking, false, `seed ${seed}: discharge with a blocking warning`);
    }
    if (c.held) assert.ok(c.pendingClose, `seed ${seed}: held without pendingClose`);
  }
  assert.ok(discharged > 0, 'the random walk should reach discharge sometimes, or the test proves nothing');
});

test('randomized event orders: the gate invariant holds after every single event', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const r = mulberry32(seed * 7919);
    let s = run([{ t: T0, kind: 'triage', sessionId: 'c1', tier: 'M', caseKind: 'feature' }]);
    const reviewers = [];
    const implementers = [];
    for (let k = 0; k < 80; k++) {
      const pick = (xs) => xs[Math.floor(r() * xs.length)];
      const roll = r();
      if (roll < 0.25 || (!reviewers.length && !implementers.length)) {
        const agentId = `b${k}`;
        const type = pick(['implement-agent', 'review-agent']);
        (type === 'review-agent' ? reviewers : implementers).push(agentId);
        s = reduce(s, { t: T0 + k, kind: 'agent_spawn', sessionId: 'c1', agentId, subagentType: type, parentAgentId: 'main' });
      } else if (roll < 0.45) {
        s = reduce(s, { t: T0 + k, kind: 'warning_open', sessionId: 'c1', agentId: pick(implementers),
          items: [`w${k}`, `v${k}`].slice(0, 1 + Math.floor(r() * 2)) });
      } else if (roll < 0.7) {
        s = reduce(s, { t: T0 + k, kind: 'warning_ruling', sessionId: 'c1', agentId: pick(reviewers),
          label: '', index: Math.floor(r() * 2), ruling: pick(['fixed', 'acceptable', 'must_fix']) });
      } else {
        s = reduce(s, { t: T0 + k, kind: 'agent_done', sessionId: 'c1', agentId: pick([...reviewers, ...implementers]),
          verdict: pick(['APPROVED', 'NEEDS_REVISION']), final: r() < 0.5 });
      }
      const c = caseOf(s);
      const blocking = c.warnings.some((w) => ['open', 'unruled', 'acceptable', 'must_fix'].includes(w.state));
      assert.ok(!((c.room === 'discharge' || c.status === 'discharged') && blocking), `seed ${seed} step ${k}`);
    }
  }
});

// ---- acceptance (b): the demo scenario, replayed through the reducer without timers ----

import { caseSteps } from '../src/demo.js';

// The demo's conductor is spawned once by startDemo, outside caseSteps.
const conductor = { t: T0, kind: 'agent_spawn', sessionId: 'demo-x', agentId: 'main', subagentType: 'conductor' };

const replay = (withAcceptable) => {
  let s = reduce(EMPTY_STATE({ trustedDemo: true }), conductor);
  for (const step of caseSteps('demo-x', withAcceptable)) {
    if (typeof step.make !== 'function') continue;
    s = reduce(s, { t: T0, ...step.make('demo-x') });
  }
  return s;
};

test('demo scenario: must fix binds, held close waits, the ruling releases it into Discharge', () => {
  let s = reduce(EMPTY_STATE({ trustedDemo: true }), conductor);
  const seen = [];
  for (const step of caseSteps('demo-x', false)) {
    if (typeof step.make !== 'function') continue;
    s = reduce(s, { t: T0, ...step.make('demo-x') });
    const c = s.cases['demo-x'];
    if (c) seen.push({ room: c.room, status: c.status, held: c.held, states: c.warnings.map((w) => w.state) });
  }
  assert.ok(seen.some((x) => x.held === 'discharge' && x.status === 'active'), 'the gurney is held at the Discharge door');
  assert.ok(seen.some((x) => x.states.includes('must_fix') && x.room === 'operating'), 'must fix sends the case back to operating');
  const last = seen[seen.length - 1];
  assert.equal(last.room, 'discharge');
  assert.equal(last.status, 'discharged');
  assert.deepEqual(last.states, ['fixed', 'fixed', 'fixed']);
});

test('demo scenario with an acceptable item: held without a signed risk line, never discharged', () => {
  // Phase 3 property, kept: only an ACCEPTED_RISK line (the risk_accepted event) lifts an acceptable item.
  let s = reduce(EMPTY_STATE({ trustedDemo: true }), conductor);
  for (const step of caseSteps('demo-x', true)) {
    if (typeof step.make !== 'function') continue;
    const ev = { t: T0, ...step.make('demo-x') };
    if (ev.kind === 'risk_accepted') continue;
    s = reduce(s, ev);
  }
  const c = s.cases['demo-x'];
  assert.equal(c.status, 'active');
  assert.notEqual(c.room, 'discharge');
  assert.equal(c.held, 'discharge');
  assert.ok(c.warnings.some((w) => w.state === 'acceptable'));
});

test('demo scenario with an acceptable item: the signed risk line lifts the gate and the case is discharged', () => {
  // Phase 4: the demo signs the risk in the case file (risk_accepted); the held close then completes.
  let s = reduce(EMPTY_STATE({ trustedDemo: true }), conductor);
  let signedWhileHeld = false;
  for (const step of caseSteps('demo-x', true)) {
    if (typeof step.make !== 'function') continue;
    const ev = { t: T0, ...step.make('demo-x') };
    if (ev.kind === 'risk_accepted') {
      signedWhileHeld = s.cases['demo-x'].held === 'discharge';
      assert.ok(s.cases['demo-x'].warnings.some((w) => w.state === 'acceptable'));
    }
    s = reduce(s, ev);
  }
  assert.ok(signedWhileHeld, 'the risk is signed while the gurney waits at the Discharge door');
  assert.equal(s.cases['demo-x'].status, 'discharged');
  assert.equal(s.cases['demo-x'].accepted.length, 1);
});

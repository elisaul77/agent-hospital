// Scripted synthetic stream for demo mode. Emits events in the same schema the live tailer will
// emit (see state.js header), so Phase 2 only swaps the source. Loops forever with a new session
// per cycle: triage -> diagnosis -> operating (implementer leaves WARNINGS) -> review rules them ->
// NEEDS_REVISION (must fix binds an APPROVED) -> operating -> review APPROVED held at the Discharge door
// until a ruling clears the last warning -> discharge. Odd cycles leave one acceptable item waiting for the user.

const CONDUCTOR = 'main';

// Phase 4b: the demo case is a five-phase plan (ids and titles as the plan parser would give them).
const DEMO_PHASES = [
  { id: '1', title: 'Diagnóstico del fallo' },
  { id: '2', title: 'Cambio en el modelo' },
  { id: '3b', title: 'Ajuste de la sala' },
  { id: '4', title: 'Pruebas de regresión' },
  { id: '5', title: 'Integración' },
];

// One step = wait `wait` ms, then emit make(sid).
const S = (wait, make) => ({ wait, make });

export function caseSteps(sid, withAcceptable) {
  let n = 0;
  const toolId = (agentId) => `${agentId}:${++n}`;
  const spawn = (agentId, subagentType, description, extra = {}) =>
    (sid2) => ({ kind: 'agent_spawn', sessionId: sid2, agentId, subagentType, parentAgentId: CONDUCTOR, description, ...extra });
  const done = (agentId, extra = {}) => (sid2) => ({ kind: 'agent_done', sessionId: sid2, agentId, ...extra });
  const warn = (agentId, items) => (sid2) => ({ kind: 'warning_open', sessionId: sid2, agentId, items });
  const ruling = (agentId, label, index, token) => (sid2) => ({ kind: 'warning_ruling', sessionId: sid2, agentId, label, index, ruling: token });
  // Two steps: start the tool, then end it after `dur` ms.
  const use = (agentId, tool, label, dur) => {
    const id = toolId(agentId);
    return [
      S(400, (s) => ({ kind: 'tool_start', sessionId: s, agentId, tool, label, toolUseId: id })),
      S(dur, (s) => ({ kind: 'tool_end', sessionId: s, agentId, toolUseId: id })),
    ];
  };
  const msg = (from, to) => (s) => ({ kind: 'message_send', sessionId: s, from, to });
  const plan = `${sid}-plan`, expl = `${sid}-explore`, impl1 = `${sid}-impl-1`, rev1 = `${sid}-rev-1`;
  const impl2 = `${sid}-impl-2`, rev2 = `${sid}-rev-2`;

  const steps = [
    S(800, (s) => ({ kind: 'triage', sessionId: s, tier: 'M', caseKind: 'feature', phases: DEMO_PHASES })),
    ...use(CONDUCTOR, 'Read', 'plans/hospital-plan.md', 1200),
    S(400, spawn(plan, 'planning-agent', 'Plan de fase')),
    ...use(plan, 'Grep', 'src/**', 1000),
    ...use(plan, 'Bash', 'graphify query', 1400),
    S(300, spawn(expl, 'Explore', 'Buscar precedentes')),
    ...use(expl, 'WebSearch', 'pixel-art canvas', 1200),
    S(200, done(expl)),
    S(500, done(plan)),
    S(700, spawn(impl1, 'implement-agent', 'Cambio 1')),
    ...use(impl1, 'Edit', 'src/state.js', 1500),
    ...use(impl1, 'Bash', 'node --test test/', 2000),
    S(300, warn(impl1, ['Falta prueba del caso de borde', 'Nombre de sala por confirmar'])),
    S(400, done(impl1)),
    // A consult (mode=consult) sits at the security desk of the Specialist pool; it never reviews or closes a phase.
    S(300, spawn(`${sid}-consult`, 'review-agent', 'Consulta: seguridad', { mode: 'consult', specialty: 'security' })),
    ...use(`${sid}-consult`, 'Read', 'src/state.js', 1100),
    S(200, done(`${sid}-consult`)),
    S(600, spawn(rev1, 'review-agent', 'Revisión 1')),
    S(300, msg(impl1, rev1)),
    ...use(rev1, 'Read', 'src/state.js', 1300),
    S(200, ruling(rev1, 'Falta prueba del caso de borde', 0, 'must_fix')),
    S(200, ruling(rev1, 'Nombre de sala por confirmar', 1, withAcceptable ? 'acceptable' : 'fixed')),
    // APPROVED with a must fix is NEEDS_REVISION (binding rule): the case goes back to operating.
    S(300, done(rev1, { verdict: 'APPROVED' })),
    S(700, spawn(impl2, 'implement-agent', 'Corrección')),
    ...use(impl2, 'Edit', 'src/state.js', 1500),
    S(300, warn(impl2, ['Riesgo de tiempo sin medir'])),
    S(300, done(impl2)),
    S(600, spawn(rev2, 'review-agent', 'Revisión 2')),
    ...use(rev2, 'Bash', 'node --test test/', 1500),
    S(200, ruling(rev2, 'Falta prueba del caso de borde', 0, 'fixed')),
    // The last warning is not ruled yet, so this APPROVED waits at the Discharge door.
    S(300, done(rev2, { verdict: 'APPROVED', final: true })),
    // The ruling that clears the gate: the held close completes and the gurney reaches Discharge.
    // (With an acceptable item still waiting for the user, the gate stays closed.)
    S(2500, ruling(rev2, 'Riesgo de tiempo sin medir', 0, 'fixed')),
  ];
  // Odd cycles: the user signs the waiting risk in the case file; the signed card lifts the gate.
  if (withAcceptable) {
    steps.push(S(1500, (s) => ({
      kind: 'risk_accepted', sessionId: s,
      items: [{ item: 'Nombre de sala por confirmar', userWords: 'ok, déjalo así', date: '2026-10-18' }],
    })));
  }
  // Council debate: four robed members pass the case around by tube, then the case waits for Direction.
  const council = [['spec', 'council-spec'], ['architect', 'council-architect'], ['lateral', 'council-lateral'], ['risk', 'council-risk']]
    .map(([k, type]) => ({ id: `${sid}-c-${k}`, type }));
  for (const c of council) steps.push(S(300, spawn(c.id, c.type, `Consejo: ${c.type.slice(8)}`)));
  steps.push(S(500, msg(council[0].id, council[1].id)));
  steps.push(S(900, msg(council[1].id, council[2].id)));
  steps.push(S(900, msg(council[2].id, council[3].id)));
  steps.push(S(900, msg(council[3].id, council[0].id)));
  for (const c of council) steps.push(S(200, done(c.id)));
  // Merge gate: a delegate runs `git merge` and holds at the Direction door until the user answers
  // (the answer is a user message). The Conductor never executes git in the demo.
  const merger = `${sid}-merge`;
  // general-purpose: a spawn of an implement agent would move a held case back to Operating (state.js).
  steps.push(S(800, spawn(merger, 'general-purpose', 'Integrar main')));
  steps.push(S(300, (s) => ({ kind: 'approval_pending', sessionId: s, agentId: merger, action: 'git merge' })));
  steps.push(S(7000, (s) => ({ kind: 'user_message', sessionId: s })));
  return steps;
}

/**
 * @param {(ev: object) => void} emit receives events without t; the caller stamps t
 * @param {{gapMs?: number}} [opts]
 * @returns {() => void} stop function
 */
export function startDemo(emit, { gapMs = 6000 } = {}) {
  let timer = null;
  let stopped = false;
  let cycle = 0;

  const fire = (ev) => emit({ t: Date.now(), ...ev });

  fire({ kind: 'agent_spawn', sessionId: 'demo', agentId: CONDUCTOR, subagentType: 'conductor', description: 'Conductor' });

  const runCycle = (steps, sid, i) => {
    if (stopped) return;
    if (i >= steps.length) {
      timer = setTimeout(() => { cycle++; startCycle(); }, gapMs);
      return;
    }
    const step = steps[i];
    timer = setTimeout(() => {
      fire(step.make(sid));
      runCycle(steps, sid, i + 1);
    }, step.wait);
  };

  const startCycle = () => {
    const sid = `demo-${cycle}`;
    runCycle(caseSteps(sid, cycle % 2 === 0), sid, 0);
  };

  startCycle();
  return () => { stopped = true; clearTimeout(timer); };
}

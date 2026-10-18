// Event schema (shared by the demo source and the transcript tailer):
//   every event: { t: epochMs, kind, sessionId?, agentId? , ...kind fields }
//   kinds:
//     agent_spawn    {sessionId, agentId, subagentType, description?, parentAgentId?, mode?}
//     agent_link     {agentId, toolUseId}
//     tool_start     {agentId, tool, label, toolUseId}          label <= 60 chars, never prompt/result text
//     tool_end       {agentId, toolUseId?}
//     message_send   {from, to}                                  SendMessage (capsule in Phase 4)
//     agent_done     {agentId, verdict?, failureOrigin?, final?}
//     warning_open   {sessionId, agentId, items[]}               implementer WARNINGS items (text <=120)
//     warning_ruling {sessionId, agentId, index, label, ruling}  ruling: fixed | acceptable | must_fix
//     triage         {sessionId, tier, caseKind}
//     case_status    {sessionId, status}
//     risk_accepted  {sessionId, items[{item, userWords, date}]}   ACCEPTED_RISK lines of the case file (Phase 4)
//     approval_pending {sessionId, agentId?, action}               git merge/push, docker push, npm publish (Direction).
//                                                                 agentId = the agent whose Bash/handback asked: it holds
//                                                                 at the Direction door (holdingAt). No agentId = case file gate.
//     case_counters {sessionId, reroutes, diagnosisRounds}         header counters of the case file (null = absent)
//     user_message   {sessionId}                                   a user-role message in the main transcript
//     question       {sessionId}                                   main assistant turn ending with '?' and no tool_use
//     idle_tick      {conductorIdleMs?}                           prunes idle Conductors (Phase 3)
//   agent_done may carry blocked: true (STATUS: BLOCKED without an approval keyword).
//
// The reducer is pure: reduce(state, ev) -> new state (never mutates). derive(state, now) adds
// time-based flags (sleeping / stalled) and prunes finished agents for the view.
//
// Case gate (subagent-pool v9.12): a case with a warning in state open | unruled | acceptable | must_fix never
// enters Discharge and never closes its phase. APPROVED while blocked is held at the Discharge door
// (`held`, `pendingClose`) and closes by itself once the warnings clear. APPROVED with a must_fix
// ruling is NEEDS_REVISION. Revisions beyond MAX_REVISIONS escalate the case to reception.

import { roleOf, isConsult, specialtyToken } from './roles.js';
import { sanitize, WARNING_TEXT_MAX, WARNING_ITEMS_MAX } from './warnings.js';
import { ESCALATION_LABEL } from './escalation.js';
import { ACCEPTED_MAX, normalizePhases } from './casefile.js';

export const IDLE_MS = 5 * 60 * 1000;
export const STALL_MS = 120 * 1000;
export const HANDBACK_TTL_MS = 4000;
// Phase 3 (decisions D13): a Conductor walks out after this long without events (HOSPITAL_CONDUCTOR_IDLE_MIN).
export const CONDUCTOR_IDLE_MIN_DEFAULT = 30;
export const CONDUCTOR_IDLE_MS = CONDUCTOR_IDLE_MIN_DEFAULT * 60 * 1000;
// Phase 5a: a finished agent walks out of its room for this long, then leaves the derived view (goneAt).
export const LEAVE_MS = HANDBACK_TTL_MS;
export const MAX_CASES = 4;
export const MAX_MESSAGES = 10;
export const MAX_REVISIONS = 2;
export const ASK_USER_MS = 15 * 1000;
export const MAX_ESCALATIONS = 20;
// Case-file counters (state file header): this many re-routes, or this many diagnosis rounds without evidence.
export const EXHAUSTED_REROUTES = 3;
export const STALL_DIAGNOSIS_ROUNDS = 2;
const EVIDENCE_STALL_LABEL = 'sin evidencia · 2 rondas de diagnóstico';
// Phase 5a escalation rules (tokens and hashes only, the text is never kept).
const PROGRESS_STALL_LABEL = 'sin progreso';
const CONVERGE_STALL_LABEL = 'no converge';

// unruled: a reviewer closed its handback without a per-item ruling for this item. Never guessed into a
// state: the gate stays closed until a later per-item ruling (or a later reviewer) resolves it.
const BLOCKING = new Set(['open', 'unruled', 'acceptable', 'must_fix']);
const RULABLE = new Set(['open', 'unruled', 'must_fix']);
const RULING_STATE = { fixed: 'fixed', acceptable: 'acceptable', must_fix: 'must_fix' };

export function EMPTY_STATE() {
  return { t: 0, agents: {}, cases: {}, messages: [], escalations: [], question: null, userT: 0 };
}

/**
 * Parses HOSPITAL_CONDUCTOR_IDLE_MIN. Unset or empty: default, no warning. Anything that is not a finite positive
 * number of minutes (abc, 0, -5, NaN, Infinity): default plus a warning for the caller to log. Never throws.
 * @returns {{ms: number, minutes: number, warning: string|null}}
 */
export function parseConductorIdleMin(raw) {
  const fallback = { ms: CONDUCTOR_IDLE_MS, minutes: CONDUCTOR_IDLE_MIN_DEFAULT, warning: null };
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  const ms = n * 60_000;
  // Phase 5 hardening: at least 1 minute, and the millisecond product must stay finite (1e308 min overflows).
  if (Number.isFinite(n) && n >= 1 && Number.isFinite(ms)) return { ms, minutes: n, warning: null };
  return {
    ...fallback,
    warning: `HOSPITAL_CONDUCTOR_IDLE_MIN=${raw} is not a number of minutes >= 1 (finite); using ${CONDUCTOR_IDLE_MIN_DEFAULT}`,
  };
}

// Role -> case room, applied when such an agent is spawned (case moves only on transitions).
const CASE_ROOM_BY_ROLE = { planning: 'diagnosis', implement: 'operating', review: 'radiology' };

const clip = (s, n = 60) => String(s ?? '').slice(0, n);
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

// One active escalation per (session, case, reason). A cleared one may ring again later.
// `label` overrides the reason's label (e.g. stall from the case file reads "sin evidencia").
function addEscalation(s, sessionId, caseId, reason, t, label = ESCALATION_LABEL[reason]) {
  const dup = s.escalations.some((e) => e.sessionId === sessionId && e.caseId === caseId && e.reason === reason && e.label === label);
  if (dup) return s;
  const minute = Math.floor(t / 60000);
  const e = { id: `${caseId}|${reason}|${minute}|${label}`, sessionId, caseId, reason, label, t };
  return { ...s, escalations: [...s.escalations, e].slice(-MAX_ESCALATIONS) };
}

function ensureCase(s, sessionId, t) {
  if (s.cases[sessionId]) return s.cases[sessionId];
  return {
    caseId: sessionId, room: 'reception', tier: null, caseKind: null,
    status: 'active', phasesDone: 0, verdict: null, fileStatus: null, lastT: t,
    warnings: [], warningSeq: 0, batchSeq: 0,
    held: null, pendingClose: null, revisions: 0, escalated: null,
    accepted: [], approval: null, planPhases: [],
    noProgress: 0, requiredHash: null,
  };
}

function putCase(s, c) {
  s.cases = { ...s.cases, [c.caseId]: c };
  return s;
}

function requireAgent(s, agentId) {
  const a = s.agents[agentId];
  if (!a) throw new Error(`unknown agent ${agentId}`);
  return a;
}

// Any room change ends a held close: the case is working again (or re-triaged).
function moveRoom(c, room, t) {
  return { ...c, room, held: null, pendingClose: null, lastT: t };
}

const blockingOf = (c) => c.warnings.filter((w) => BLOCKING.has(w.state));
const gateClosed = (c) => blockingOf(c).length > 0;
const hasState = (c, state) => c.warnings.some((w) => w.state === state);

// Implementation loop: back to operating; past MAX_REVISIONS the case goes to reception (escalated).
function loopBack(c, t) {
  const revisions = c.revisions + 1;
  const base = { ...c, held: null, pendingClose: null, revisions, lastT: t };
  if (revisions > MAX_REVISIONS) {
    return { ...base, room: 'reception', status: 'escalated', escalated: 'revisions_exhausted' };
  }
  return { ...moveRoom(base, 'operating', t), revisions };
}

// The only way into Discharge or a closed phase. Blocked closes are held, never applied.
function closePhase(c, final, t) {
  if (gateClosed(c)) return { ...c, held: 'discharge', pendingClose: { final: Boolean(final) }, lastT: t };
  const next = { ...c, phasesDone: c.phasesDone + 1, held: null, pendingClose: null, revisions: 0, lastT: t };
  if (final) return { ...next, room: 'discharge', status: 'discharged' };
  return next;
}

// After a ruling: release a held close once the gate is clear, or loop back on a must fix.
function settle(c, t) {
  if (!c.pendingClose || c.status !== 'active') return c;
  if (hasState(c, 'must_fix')) return loopBack(c, t);
  return closePhase(c, c.pendingClose.final, t);
}

// Reviewer closed without ruling these items: open -> unruled (only on an active case).
function leaveUnruled(c, t) {
  if (c.status !== 'active' || !hasState(c, 'open')) return c;
  return {
    ...c, lastT: t,
    warnings: c.warnings.map((w) => (w.state === 'open' ? { ...w, state: 'unruled' } : w)),
  };
}

// Verdict -> case transition (brief). Only active cases move.
function applyVerdict(c, ev) {
  if (c.status !== 'active') return c;
  const t = ev.t;
  const next = { ...c, verdict: ev.verdict };
  if (ev.verdict === 'APPROVED') {
    // Binding rule (SKILL.md §7 rule 3): APPROVED with a must fix is NEEDS_REVISION.
    if (hasState(c, 'must_fix')) return loopBack(next, t);
    return closePhase(next, ev.final, t);
  }
  if (ev.verdict === 'NEEDS_REVISION') return loopBack(next, t);
  if (ev.verdict === 'FAILED') {
    if (ev.failureOrigin === 'implementation') return loopBack(next, t);
    const byOrigin = { hypothesis: 'diagnosis', scope: 'triage' };
    // Unknown origin: keep the room and record the verdict; the brief has no rule for it.
    const released = { ...next, held: null, pendingClose: null };
    return byOrigin[ev.failureOrigin] ? moveRoom(released, byOrigin[ev.failureOrigin], t) : released;
  }
  return next;
}

const wordsOf = (s) => new Set(
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 3),
);

// Shared words, >= 60 % of the shorter side. Used for rulings and for ACCEPTED_RISK item matches.
function similar(a, b) {
  const want = wordsOf(a);
  const have = wordsOf(b);
  if (!want.size || !have.size) return false;
  let common = 0;
  for (const x of want) if (have.has(x)) common++;
  return common / Math.min(want.size, have.size) >= 0.6;
}

// Ruling -> warning. Label similarity first (shared words, >= 60 %), else the item index of the latest batch.
function matchWarning(c, label, index) {
  const open = c.warnings.filter((w) => RULABLE.has(w.state));
  if (!open.length) return null;
  const want = wordsOf(label);
  if (want.size) {
    let best = null;
    let bestScore = 0;
    for (const w of open) {
      const have = wordsOf(w.text);
      let common = 0;
      for (const x of want) if (have.has(x)) common++;
      const score = common / Math.min(want.size, have.size || 1);
      if (score > bestScore) { best = w; bestScore = score; }
    }
    if (best && bestScore >= 0.6) return best;
  }
  const inBatch = c.warnings.filter((w) => w.batch === c.batchSeq && RULABLE.has(w.state));
  return inBatch[index] ?? null;
}

function evictCases(s) {
  const ids = Object.keys(s.cases);
  if (ids.length <= MAX_CASES) return s;
  const sorted = ids.sort((a, b) => {
    const da = s.cases[a].status !== 'active' ? 0 : 1;
    const db = s.cases[b].status !== 'active' ? 0 : 1;
    return da !== db ? da - db : s.cases[a].lastT - s.cases[b].lastT;
  });
  const cases = { ...s.cases };
  for (const id of sorted.slice(0, ids.length - MAX_CASES)) delete cases[id];
  return { ...s, cases };
}

// A walking-out agent is gone at its goneAt (Phase 5a). A holder at the Direction door never leaves by time.
const isGone = (a, now) => a.leaving === true && now >= a.goneAt;

function pruneHandback(s, now) {
  const agents = {};
  for (const [id, a] of Object.entries(s.agents)) {
    if (isGone(a, now)) continue;
    agents[id] = a;
  }
  return { ...s, agents };
}

// Phase 5a: a subagent with no tool in flight and no event for IDLE_MS is finished as far as the room is concerned:
// it walks out (its transcript may end without a handback). Any new event revives it (see tool_start).
// The Conductor and holders are never idle-walked here (the Conductor follows its session in derive).
function idleLeave(a, now) {
  if (a.role === 'conductor' || a.holdingAt || a.leaving || a.tool) return a;
  if (now - a.lastT <= IDLE_MS) return a;
  return { ...a, leaving: true, goneAt: a.lastT + IDLE_MS + LEAVE_MS };
}

// Phase 3: a Conductor whose session has walked out (conductorIdleMs + LEAVE_MS idle) and that has no children left
// in its session is dropped from storage, so the state does not grow with dead sessions. Holders are never dropped.
function pruneIdleConductors(s, now, conductorIdleMs) {
  const withChildren = new Set();
  for (const a of Object.values(s.agents)) if (a.role !== 'conductor') withChildren.add(a.sessionId);
  const last = sessionLastT(s);
  const agents = {};
  let changed = false;
  for (const [id, a] of Object.entries(s.agents)) {
    const sessionT = last[a.sessionId] ?? a.lastT;
    const gone = a.role === 'conductor' && !a.holdingAt && !withChildren.has(a.sessionId)
      && now >= sessionT + conductorIdleMs + LEAVE_MS;
    if (gone) {
      changed = true;
      continue;
    }
    agents[id] = a;
  }
  return changed ? { ...s, agents } : s;
}

// Phase 5a escalation rules, checked on every handback of a known case (never the handback text).
//  - two consecutive implement handbacks with STATUS PARTIAL and no files changed -> stall "sin progreso"
//  - the same REQUIRED_CHANGES hash from the reviewer twice in a row -> stall "no converge"
function progressRules(s, a, ev) {
  const c0 = s.cases[a.caseId];
  if (!c0 || c0.status !== 'active') return s; // a closed case raises no new rule
  let c = c0;
  if (a.role === 'implement') {
    const empty = ev.status === 'PARTIAL' && ev.filesChanged === false;
    c = { ...c, noProgress: empty ? c.noProgress + 1 : 0 };
    if (empty && c.noProgress >= 2) s = addEscalation(s, a.sessionId, a.caseId, 'stall', ev.t, PROGRESS_STALL_LABEL);
  }
  if (a.reviewer) {
    const next = typeof ev.requiredHash === 'string' ? ev.requiredHash : null;
    if (next && next === c.requiredHash) s = addEscalation(s, a.sessionId, a.caseId, 'stall', ev.t, CONVERGE_STALL_LABEL);
    c = { ...c, requiredHash: next };
  }
  return putCase(s, c);
}

// Places an agent in its room (agent_spawn). Also used to re-create a session's Conductor (see reduce).
function spawnAgent(s, ev) {
  const { role, room } = roleOf(ev.subagentType, ev.mode);
  // A consult is a specialist at its specialty desk (generic desk when the token is missing or invalid).
  const consult = isConsult(ev.subagentType, ev.mode);
  s.agents[ev.agentId] = {
    agentId: ev.agentId, sessionId: ev.sessionId, caseId: ev.sessionId,
    subagentType: clip(ev.subagentType, 60), role, room, status: 'spawned', tool: null,
    reviewer: role === 'review' || (role === 'codex' && ev.mode === 'review'),
    consult, specialty: consult ? specialtyToken(ev.specialty) : null,
    parentAgentId: ev.parentAgentId ?? null, description: clip(ev.description), toolUseId: null, lastT: ev.t,
  };
  let c = ensureCase(s, ev.sessionId, ev.t);
  if (CASE_ROOM_BY_ROLE[role] && c.status === 'active') c = moveRoom(c, CASE_ROOM_BY_ROLE[role], ev.t);
  return evictCases(putCase(s, c));
}

export function reduce(state, ev) {
  let s = { ...state, t: Math.max(state.t, ev.t ?? 0), agents: { ...state.agents }, messages: state.messages };
  // A question waits 15 s for an answer: any event but a tick or another question cancels it.
  if (ev.kind !== 'idle_tick' && ev.kind !== 'question') s.question = null;
  // Phase 3: a Conductor pruned while idle comes back with the first event of its session (main transcript: the
  // agent id is the session id). Any other unknown agent is still an error (requireAgent).
  if (ev.kind !== 'agent_spawn' && ev.kind !== 'idle_tick' && ev.sessionId && ev.agentId === ev.sessionId && !s.agents[ev.agentId]) {
    s = spawnAgent(s, { t: ev.t, sessionId: ev.sessionId, agentId: ev.agentId, subagentType: 'conductor', description: 'Conductor', parentAgentId: null });
  }
  switch (ev.kind) {
    case 'agent_spawn':
      return spawnAgent(s, ev);
    case 'agent_link': {
      const a = requireAgent(s, ev.agentId);
      s.agents[ev.agentId] = { ...a, toolUseId: ev.toolUseId, lastT: ev.t };
      return s;
    }
    case 'tool_start': {
      const a = requireAgent(s, ev.agentId);
      // Any new activity revives an agent that was walking out.
      const { leaving, goneAt, ...alive } = a;
      s.agents[ev.agentId] = {
        ...alive, status: 'working', lastT: ev.t,
        tool: { name: clip(ev.tool, 40), label: clip(ev.label), toolUseId: ev.toolUseId ?? null, t: ev.t },
      };
      return s;
    }
    case 'tool_end': {
      const a = requireAgent(s, ev.agentId);
      if (!a.tool || (ev.toolUseId && ev.toolUseId !== a.tool.toolUseId)) {
        return { ...s, agents: s.agents };
      }
      s.agents[ev.agentId] = { ...a, tool: null, status: 'thinking', lastT: ev.t };
      return s;
    }
    case 'message_send': {
      s.messages = [...state.messages, { id: `${ev.t}:${ev.from}>${ev.to}`, from: ev.from, to: ev.to, t: ev.t }].slice(-MAX_MESSAGES);
      return s;
    }
    case 'agent_done': {
      const a = requireAgent(s, ev.agentId);
      // Phase 5a: a finished agent walks out; a holder at the Direction door stays until the user answers.
      const { leaving, goneAt, ...rest } = a;
      s.agents[ev.agentId] = {
        ...rest, status: 'handback', tool: null, lastT: ev.t,
        ...(a.holdingAt ? {} : { leaving: true, goneAt: ev.t + LEAVE_MS }),
      };
      // A consult is a specialist: its handback never moves the case, never closes a phase, never rings the bell.
      if (a.consult) return pruneHandback(s, ev.t);
      s = progressRules(s, a, ev);
      if (ev.blocked) s = addEscalation(s, a.sessionId, a.caseId, 'blocked', ev.t);
      if (ev.verdict) {
        let c = ensureCase(s, a.caseId, ev.t);
        const wasUnruled = c.warnings.some((w) => w.state === 'unruled');
        // A reviewer's final handback (STATUS present) closes its review: open items it did not rule are unruled.
        if (a.reviewer) c = leaveUnruled(c, ev.t);
        const next = applyVerdict(c, ev);
        s = putCase(s, { ...next, lastT: ev.t });
        if (a.reviewer && !wasUnruled && next.warnings.some((w) => w.state === 'unruled')) {
          s = addEscalation(s, a.sessionId, a.caseId, 'unruled', ev.t);
        }
        if (next.escalated && !c.escalated) s = addEscalation(s, a.sessionId, a.caseId, 'exhausted', ev.t);
        if (ev.verdict === 'FAILED') s = addEscalation(s, a.sessionId, a.caseId, 'failed', ev.t);
      }
      return pruneHandback(s, ev.t);
    }
    case 'approval_pending': {
      // A consult never rings Direction, whatever its Bash call or handback asked.
      if (ev.agentId && state.agents[ev.agentId]?.consult) return s;
      // A merge/push gate can come after review (even once discharged): Direction is asked whatever the status.
      let c = ensureCase(s, ev.sessionId, ev.t);
      c = { ...c, approval: { action: clip(ev.action, 20), t: ev.t }, lastT: ev.t };
      s = putCase(s, c);
      // The agent that issued the Bash/handback is the delegate: it walks to the Direction door and holds there.
      // The Conductor is never the delegate. An id that is not (yet) a known agent holds nobody.
      const issuer = ev.agentId ? s.agents[ev.agentId] : null;
      if (issuer && issuer.role !== 'conductor') {
        const { leaving, goneAt, ...stay } = issuer;
        s.agents[ev.agentId] = { ...stay, holdingAt: 'direction' };
      }
      return addEscalation(s, ev.sessionId, c.caseId, 'approve', ev.t);
    }
    case 'user_message': {
      // The user answered: this session's bell stops, its approval is answered and its delegates walk back.
      s.escalations = state.escalations.filter((e) => e.sessionId !== ev.sessionId);
      s.userT = ev.t;
      for (const [id, a] of Object.entries(s.agents)) {
        if (a.holdingAt && a.sessionId === ev.sessionId) {
          const { holdingAt, ...rest } = a;
          // Phase 5a: a finished holder walks out now; a working one simply goes back to work.
          s.agents[id] = a.status === 'handback' ? { ...rest, leaving: true, goneAt: ev.t + LEAVE_MS } : rest;
        }
      }
      const c = state.cases[ev.sessionId];
      if (c && c.approval) s = putCase(s, { ...c, approval: null });
      return s;
    }
    case 'case_counters': {
      // The case file's own counters escalate even without a transcript event. Repeats are deduped per reason.
      const c = ensureCase(s, ev.sessionId, ev.t);
      s = putCase(s, { ...c, lastT: ev.t });
      if (isCount(ev.reroutes) && ev.reroutes >= EXHAUSTED_REROUTES) s = addEscalation(s, ev.sessionId, c.caseId, 'exhausted', ev.t);
      if (isCount(ev.diagnosisRounds) && ev.diagnosisRounds >= STALL_DIAGNOSIS_ROUNDS) {
        s = addEscalation(s, ev.sessionId, c.caseId, 'stall', ev.t, EVIDENCE_STALL_LABEL);
      }
      return evictCases(s);
    }
    case 'question': {
      s.question = { sessionId: ev.sessionId, t: ev.t };
      return s;
    }
    case 'risk_accepted': {
      let c = ensureCase(s, ev.sessionId, ev.t);
      const accepted = (Array.isArray(ev.items) ? ev.items : []).slice(0, ACCEPTED_MAX)
        .map((a) => ({ item: sanitize(a?.item, 120), userWords: sanitize(a?.userWords, 80), date: String(a?.date ?? '') }))
        .filter((a) => a.item && a.userWords && /^\d{4}-\d{2}-\d{2}$/.test(a.date));
      // Only a signed line accepts an item; prose in the transcript never does.
      const warnings = c.warnings.map((w) => (
        (w.state === 'acceptable' || w.state === 'unruled') && accepted.some((a) => similar(a.item, w.text))
          ? { ...w, state: 'accepted', ruledT: ev.t } : w
      ));
      c = { ...c, accepted, warnings, lastT: ev.t };
      return evictCases(putCase(s, settle(c, ev.t)));
    }
    case 'warning_open': {
      let c = ensureCase(s, ev.sessionId, ev.t);
      if (c.status !== 'active') return s; // a closed case does not reopen
      const items = (Array.isArray(ev.items) ? ev.items : [])
        .map((t) => sanitize(t, WARNING_TEXT_MAX)).filter(Boolean).slice(0, WARNING_ITEMS_MAX);
      if (!items.length) return s;
      const batch = c.batchSeq + 1;
      let seq = c.warningSeq;
      const added = items.map((text) => ({
        id: `${c.caseId}#${++seq}`, batch, phase: phasesDoneOf(c) + 1, text, state: 'open', ruledT: null,
      }));
      c = { ...c, batchSeq: batch, warningSeq: seq, warnings: [...c.warnings, ...added], lastT: ev.t };
      return evictCases(putCase(s, c));
    }
    case 'warning_ruling': {
      const ruling = RULING_STATE[ev.ruling];
      if (!ruling) throw new Error(`unknown ruling: ${ev.ruling}`);
      let c = ensureCase(s, ev.sessionId, ev.t);
      const target = matchWarning(c, ev.label, ev.index);
      if (!target) return s; // matches nothing: the item stays as it was (open)
      c = {
        ...c, lastT: ev.t,
        warnings: c.warnings.map((w) => (w.id === target.id ? { ...w, state: ruling, ruledT: ev.t } : w)),
      };
      return evictCases(putCase(s, settle(c, ev.t)));
    }
    case 'triage': {
      let c = ensureCase(s, ev.sessionId, ev.t);
      c = { ...c, tier: ev.tier, caseKind: clip(ev.caseKind, 40), lastT: ev.t };
      // The plan's phases (Phase 4b). An absent key keeps the plan as it was.
      if (Array.isArray(ev.phases)) c = { ...c, planPhases: normalizePhases(ev.phases) };
      // The state file's own progress (Phase 4b revision): a count clamped to the plan, and its COMPLETE flag.
      // Recomputed on each read, so a file that stops saying COMPLETE stops it. Absent or non-integer = unchanged.
      if (Number.isSafeInteger(ev.filePhasesDone)) {
        c = { ...c, filePhasesDone: Math.min(Math.max(ev.filePhasesDone, 0), (c.planPhases ?? []).length) };
      }
      if (typeof ev.fileComplete === 'boolean') c = { ...c, fileComplete: ev.fileComplete };
      if (ev.tier && c.status === 'active' && c.room === 'reception') c = moveRoom(c, 'triage', ev.t);
      return evictCases(putCase(s, c));
    }
    case 'case_status': {
      let c = ensureCase(s, ev.sessionId, ev.t);
      c = { ...c, fileStatus: clip(ev.status, 40), lastT: ev.t };
      if (ev.status === 'STOPPED' && (c.status === 'active' || c.status === 'escalated')) {
        c = { ...moveRoom(c, 'stopped', ev.t), status: 'stopped' };
      }
      return evictCases(putCase(s, c));
    }
    case 'idle_tick': {
      for (const [id, a] of Object.entries(s.agents)) {
        const next = idleLeave(a, ev.t);
        if (next !== a) s.agents[id] = next;
      }
      s = pruneHandback(s, ev.t);
      s = pruneIdleConductors(s, ev.t, ev.conductorIdleMs ?? CONDUCTOR_IDLE_MS);
      if (s.question && ev.t - s.question.t >= ASK_USER_MS) {
        const q = s.question;
        s = addEscalation(s, q.sessionId, q.sessionId, 'ask_user', ev.t);
        s.question = null;
      }
      // A tool with no end for more than STALL_MS rings once (the tool use is marked so it does not repeat).
      for (const [id, a] of Object.entries(s.agents)) {
        if (!a.tool || a.tool.stallRung || ev.t - a.tool.t <= STALL_MS) continue;
        s.agents[id] = { ...a, tool: { ...a.tool, stallRung: true } };
        s = addEscalation(s, a.sessionId, a.caseId, 'stall', ev.t);
      }
      return s;
    }
    default:
      throw new Error(`unknown event kind: ${ev.kind}`);
  }
}

// Phases behind the current patient: max(transcript count, state.md count). Pure.
function phasesDoneOf(c) {
  return Math.max(c.phasesDone, c.filePhasesDone ?? 0);
}

// Phase 4b view: one patient per plan phase, from the phase count and status only. Pure. No plan = no phases.
// The gate never moves the count (a held close waits at the door), so the current patient stays current.
// A discharged case, or a state file whose STATUS is COMPLETE, has every remaining patient done (view only:
// the case status and room are not changed by it).
export function phasesOf(c) {
  const plan = c.planPhases ?? [];
  if (!plan.length) return [];
  const all = c.status === 'discharged' || c.fileComplete === true;
  const done = all ? plan.length : Math.min(phasesDoneOf(c), plan.length);
  return plan.map((p, i) => ({
    id: p.id, title: p.title,
    state: i < done ? 'done' : i === done ? 'current' : 'waiting',
  }));
}

function casesView(cases) {
  const out = {};
  for (const [id, c] of Object.entries(cases)) {
    const { planPhases, filePhasesDone, fileComplete, ...rest } = c;
    out[id] = { ...rest, phases: phasesOf(c) };
  }
  return out;
}

// Last activity of each session: its agents and its case file.
function sessionLastT(state) {
  const last = {};
  for (const a of Object.values(state.agents)) last[a.sessionId] = Math.max(last[a.sessionId] ?? 0, a.lastT);
  for (const c of Object.values(state.cases)) last[c.caseId] = Math.max(last[c.caseId] ?? 0, c.lastT);
  return last;
}

export function derive(state, now, { conductorIdleMs = CONDUCTOR_IDLE_MS } = {}) {
  const agents = {};
  const last = sessionLastT(state);
  for (const [id, a0] of Object.entries(state.agents)) {
    let a = idleLeave(a0, now);
    // Phase 5a: the Conductor stays while its session is active; an idle session walks it out (Phase 3: configurable).
    if (a.role === 'conductor' && !a.holdingAt && !a.leaving) {
      const sessionT = last[a.sessionId] ?? a.lastT;
      if (now - sessionT > conductorIdleMs) a = { ...a, leaving: true, goneAt: sessionT + conductorIdleMs + LEAVE_MS };
    }
    if (isGone(a, now)) continue;
    agents[id] = {
      ...a,
      leaving: a.leaving === true,
      sleeping: a.status !== 'handback' && now - a.lastT > IDLE_MS,
      stalled: Boolean(a.tool) && now - a.tool.t > STALL_MS,
    };
  }
  return {
    t: state.t, now, agents, cases: casesView(state.cases), messages: state.messages,
    escalations: state.escalations, userT: state.userT,
  };
}


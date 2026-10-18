// Phase 4b client rules: which patients stand where, the caps, the wristband, the specialty desk of a consult.
// Pure (imported by node:test; no DOM). Patients are the plan phases of each case (case.phases from derive).
import { SPECIALTY_DESKS } from './map.js';

export const WAITING_CAP = 6; // waiting patients drawn in Reception, then "+N"
export const DISCHARGED_CAP = 4; // finished patients drawn in Alta, then "+N"
export const WAITING_COLS = 3;

const STATE_LABEL = { done: 'hecho', current: 'en curso', waiting: 'en espera' };
export const phaseStateLabel = (state) => STATE_LABEL[state] ?? '';

/** Patients by place: waiting (not started), current (one per case with phases), discharged (done). */
export function patientsOf(cases) {
  const out = { waiting: [], current: [], discharged: [] };
  for (const c of Object.values(cases ?? {})) {
    const list = Array.isArray(c.phases) ? c.phases : [];
    list.forEach((p, i) => {
      const row = { caseId: c.caseId, id: p.id, title: p.title, index: i + 1, total: list.length };
      if (p.state === 'waiting') out.waiting.push(row);
      else if (p.state === 'current') out.current.push(row);
      else if (p.state === 'done') out.discharged.push(row);
    });
  }
  return out;
}

/** Wristband label `id/N` (N = phases of the case). */
export const wristbandLabel = (id, total) => `${id}/${total}`;

/** Wristband of a case's gurney: its current patient, or its last one when every patient is done. Null without phases. */
export function wristbandOf(c) {
  const list = Array.isArray(c?.phases) ? c.phases : [];
  if (!list.length) return null;
  const cur = list.find((p) => p.state === 'current') ?? list[list.length - 1];
  return { id: cur.id, label: wristbandLabel(cur.id, list.length) };
}

/**
 * Chip grid for a row of patients: at most `cap` chips, in `cols` columns. `more` counts the rest; `moreSlot` is
 * where its "+N" goes (only when there are more).
 */
export function chipLayout(count, cap, cols) {
  const shown = Math.min(count, cap);
  const slots = [];
  for (let i = 0; i < shown; i++) slots.push({ col: i % cols, row: Math.floor(i / cols) });
  const more = Math.max(0, count - cap);
  if (!more) return { slots, more };
  return { slots, more, moreSlot: { col: shown % cols, row: Math.floor(shown / cols) } };
}

/** Desk of a consult's specialty token. Unknown, missing or invalid tokens go to the generic desk. */
export function specialtyDeskOf(token) {
  const t = typeof token === 'string' ? token.toLowerCase() : '';
  return SPECIALTY_DESKS.find((d) => d.id === t) ?? SPECIALTY_DESKS.find((d) => d.id === 'general');
}

// Phase 5a: one row per case. The case colour tags the row and the case's wristband. Colour = palette slot by the
// case's place in the view (at most MAX_CASES = 4 cases, so the four colours never repeat while they are in view).
// No tier colour is used (S red, M yellow, L blue belong to the gurney's tier tag).
export const CASE_COLOURS = ['#ff9f43', '#5fe3e0', '#b9a7e0', '#ff8fb1'];

/** Colour of a case given the ordered list of case ids in the view. Unknown id: the first colour. */
export function caseColourOf(caseId, orderedIds) {
  const i = orderedIds.indexOf(caseId);
  return CASE_COLOURS[(i < 0 ? 0 : i) % CASE_COLOURS.length];
}

/**
 * One row per case that has waiting or finished patients (case order of the view). Waiting patients are capped at
 * WAITING_CAP per row and finished ones at DISCHARGED_CAP per row; `waitingMore` / `finishedMore` count the rest.
 * The current patient is not a chip: it is the wristband on the gurney.
 */
export function chipRowsOf(cases) {
  const ids = Object.keys(cases ?? {});
  const rows = [];
  for (const id of ids) {
    const list = Array.isArray(cases[id].phases) ? cases[id].phases : [];
    const waiting = list.filter((p) => p.state === 'waiting').map((p) => ({ id: p.id, title: p.title }));
    const finished = list.filter((p) => p.state === 'done').map((p) => ({ id: p.id, title: p.title }));
    if (!waiting.length && !finished.length) continue;
    rows.push({
      caseId: id,
      colour: caseColourOf(id, ids),
      waiting: waiting.slice(0, WAITING_CAP),
      waitingMore: Math.max(0, waiting.length - WAITING_CAP),
      finished: finished.slice(0, DISCHARGED_CAP),
      finishedMore: Math.max(0, finished.length - DISCHARGED_CAP),
    });
  }
  return rows;
}

// Case files: plans/*-state.md under the explicitly mounted project roots (HOSPITAL_CASE_DIRS, :ro).
// Header fields (STATUS, Classification, Plan file) come from the first 40 lines; ACCEPTED_RISK lines are read
// from the whole file. Unknown or missing fields are null, never guessed. The body is never forwarded.
// CONFINEMENT: a transcript's cwd is only followed when its real path lies inside a mounted root (symlinks resolved).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TIERS = new Set(['S', 'M', 'L']);
// Relative to the running user's home (no personal absolute path in the source).
export const DEFAULT_CASE_DIRS = [path.join(os.homedir(), 'Documentos', 'Docker'), path.join(os.homedir(), 'Documentos', 'IA')];
const ACCEPTED_RE = /^ACCEPTED_RISK: (.+?) — (.+) — (\d{4}-\d{2}-\d{2})$/;
const GATE2_RE = /Gate 2|Merge \/ push \/ deploy/;
const STATE_FILE_RE = /-state\.md$/;
export const ACCEPTED_MAX = 20;

export function parseCaseFile(text) {
  const head = String(text ?? '').split('\n').slice(0, 40);
  const find = (re) => {
    for (const line of head) {
      const m = re.exec(line);
      if (m) return m;
    }
    return null;
  };
  const status = find(/^STATUS:\s*([A-Z_]+)\s*$/);
  const cls = find(/^Classification:\s*Tier\s+([A-Z])\s*·\s*([a-z-]+)/);
  const plan = find(/^Plan file:\s*(\S+)/);
  return {
    status: status?.[1] ?? null,
    tier: cls && TIERS.has(cls[1]) ? cls[1] : null,
    caseKind: cls?.[2] ?? null,
    planFile: plan?.[1] ?? null,
  };
}

// Header counters (subagent-pool state file). Only the first 40 lines count; a missing or non-numeric value is null.
const REROUTES_RE = /^Re-routes:\s*(\d+)\b/;
const DIAG_ROUNDS_RE = /^Diagnosis rounds without new evidence:\s*(\d+)\b/;

export function parseCounters(text) {
  const head = String(text ?? '').split('\n').slice(0, 40);
  const count = (re) => {
    for (const line of head) {
      const m = re.exec(line);
      if (m) {
        const n = Number(m[1]);
        return Number.isSafeInteger(n) ? n : null;
      }
    }
    return null;
  };
  return { reroutes: count(REROUTES_RE), diagnosisRounds: count(DIAG_ROUNDS_RE) };
}

/** Whole-file scan for signed accepted risks. Anything that does not match the full format is ignored. */
export function parseAcceptedRisks(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const m = ACCEPTED_RE.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    const item = m[1].trim();
    const userWords = m[2].trim();
    if (!item || !userWords) continue;
    out.push({ item: item.slice(0, 120), userWords: userWords.slice(0, 80), date: m[3] });
    if (out.length >= ACCEPTED_MAX) break;
  }
  return out;
}

/** Gate 2 / merge-push-deploy mention in the header's status or next-action lines. Returns an action or null. */
export function gateActionOf(text) {
  for (const line of String(text ?? '').split('\n').slice(0, 40)) {
    if (/^(STATUS|Next|NEXT)\b/.test(line) && GATE2_RE.test(line)) return 'gate 2';
  }
  return null;
}

/**
 * HOSPITAL_CASE_DIRS: colon-separated absolute container paths. Empty or unset = the two default mounts.
 * @returns {{roots: string[], rejected: string[]}}
 */
export function parseCaseDirs(value) {
  const raw = value === undefined || value === null || String(value).trim() === '' ? DEFAULT_CASE_DIRS.join(':') : String(value);
  const roots = [];
  const rejected = [];
  for (const entry of raw.split(':').map((s) => s.trim()).filter(Boolean)) {
    if (path.posix.isAbsolute(entry) && !entry.includes('\0')) roots.push(path.posix.normalize(entry));
    else rejected.push(entry);
  }
  return { roots, rejected };
}

/** Real roots (symlinks resolved). Roots that do not exist are dropped; the caller logs them. */
export function realRoots(roots) {
  const out = [];
  for (const r of roots) {
    try {
      out.push(fs.realpathSync(r));
    } catch {
      // Missing mount: nothing under it can be confined, so it is simply not a root.
    }
  }
  return out;
}

export const inside = (p, roots) => roots.some((r) => p === r || p.startsWith(r + path.sep));

/**
 * @param {string} cwd transcript cwd (untrusted)
 * @param {string[]} roots real roots (see realRoots)
 * @returns {string|null} real path of <cwd>/plans when it lies inside a root, else null
 */
export function resolveCaseDir(cwd, roots) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) return null;
  let real;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    return null;
  }
  if (!inside(real, roots)) return null;
  const plans = path.join(real, 'plans');
  try {
    if (!fs.statSync(plans).isDirectory()) return null;
    const planReal = fs.realpathSync(plans);
    return inside(planReal, roots) ? planReal : null;
  } catch {
    return null;
  }
}

/**
 * Newest plans/*-state.md whose real path stays inside a root. Stat only: the caller reads on a key change.
 * @returns {{file: string, key: string}|null}
 */
export function latestCaseFile(plansDir, roots) {
  let names;
  try {
    names = fs.readdirSync(plansDir).filter((n) => STATE_FILE_RE.test(n));
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    const file = path.join(plansDir, name);
    try {
      const real = fs.realpathSync(file);
      if (!inside(real, roots)) continue;
      const st = fs.statSync(real);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: real, mtimeMs: st.mtimeMs, key: `${real}|${st.mtimeMs}|${st.size}` };
    } catch {
      // Dangling or unreadable entry: skipped, never guessed.
    }
  }
  return best ? { file: best.file, key: best.key } : null;
}

/** Reads one confined state file (size-capped) and returns its header, accepted risks and gate action. */
export function loadCaseFile(file, maxBytes = 256 * 1024, expected = null) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (expected && (st.dev !== expected.dev || st.ino !== expected.ino
      || st.size !== expected.size || fs.realpathSync(file) !== expected.file))) {
      throw new Error('case file changed during read');
    }
    const buf = Buffer.alloc(Math.min(maxBytes, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    return {
      ...parseCaseFile(text), counters: parseCounters(text), accepted: parseAcceptedRisks(text), gate: gateActionOf(text),
      progress: parseCaseProgress(text),
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ---- Phase 4b revision: progress from the state file header (user decision 2026-10-18, options a+d).
// Only phase id tokens are read, never text. Parenthesised text is dropped before splitting on `;`, so a number
// inside a note (e.g. "(see 2; 3b)") is not a phase. Only the first 40 lines count, as for the header.
const PROGRESS_LINE_MAX = 2000;
const COMPLETED_RE = /^Completed phases:\s*(.*)$/;
const CURRENT_LINE_RE = /^Current:\s*(.*)$/;
const APPROVED_LINE_RE = /^Phase (\d+[a-z]?) APPROVED\b/;
const ID_LEAD_RE = /^(?:Phase\s+)?(\d+[a-z]?)\b/;
const COMPLETE_STATUS_RE = /^STATUS:\s*complete\s*$/i;

const stripParens = (s) => {
  let prev;
  let out = s;
  do {
    prev = out;
    out = out.replace(/\([^()]*\)/g, '');
  } while (out !== prev);
  return out;
};

// The phase id at the start of each `;`-separated item (outside parentheses), in order.
const idsOfList = (list) => stripParens(list).split(';')
  .map((item) => ID_LEAD_RE.exec(item.trim())?.[1])
  .filter(Boolean);

/**
 * Phase ids the state file says are done (`Completed phases:` items and `Phase N APPROVED` lines), the id of the
 * last `Current:` line, and whether the first STATUS line is COMPLETE (case-insensitive, whole value only).
 * Untrusted text: only id tokens leave this function.
 * @returns {{doneIds: string[], currentId: string|null, complete: boolean}}
 */
export function parseCaseProgress(text) {
  const head = String(text ?? '').split('\n').slice(0, 40).map((l) => l.replace(/\r$/, '').slice(0, PROGRESS_LINE_MAX));
  const doneIds = [];
  let currentId = null;
  let complete = false;
  let statusSeen = false;
  for (const line of head) {
    if (!statusSeen && line.startsWith('STATUS:')) {
      statusSeen = true;
      complete = COMPLETE_STATUS_RE.test(line);
    }
    const completed = COMPLETED_RE.exec(line);
    if (completed) doneIds.push(...idsOfList(completed[1]));
    const approved = APPROVED_LINE_RE.exec(line);
    if (approved) doneIds.push(approved[1]);
    const current = CURRENT_LINE_RE.exec(line);
    if (current) currentId = idsOfList(current[1])[0] ?? currentId;
  }
  return { doneIds: [...new Set(doneIds)], currentId, complete };
}

/**
 * Phases behind the current patient, by plan order: the done prefix (every plan phase before the first open one is
 * done) or the position of the last Current phase, whichever is further. An id the plan lacks counts for nothing.
 * @param {{doneIds: string[], currentId: string|null}} progress
 * @param {{id: string}[]} planPhases
 * @returns {number} 0..planPhases.length
 */
export function phasesDoneFromFile(progress, planPhases) {
  const ids = (planPhases ?? []).map((p) => p.id);
  const done = new Set(progress?.doneIds ?? []);
  let prefix = 0;
  while (prefix < ids.length && done.has(ids[prefix])) prefix += 1;
  const currentAt = progress?.currentId ? ids.indexOf(progress.currentId) : -1;
  return Math.max(prefix, currentAt);
}

// ---- Phase 4b: plan phases. The plan's `## Phase N` headings (fallback `### Phase N`) are the patients of the case.
// A heading is untrusted text: only the id token and a clipped, sanitized title survive. Fenced code is ignored.
export const PLAN_MAX_BYTES = 256 * 1024;
export const PHASES_MAX = 24;
export const PHASE_TITLE_MAX = 40;
const PHASE_ID_RE = /^\d+[a-z]?$/;
const H2_PHASE_RE = /^## Phase (\d+[a-z]?)\b(.*)$/;
const H3_PHASE_RE = /^### Phase (\d+[a-z]?)\b(.*)$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const TITLE_LEAD_RE = /^[\s:—–.-]+/;
const PLAN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/**
 * Ids must be phase tokens; titles are sanitized and clipped; a duplicate id keeps the first; at most PHASES_MAX.
 * Also the reducer's gate: a triage event's phases are never trusted as they arrive.
 * @returns {{id: string, title: string}[]}
 */
export function normalizePhases(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const id = typeof p?.id === 'string' ? p.id : '';
    if (!PHASE_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const clean = String(p.title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
      .slice(0, PHASE_TITLE_MAX).trimEnd();
    out.push({ id, title: clean || `Phase ${id}` });
    if (out.length >= PHASES_MAX) break;
  }
  return out;
}

// `## Phase` headings outside fences; `### Phase` only when there is no `## Phase` heading at all.
function phaseHeadings(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const h2 = [];
  const h3 = [];
  let fence = null;
  for (const line of lines) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      fence = open[1];
      continue;
    }
    const m2 = H2_PHASE_RE.exec(line);
    if (m2) h2.push(m2);
    const m3 = H3_PHASE_RE.exec(line);
    if (m3) h3.push(m3);
  }
  return h2.length ? h2 : h3;
}

/** @returns {{id: string, title: string}[]} phases in document order (see normalizePhases for the caps) */
export function parsePlanPhases(text) {
  return normalizePhases(phaseHeadings(text).map((m) => ({ id: m[1], title: m[2].replace(TITLE_LEAD_RE, '') })));
}

/**
 * THE confinement helper for files under a case's plans/ dir (plan, council docs, shots). Each segment is a plain
 * name (no `/`, `\`, NUL, `.` or `..`, not empty). The real path must lie inside a root AND inside the real plans
 * dir, and must be a regular file. Symlinks that leave plans/ are refused. Stat only.
 * @param {string} plansDir
 * @param {string[]} segments path below plansDir, e.g. ['council', 'x', 'decisions.md']
 * @param {string[]} roots real roots (see realRoots)
 * @returns {{file: string, key: string}|null}
 */
export function confineInPlans(plansDir, segments, roots) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  if (!segments.every((s) => typeof s === 'string' && s !== '' && s !== '.' && s !== '..' && !/[\\/\0]/.test(s))) return null;
  let plansReal;
  let real;
  try {
    plansReal = fs.realpathSync(plansDir);
    real = fs.realpathSync(path.join(plansDir, ...segments));
  } catch {
    return null;
  }
  if (!inside(plansReal, roots) || !inside(real, [plansReal])) return null;
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return null;
    return { file: real, key: `${real}|${st.mtimeMs}|${st.size}` };
  } catch {
    return null;
  }
}

/**
 * The plan named by a case file header, resolved by its basename inside the confined plans dir. Absolute paths,
 * `..` segments, NUL and symlinks that leave the plans dir are rejected. Stat only.
 * @returns {{file: string, key: string}|null}
 */
export function planFileOf(plansDir, planRef, roots) {
  if (typeof planRef !== 'string' || planRef.includes('\0') || planRef.includes('\\')) return null;
  if (path.posix.isAbsolute(planRef) || planRef.split('/').includes('..')) return null;
  const name = path.posix.basename(planRef);
  if (!PLAN_NAME_RE.test(name)) return null;
  return confineInPlans(plansDir, [name], roots);
}

/**
 * Reads at most maxBytes of the confined plan. No readable plan: phases [] and key null (never guessed).
 * A read error keeps its code in `error` so the caller can log it.
 * @returns {{phases: {id: string, title: string}[], key: string|null, error?: string}}
 */
export function loadPlanPhases(plansDir, planRef, roots, maxBytes = PLAN_MAX_BYTES) {
  const plan = planFileOf(plansDir, planRef, roots);
  if (!plan) return { phases: [], key: null };
  let fd;
  try {
    fd = fs.openSync(plan.file, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, fs.fstatSync(fd).size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return { phases: parsePlanPhases(buf.subarray(0, n).toString('utf8')), key: plan.key };
  } catch (err) {
    return { phases: [], key: plan.key, error: err.code ?? err.message };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

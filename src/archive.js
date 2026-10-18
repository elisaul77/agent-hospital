// Archive of case files (hospital-5b1, Phase 1). Pure: no HTTP here.
// SCAN: fixed probes only (<root>/plans, <root>/*/plans, <root>/*/*/plans); skip list, dot dirs, no symlink follow;
// at most ARCHIVE_CAP cases; a readdir budget bounds the walk; per-dir errors are recorded, never fatal.
// IDS: server-minted (sha256 of the real state path, 16 hex). The client never sends a path.
// DOCS: fixed kinds state | plan | shot-<n> | council-<n>-(decisions|debate|brief); each read re-confines the file
// (serve-time check). n is a server index (council: position among the listed council dirs), never a name from the client.
// TEXT: NUL refused, invalid UTF-8 replaced, BOM stripped, cut at 256 KB, named-token redaction (best effort).
// PNG: magic bytes and a 2 MB cap; an oversize or fake PNG is never listed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCaseFile, inside, planFileOf, confineInPlans } from './casefile.js';

export const ARCHIVE_CAP = 200;
export const ARCHIVE_TTL_MS = 30_000;
export const ARCHIVE_MISS_MIN_MS = 1000;
export const TEXT_MAX_BYTES = 256 * 1024;
export const PNG_MAX_BYTES = 2 * 1024 * 1024;
export const SHOTS_MAX = 50;
export const SCAN_DIR_BUDGET = 2000;

const HEAD_BYTES = 32 * 1024;
const NUL_PROBE_BYTES = 8 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '__pycache__']);
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);
const STATE_FILE_RE = /-state\.md$/;
const SHOT_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,118}\.png$/u;
const ID_RE = /^[0-9a-f]{16}$/;
const COUNCIL_KIND_RE = /^council-(0|[1-9]|1\d)-(decisions|debate|brief)$/;
const KIND_RE = /^(state|plan|shot-(0|[1-9]\d?)|council-(0|[1-9]|1\d)-(decisions|debate|brief))$/;
// Every direct subdirectory of plans/council is a council (a real task dir, e.g. hospital-5b1). At most this many, by name.
export const COUNCIL_DIRS_MAX = 20;
const COUNCIL_TYPES = ['decisions', 'debate', 'brief'];
const COUNCIL_FILES = { decisions: 'decisions.md', debate: 'debate.log', brief: 'brief.md' };
const COUNCIL_LABEL_MAX = 80;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_TYPE = 'text/plain; charset=utf-8';
const REDACTED = '[redacted]';
const TRUNCATED_MARK = '\n[recortado]\n';

/**
 * Drops the entries whose key is not in `keep` (a Set). Returns the dropped keys (for a log line).
 * Used for the live flag: a session that left the tail window no longer has a live case file.
 */
export function pruneAbsent(map, keep) {
  const dropped = [];
  for (const k of map.keys()) {
    if (!keep.has(k)) {
      map.delete(k);
      dropped.push(k);
    }
  }
  return dropped;
}

/** The view with each case carrying its archive id (null when the case has no live state file). Does not mutate. */
export function viewWithArchiveIds(view, caseKeys) {
  const cases = Object.fromEntries(
    Object.entries(view.cases ?? {}).map(([sid, c]) => [sid, { ...c, archiveId: caseKeys.get(sid)?.caseId ?? null }]),
  );
  return { ...view, cases };
}

/** Opaque, stable id for a real state-file path. The path is not recoverable from it. */
export function caseId(realStateFile) {
  return crypto.createHash('sha256').update(String(realStateFile)).digest('hex').slice(0, 16);
}

export function isPngBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

// Named-token patterns only. No generic hex or base64 rule: SHAs and hashes must survive.
// Each rule counts one per match. The key=value rule skips an already redacted value.
const REDACTION_RULES = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, () => REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, () => REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, () => REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, () => REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => REDACTED],
  [/\bBearer[ \t]+[A-Za-z0-9._~+/=-]{12,}/gi, () => `Bearer ${REDACTED}`],
  [/([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]*)([ \t]*[:=][ \t]*)(?!\[redacted\])("[^"\n]*"|'[^'\n]*'|[^\s"']\S*)/gi,
    (_m, key, sep) => `${key}${sep}${REDACTED}`],
];

/** @returns {{text: string, redacted: number}} best effort; the count goes to the viewer header. */
export function redactText(text) {
  let out = String(text ?? '');
  let redacted = 0;
  for (const [re, repl] of REDACTION_RULES) {
    out = out.replace(re, (...args) => {
      redacted += 1;
      return repl(...args);
    });
  }
  return { text: out, redacted };
}

// ---- scan ----

function noteError(ctx, err) {
  if (ctx.errors.length < 50) ctx.errors.push(err?.code ?? 'ERR');
}

function readdirOf(ctx, dir) {
  if (ctx.dirReads >= ctx.budget) {
    ctx.truncated = true;
    return [];
  }
  ctx.dirReads += 1;
  try {
    return ctx.fsx.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!ABSENT.has(err.code)) noteError(ctx, err);
    return [];
  }
}

// Directory entries that are real directories (Dirent does not follow symlinks), minus the skip list.
function childDirs(ctx, dir) {
  return readdirOf(ctx, dir)
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
    .map((d) => d.name)
    .sort();
}

function isRealDir(ctx, p) {
  try {
    return ctx.fsx.lstatSync(p).isDirectory();
  } catch (err) {
    if (!ABSENT.has(err.code)) noteError(ctx, err);
    return false;
  }
}

// Head of a regular file, opened with O_NOFOLLOW. Anything else (FIFO, dir, symlink) gives null.
function readHeadOf(ctx, file, max) {
  let fd;
  try {
    // O_NONBLOCK: an open of a FIFO swapped in after the scan returns at once (then fstat refuses it), never waits.
    fd = ctx.fsx.openSync(file, ctx.fsx.constants.O_RDONLY | ctx.fsx.constants.O_NOFOLLOW | ctx.fsx.constants.O_NONBLOCK);
    const st = ctx.fsx.fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(max, st.size));
    const n = ctx.fsx.readSync(fd, buf, 0, buf.length, 0);
    return { buf: buf.subarray(0, n), size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    if (!ABSENT.has(err.code)) noteError(ctx, err);
    return null;
  } finally {
    if (fd !== undefined) ctx.fsx.closeSync(fd);
  }
}

function looksText(ctx, file) {
  const head = readHeadOf(ctx, file, NUL_PROBE_BYTES);
  return head !== null && !head.buf.includes(0);
}

function pngOk(ctx, file) {
  const head = readHeadOf(ctx, file, PNG_MAGIC.length);
  return head !== null && head.size <= PNG_MAX_BYTES && isPngBuffer(head.buf);
}

// Shots of one plans dir, listed once per scan (many state files can share a plans dir).
function shotsOf(ctx, plansDir) {
  const cached = ctx.shotCache.get(plansDir);
  if (cached) return cached;
  const shotsDir = path.join(plansDir, 'shots');
  const out = [];
  if (isRealDir(ctx, shotsDir)) {
    const names = readdirOf(ctx, shotsDir)
      .filter((d) => d.isFile() && SHOT_RE.test(d.name))
      .map((d) => d.name)
      .sort();
    for (const name of names) {
      if (out.length >= SHOTS_MAX) break;
      if (pngOk(ctx, path.join(shotsDir, name))) out.push(name);
    }
  }
  ctx.shotCache.set(plansDir, out);
  return out;
}

// Council dirs of one plans dir (cached per scan). One readdir of plans/council (Dirent: symlinked dirs are not
// dirs, dot dirs and the skip list are dropped), name order, at most COUNCIL_DIRS_MAX. A dir keeps only the files
// that confine inside plans/ and read as text; a dir with none is not listed. The index of a listed council is its
// position in this list: the client only ever sends that index.
function councilsOf(ctx, plansDir) {
  const cached = ctx.councilCache.get(plansDir);
  if (cached) return cached;
  const out = [];
  const councilDir = path.join(plansDir, 'council');
  if (isRealDir(ctx, councilDir)) {
    const names = childDirs(ctx, councilDir);
    if (names.length > COUNCIL_DIRS_MAX) ctx.councilCapped = true;
    for (const name of names.slice(0, COUNCIL_DIRS_MAX)) {
      const types = COUNCIL_TYPES.filter((t) => {
        const f = confineInPlans(plansDir, ['council', name, COUNCIL_FILES[t]], ctx.roots);
        return f !== null && looksText(ctx, f.file);
      });
      if (types.length) out.push({ name, label: name.slice(0, COUNCIL_LABEL_MAX), types });
    }
  }
  ctx.councilCache.set(plansDir, out);
  return out;
}

function caseFromState(ctx, plansDir, name) {
  const file = path.join(plansDir, name);
  const head = readHeadOf(ctx, file, HEAD_BYTES);
  if (head === null || head.buf.includes(0)) return null;
  let real;
  try {
    real = ctx.fsx.realpathSync(file);
  } catch (err) {
    if (!ABSENT.has(err.code)) noteError(ctx, err);
    return null;
  }
  if (!inside(real, ctx.roots)) return null;
  const meta = parseCaseFile(head.buf.toString('utf8'));
  const stem = name.replace(STATE_FILE_RE, '');
  const roots = ctx.roots;
  const docs = [{ kind: 'state' }];
  const plan = planFileOf(plansDir, meta.planFile, roots);
  if (plan && looksText(ctx, plan.file)) docs.push({ kind: 'plan' });
  const councils = councilsOf(ctx, plansDir);
  councils.forEach((c, n) => {
    for (const t of c.types) docs.push({ kind: `council-${n}-${t}`, label: c.label });
  });
  const shots = shotsOf(ctx, plansDir);
  shots.forEach((s, i) => docs.push({ kind: `shot-${i}`, name: s }));
  return {
    id: caseId(real),
    project: path.basename(path.dirname(plansDir)),
    name: stem || name,
    stem,
    status: meta.status,
    tier: meta.tier,
    mtime: head.mtimeMs,
    plansDir,
    stateName: name,
    planRef: meta.planFile,
    councils,
    shots,
    docs,
  };
}

function scanPlans(ctx, plansDir) {
  for (const d of readdirOf(ctx, plansDir)) {
    if (!d.isFile() || !STATE_FILE_RE.test(d.name)) continue;
    const entry = caseFromState(ctx, plansDir, d.name);
    if (entry && !ctx.cases.has(entry.id)) ctx.cases.set(entry.id, entry);
  }
}

function scanRoot(ctx, root) {
  const plansDirs = [path.join(root, 'plans')];
  for (const c of childDirs(ctx, root)) {
    plansDirs.push(path.join(root, c, 'plans'));
    for (const g of childDirs(ctx, path.join(root, c))) plansDirs.push(path.join(root, c, g, 'plans'));
  }
  for (const p of plansDirs) {
    if (isRealDir(ctx, p)) scanPlans(ctx, p);
  }
}

const publicCase = (e) => ({
  id: e.id, project: e.project, name: e.name, status: e.status, tier: e.tier, mtime: e.mtime,
  docs: e.docs.map((d) => ({ ...d })),
});

/**
 * One bounded scan. `entries` is internal (real paths stay server-side); `cases` is the public listing.
 * @param {string[]} roots real roots (see realRoots in casefile.js)
 * @returns {{cases: object[], entries: object[], truncated: boolean, errors: string[], dirReads: number}}
 */
export function scanCases(roots, { fsx = fs, budget = SCAN_DIR_BUDGET } = {}) {
  const ctx = {
    roots: [...roots],
    fsx,
    budget,
    dirReads: 0,
    truncated: false,
    councilCapped: false,
    errors: [],
    cases: new Map(),
    shotCache: new Map(),
    councilCache: new Map(),
  };
  for (const root of ctx.roots) scanRoot(ctx, root);
  const all = [...ctx.cases.values()]
    .sort((a, b) => (b.mtime - a.mtime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (all.length > ARCHIVE_CAP) ctx.truncated = true;
  const entries = all.slice(0, ARCHIVE_CAP);
  return {
    cases: entries.map(publicCase),
    entries,
    truncated: ctx.truncated,
    councilCapped: ctx.councilCapped,
    errors: ctx.errors,
    dirReads: ctx.dirReads,
  };
}

// ---- docs ----

// The kind's shape only (KIND_RE gates everything); the index is checked against the entry at serve time.
function parseKind(kind) {
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) return null;
  if (kind === 'state' || kind === 'plan') return { kind, type: kind };
  if (kind.startsWith('shot-')) return { kind, type: 'shot', idx: Number(kind.slice(5)) };
  const m = COUNCIL_KIND_RE.exec(kind);
  return { kind, type: 'council', idx: Number(m[1]), ctype: m[2] };
}

// Serve-time confinement of one doc of one entry. Only the listed set (entry.docs) is ever served.
function confinedFor(entry, k, roots) {
  if (!entry.docs.some((d) => d.kind === k.kind)) return null;
  switch (k.type) {
    case 'state': return confineInPlans(entry.plansDir, [entry.stateName], roots);
    case 'plan': return planFileOf(entry.plansDir, entry.planRef, roots);
    case 'shot': {
      const name = entry.shots[k.idx];
      return name ? confineInPlans(entry.plansDir, ['shots', name], roots) : null;
    }
    default: {
      const council = entry.councils[k.idx];
      return council ? confineInPlans(entry.plansDir, ['council', council.name, COUNCIL_FILES[k.ctype]], roots) : null;
    }
  }
}

function logReadError(kind, err) {
  if (!ABSENT.has(err.code)) console.error(`[archive] ${kind} read failed: ${err.code ?? err.message}`);
}

export function readTextDoc(file, kind) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(TEXT_MAX_BYTES, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) return null;
    let text = bytes.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const truncated = st.size > TEXT_MAX_BYTES;
    if (truncated) {
      // Cut before a whole line so a secret split by the cap is not left half-visible.
      const cut = text.lastIndexOf('\n');
      if (cut > 0) text = text.slice(0, cut + 1);
    }
    const r = redactText(text);
    const body = truncated ? r.text + TRUNCATED_MARK : r.text;
    return { kind, contentType: TEXT_TYPE, body, truncated, redacted: r.redacted };
  } catch (err) {
    logReadError(kind, err);
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readPngDoc(file, kind) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > PNG_MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const body = buf.subarray(0, n);
    if (!isPngBuffer(body)) return null;
    return { kind, contentType: 'image/png', body, truncated: false, redacted: 0 };
  } catch (err) {
    logReadError(kind, err);
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Archive over fixed roots. The scan is cached for ARCHIVE_TTL_MS; a miss on an id rescans at most once per
 * ARCHIVE_MISS_MIN_MS, so bogus ids cannot force a walk per request. Each scan logs its error codes (never paths)
 * and whether it was truncated.
 * @param {{roots: string[], now?: () => number, fsx?: object, log?: (msg: string) => void}} opts
 */
export function createArchive({ roots, now = Date.now, fsx = fs, log = (msg) => console.error(msg) }) {
  let snap = null;
  const build = () => {
    const at = now();
    const r = scanCases(roots, { fsx });
    if (r.errors.length) log(`[archive] scan read errors: ${[...new Set(r.errors)].join(', ')} (${r.errors.length})`);
    if (r.truncated) log(`[archive] scan truncated: more than ${ARCHIVE_CAP} cases or ${SCAN_DIR_BUDGET} directory reads`);
    if (r.councilCapped) log(`[archive] a plans/council dir has more than ${COUNCIL_DIRS_MAX} councils: only the first ${COUNCIL_DIRS_MAX} by name are listed`);
    snap = { at, byId: new Map(r.entries.map((e) => [e.id, e])), cases: r.cases, truncated: r.truncated, errors: r.errors };
    return snap;
  };
  const current = () => (snap && now() - snap.at < ARCHIVE_TTL_MS ? snap : build());
  const lookup = (id) => {
    let s = current();
    let entry = s.byId.get(id);
    if (!entry && now() - s.at >= ARCHIVE_MISS_MIN_MS) {
      s = build();
      entry = s.byId.get(id);
    }
    return entry ?? null;
  };
  return {
    list() {
      const s = current();
      return { cases: s.cases, truncated: s.truncated, errors: s.errors };
    },
    /**
     * @returns {{kind: string, contentType: string, body: string|Buffer, truncated: boolean, redacted: number}|null}
     * null is the one answer for every refusal (unknown id or kind, unlisted, outside, binary, oversize).
     */
    readDoc(id, kind) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return null;
      const k = parseKind(kind);
      if (!k) return null;
      const entry = lookup(id);
      if (!entry) return null;
      const conf = confinedFor(entry, k, roots);
      if (!conf) return null;
      return k.type === 'shot' ? readPngDoc(conf.file, k.kind) : readTextDoc(conf.file, k.kind);
    },
  };
}

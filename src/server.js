// HTTP + SSE server. Serves the static client, /api/health, /api/state, /api/sessions and /events.
// Two sources, one per mode: demo (scripted) and live (tails the read-only transcripts mount).
// Each source owns its own reducer state. Nothing here writes outside the process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduce, derive, EMPTY_STATE, parseConductorIdleMin } from './state.js';
import { startDemo } from './demo.js';
import { createTailer } from './tail.js';
import { parseCaseDirs, realRoots, resolveCaseDir, latestCaseFile, loadCaseFile, planFileOf, loadPlanPhases, phasesDoneFromFile } from './casefile.js';
import { createArchive, caseId, pruneAbsent, viewWithArchiveIds } from './archive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, '..', 'public');
const PORT = Number(process.env.PORT || 8700);
const HOST = process.env.HOST || '0.0.0.0';
const MODES = ['demo', 'live'];
const DEFAULT_MODE = process.env.HOSPITAL_MODE || 'demo';
const PROJECTS_DIR = process.env.HOSPITAL_PROJECTS_DIR || '/data/projects';
const WINDOW_H = Number(process.env.HOSPITAL_WINDOW_H || 6);
const HEARTBEAT_MS = 15000;
const IDLE_TICK_MS = 2000;
const MAX_EVENTS_PER_DELTA = 20;
const SESSION_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const CASE_REFRESH_MS = 3000;
// Case files are read only under these mounted roots (read-only binds in docker-compose).
const CASE_DIRS = parseCaseDirs(process.env.HOSPITAL_CASE_DIRS);
for (const bad of CASE_DIRS.rejected) console.error(`[hospital] HOSPITAL_CASE_DIRS entry ignored (not absolute): ${bad}`);
const CASE_ROOTS = realRoots(CASE_DIRS.roots);
for (const r of CASE_DIRS.roots) if (!fs.existsSync(r)) console.error(`[hospital] case root not mounted: ${r}`);
const ARCHIVE = createArchive({ roots: CASE_ROOTS });
// Phase 3: idle Conductors walk out after this long (HOSPITAL_CONDUCTOR_IDLE_MIN, default 30). Invalid = default + warning.
const CONDUCTOR_IDLE = parseConductorIdleMin(process.env.HOSPITAL_CONDUCTOR_IDLE_MIN);
if (CONDUCTOR_IDLE.warning) console.error(`[hospital] ${CONDUCTOR_IDLE.warning}`);
const CONDUCTOR_IDLE_MS = CONDUCTOR_IDLE.ms;
const viewOf = (state, now) => derive(state, now, { conductorIdleMs: CONDUCTOR_IDLE_MS });
// The view each client sees: derived state plus each case's archive id (opaque; the Archive room opens it).
const viewFor = (src, now) => viewWithArchiveIds(viewOf(src.state, now), src.caseKeys);

if (!MODES.includes(DEFAULT_MODE)) {
  console.error(`[hospital] HOSPITAL_MODE=${DEFAULT_MODE} is not one of ${MODES.join(', ')}`);
  process.exit(1);
}
if (!(WINDOW_H > 0)) {
  console.error(`[hospital] HOSPITAL_WINDOW_H=${process.env.HOSPITAL_WINDOW_H} must be a positive number of hours`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};
const CSP_DOC = "default-src 'none'; sandbox";

// Mode-specific view. Session filter keeps only that session's agents, case and messages.
function filterView(v, sid) {
  if (!sid) return v;
  const agents = Object.fromEntries(Object.entries(v.agents).filter(([, a]) => a.sessionId === sid));
  const ids = new Set(Object.keys(agents));
  const cases = v.cases[sid] ? { [sid]: v.cases[sid] } : {};
  const messages = v.messages.filter((m) => ids.has(m.from) || ids.has(m.to));
  const escalations = (v.escalations ?? []).filter((e) => e.sessionId === sid);
  return { ...v, agents, cases, messages, escalations };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ---- guard (hospital-5b1 risk R1 / decisions 7): runs before routing, on every route ----
// Host must name loopback (localhost, 127.0.0.1, [::1]; any port, case-insensitive) or a HOSPITAL_ALLOWED_HOSTS name.
// Anything else, a missing or duplicated Host, or an odd form is 421. Never a CORS header.
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const HOST_NAME = '(\\[[0-9a-f:]+\\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)';
const HOST_RE = new RegExp(`^${HOST_NAME}(?::(\\d{1,5}))?$`, 'i');

function parseAllowedHosts(value) {
  const out = new Set();
  for (const raw of String(value ?? '').split(',')) {
    const item = raw.trim().toLowerCase();
    if (!item) continue;
    const m = HOST_RE.exec(item);
    if (!m || m[2] !== undefined) {
      console.error(`[hospital] HOSPITAL_ALLOWED_HOSTS entry ignored: ${item} (give hostnames or addresses, no port)`);
      continue;
    }
    out.add(m[1]);
  }
  return out;
}
const ALLOWED_HOSTS = parseAllowedHosts(process.env.HOSPITAL_ALLOWED_HOSTS);

function hostAllowed(value) {
  const m = HOST_RE.exec(value);
  if (!m) return false;
  if (m[2] !== undefined && !(Number(m[2]) >= 1 && Number(m[2]) <= 65535)) return false;
  const name = m[1].toLowerCase();
  return LOOPBACK_NAMES.has(name) || ALLOWED_HOSTS.has(name);
}

// Exactly one Host header (node keeps only the first one in req.headers, so the raw list is counted).
function requestHostOk(req) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'host') count += 1;
  return count === 1 && typeof req.headers.host === 'string' && hostAllowed(req.headers.host);
}

// Browsers: same-origin (or none, a typed URL) only. Absent (curl, scripts) passes.
const FETCH_SITE_OK = new Set(['same-origin', 'none']);
// Phase 5 hardening: the Origin's port must equal the Host's port (a default port counts as 80 or 443).
function originOk(value, hostHeader) {
  try {
    const u = new URL(value);
    if (!(u.protocol === 'http:' || u.protocol === 'https:') || !hostAllowed(u.host)) return false;
    const hostPort = HOST_RE.exec(hostHeader)?.[2] ?? '80';
    const originPort = u.port || (u.protocol === 'https:' ? '443' : '80');
    return Number(originPort) === Number(hostPort);
  } catch {
    return false;
  }
}

function refuse(req, res, code, message) {
  req.resume();
  res.setHeader('Connection', 'close');
  sendJson(res, code, { error: message });
}

// /api/* and /events: a cross-site fetch or a foreign Origin is refused (403). Static files are not guarded this way.
function crossSiteRefused(req, pathname) {
  if (!(pathname.startsWith('/api/') || pathname === '/events')) return null;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && !FETCH_SITE_OK.has(site)) return 'cross-site request refused';
  const origin = req.headers.origin;
  if (origin !== undefined && !originOk(origin, req.headers.host)) return 'foreign origin refused';
  return null;
}

// Phase 2 documents. One refusal answer for every reason (unknown id or kind, unlisted, symlink out, binary, bad
// PNG, oversize, bad params): same status, headers and body, so nothing tells the reasons apart.
const DOC_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': CSP_DOC,
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const DOC_NOT_FOUND_BODY = Buffer.from(JSON.stringify({ error: 'not found' }));

function docNotFound(res) {
  res.writeHead(404, {
    ...DOC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': DOC_NOT_FOUND_BODY.length,
  });
  res.end(DOC_NOT_FOUND_BODY);
}

function handleDoc(res, url) {
  const q = url.searchParams;
  const ids = q.getAll('case');
  const kinds = q.getAll('doc');
  if ([...q.keys()].length !== 2 || ids.length !== 1 || kinds.length !== 1) return docNotFound(res);
  let doc;
  try {
    doc = ARCHIVE.readDoc(ids[0], kinds[0]);
  } catch (err) {
    console.error(`[hospital] doc read failed: ${err.code ?? err.message}`);
    return docNotFound(res);
  }
  if (!doc) return docNotFound(res);
  const headers = { ...DOC_HEADERS, 'Content-Type': doc.contentType, 'Content-Length': Buffer.byteLength(doc.body) };
  if (doc.contentType.startsWith('text/')) {
    headers['X-Redacted-Count'] = String(doc.redacted);
    headers['X-Truncated'] = doc.truncated ? 'true' : 'false';
  }
  res.writeHead(200, headers);
  return res.end(doc.body);
}

// Case list. `live` = the same case id as a live session's state file (one patient, not two).
function liveCaseIds() {
  const src = sources.get('live');
  return new Set(src ? [...src.caseKeys.values()].map((k) => k.caseId) : []);
}

function handleArchive(res) {
  const listing = ARCHIVE.list();
  const live = liveCaseIds();
  return sendJson(res, 200, {
    cases: listing.cases.map((c) => ({ ...c, live: live.has(c.id) })),
    truncated: listing.truncated,
  });
}

// One source = one mode. Created on first use and kept running afterwards.
const sources = new Map();

function createSource(mode) {
  const src = { mode, state: EMPTY_STATE(), clients: new Set(), stops: [], tailer: null, cwds: new Map(), caseKeys: new Map() };

  // Single entry point for every event (demo or live). Rejected events are logged with context.
  src.ingest = (evs) => {
    const applied = [];
    for (const ev of evs) {
      try {
        src.state = reduce(src.state, ev);
        applied.push(ev);
      } catch (err) {
        console.error(`[hospital] ${mode} rejected event kind=${ev.kind}: ${err.message}`);
      }
    }
    if (!applied.length || src.clients.size === 0) return;
    const v = viewFor(src, Date.now());
    for (const c of src.clients) {
      const mine = applied.filter((ev) => !c.session || !ev.sessionId || ev.sessionId === c.session);
      const hasTick = applied.some((ev) => ev.kind === 'idle_tick');
      if (!mine.length && !hasTick) continue;
      sse(c.res, 'delta', { events: mine.slice(-MAX_EVENTS_PER_DELTA), state: filterView(v, c.session) });
    }
  };

  if (mode === 'demo') {
    src.stops.push(startDemo((ev) => src.ingest([ev])));
  } else {
    src.tailer = createTailer({
      root: PROJECTS_DIR,
      windowMs: WINDOW_H * 3600_000,
      emit: (evs) => src.ingest(evs),
      onCwd: (sid, cwd) => src.cwds.set(sid, cwd),
    });
    src.tailer.start();
    src.stops.push(() => src.tailer.stop());
    const caseTimer = setInterval(() => refreshCaseFiles(src), CASE_REFRESH_MS);
    src.stops.push(() => clearInterval(caseTimer));
  }
  const ticker = setInterval(() => src.ingest([{ kind: 'idle_tick', t: Date.now(), conductorIdleMs: CONDUCTOR_IDLE_MS }]), IDLE_TICK_MS);
  src.stops.push(() => clearInterval(ticker));
  console.log(`[hospital] source started: ${mode}`);
  return src;
}

// Case files of the live sessions. The state file is re-read only when its key changes (path|mtime|size); the
// plan it names (Phase 4b) is re-read only when the plan's own key changes. A plan-only change re-emits triage
// (the phases) and nothing else, so an answered gate never rings again. Only events the reducer understands are
// produced; the body of either file is never forwarded.
// Phase 5 hardening: a session counts as live while its last transcript event is inside the window (the same
// window as the session picker). Keys of sessions that left it are pruned, so the archive's `live` flag is accurate.
function refreshCaseFiles(src) {
  const windowMs = WINDOW_H * 3600_000;
  const now = Date.now();
  const live = new Set(src.tailer ? src.tailer.sessions().filter((s) => now - s.lastT <= windowMs).map((s) => s.sessionId) : []);
  const dropped = pruneAbsent(src.caseKeys, live);
  if (dropped.length) console.log(`[hospital] case keys pruned (sessions left the window): ${dropped.length}`);
  for (const [sid, cwd] of src.cwds) {
    if (!live.has(sid)) continue;
    const plans = resolveCaseDir(cwd, CASE_ROOTS);
    if (!plans) continue;
    const latest = latestCaseFile(plans, CASE_ROOTS);
    if (!latest) continue;
    const prev = src.caseKeys.get(sid);
    const stateChanged = !prev || prev.stateKey !== latest.key;
    if (!stateChanged && (planFileOf(plans, prev.cf.planFile, CASE_ROOTS)?.key ?? null) === prev.planKey) continue;
    let cf = prev?.cf;
    if (stateChanged) {
      try {
        cf = loadCaseFile(latest.file);
      } catch (err) {
        console.error(`[hospital] case file read failed for ${sid}: ${err.code ?? err.message}`);
        continue;
      }
    }
    const plan = loadPlanPhases(plans, cf.planFile, CASE_ROOTS);
    if (plan.error) console.error(`[hospital] plan read failed for ${sid}: ${plan.error}`);
    if (!plan.key && cf.planFile) console.error(`[hospital] plan of ${sid} not readable or outside its plans dir (${cf.planFile.length} chars)`);
    src.caseKeys.set(sid, { stateKey: latest.key, planKey: plan.key, cf, caseId: caseId(latest.file) });
    const t = Date.now();
    // The state file's own progress (Phase 4b revision): reducer takes max(transcripts, this count); COMPLETE = all done.
    const evs = [{
      t, kind: 'triage', sessionId: sid, tier: cf.tier, caseKind: cf.caseKind ?? '', phases: plan.phases,
      filePhasesDone: phasesDoneFromFile(cf.progress, plan.phases), fileComplete: cf.progress.complete,
    }];
    if (stateChanged) {
      if (cf.status) evs.push({ t, kind: 'case_status', sessionId: sid, status: cf.status });
      evs.push({ t, kind: 'risk_accepted', sessionId: sid, items: cf.accepted });
      evs.push({ t, kind: 'case_counters', sessionId: sid, reroutes: cf.counters.reroutes, diagnosisRounds: cf.counters.diagnosisRounds });
      if (cf.gate) evs.push({ t, kind: 'approval_pending', sessionId: sid, action: cf.gate });
    }
    src.ingest(evs);
  }
}

function getSource(mode) {
  if (!sources.has(mode)) sources.set(mode, createSource(mode));
  return sources.get(mode);
}

function parseQuery(url) {
  const mode = url.searchParams.get('mode') || DEFAULT_MODE;
  const session = url.searchParams.get('session') || null;
  if (!MODES.includes(mode)) return { error: `mode must be one of ${MODES.join(', ')}` };
  if (session !== null && !SESSION_RE.test(session)) return { error: 'session id has an invalid format' };
  return { mode, session };
}

function handleEvents(req, res, url) {
  const q = parseQuery(url);
  if (q.error) return sendJson(res, 400, { error: q.error });
  const src = getSource(q.mode);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const client = { res, session: q.session };
  sse(res, 'snapshot', filterView(viewFor(src, Date.now()), q.session));
  src.clients.add(client);
  const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(beat);
    src.clients.delete(client);
  });
}

function handleState(res, url) {
  const q = parseQuery(url);
  if (q.error) return sendJson(res, 400, { error: q.error });
  const src = getSource(q.mode);
  return sendJson(res, 200, filterView(viewFor(src, Date.now()), q.session));
}

// Session picker data: sessions tailed in the window (live mode only).
function handleSessions(res) {
  const src = getSource('live');
  return sendJson(res, 200, { root: PROJECTS_DIR, windowH: WINDOW_H, sessions: src.tailer.sessions() });
}

function handleStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad path encoding' });
  }
  // NUL makes fs throw synchronously; backslash is a traversal vector on some platforms.
  if (rel.includes('\0') || rel.includes('\\')) return sendJson(res, 400, { error: 'bad path' });
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    fs.stat(file, (err, st) => {
      if (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') console.error(`[hospital] stat ${file}: ${err.message}`);
        return sendJson(res, 404, { error: 'not found' });
      }
      if (!st.isFile()) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file)
        .on('error', (e) => { console.error(`[hospital] read ${file}: ${e.message}`); res.destroy(); })
        .pipe(res);
    });
  } catch (e) {
    console.error(`[hospital] static ${file}: ${e.message}`);
    return sendJson(res, 400, { error: 'bad path' });
  }
}

const server = http.createServer((req, res) => {
  if (!requestHostOk(req)) return refuse(req, res, 421, 'host not allowed');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return refuse(req, res, 400, 'bad request target');
  }
  const { pathname } = url;
  const crossSite = crossSiteRefused(req, pathname);
  if (crossSite) return refuse(req, res, 403, crossSite);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Body is not read by this server; drain it and close so the client gets a complete reply.
    return refuse(req, res, 405, 'method not allowed');
  }
  if (pathname === '/health' || pathname === '/api/health') return sendJson(res, 200, { ok: true, mode: DEFAULT_MODE });
  if (pathname === '/api/state') return handleState(res, url);
  if (pathname === '/api/sessions') return handleSessions(res);
  if (pathname === '/api/archive') return handleArchive(res);
  if (pathname === '/api/doc') return handleDoc(res, url);
  if (pathname === '/events') return handleEvents(req, res, url);
  return handleStatic(req, res, pathname);
});

// Start the default source eagerly so live tailing begins at boot in live mode.
getSource(DEFAULT_MODE);

server.listen(PORT, HOST, () => {
  console.log(`[hospital] default mode=${DEFAULT_MODE} listening on ${HOST}:${PORT}`);
});

function shutdown() {
  for (const src of sources.values()) {
    for (const stop of src.stops) stop();
    for (const c of src.clients) c.res.end();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Carry-over from Phase 1: an uncaught error means the process state is unknown. Log and exit(1);
// Docker's restart policy brings it back.
process.on('uncaughtException', (err) => {
  console.error(`[hospital] uncaught exception: ${err.stack || err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(`[hospital] unhandled rejection: ${err?.stack || err}`);
  process.exit(1);
});

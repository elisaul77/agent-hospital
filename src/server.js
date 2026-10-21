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
import { createCodexTailer } from './codex-tail.js';
import { classifyWorkflow } from './workflow.js';
import { parseCaseDirs, realRoots, resolveCaseDir, inside, loadCaseFile, planFileOf, loadPlanPhases, phasesDoneFromFile } from './casefile.js';
import { createArchive, caseId, pruneAbsent, viewWithArchiveIds } from './archive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, '..', 'public');
const PORT = Number(process.env.PORT || 8700);
const HOST = process.env.HOST || '0.0.0.0';
const MODES = ['demo', 'live'];
const DEFAULT_MODE = process.env.HOSPITAL_MODE || 'demo';
const PROJECTS_DIR = process.env.HOSPITAL_PROJECTS_DIR || '/data/projects';
const CODEX_DIR = process.env.HOSPITAL_CODEX_DIR || '/data/codex-sessions';
const WINDOW_H = Number(process.env.HOSPITAL_WINDOW_H || 6);
const HEARTBEAT_MS = 15000;
const IDLE_TICK_MS = 2000;
const MAX_EVENTS_PER_DELTA = 20;
const SESSION_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const CASE_REFRESH_MS = 3000;
const safeErrorCode = (err) => typeof err?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code)
  ? err.code : 'unknown';
// Case files are read only under these mounted roots (read-only binds in docker-compose).
const CASE_DIRS = parseCaseDirs(process.env.HOSPITAL_CASE_DIRS);
for (const _bad of CASE_DIRS.rejected) console.error('[hospital] HOSPITAL_CASE_DIRS entry ignored (not absolute)');
const CASE_ROOTS = realRoots(CASE_DIRS.roots);
for (const r of CASE_DIRS.roots) if (!fs.existsSync(r)) console.error('[hospital] case root not mounted');
const ARCHIVE = createArchive({ roots: CASE_ROOTS });
// Phase 3: idle Conductors walk out after this long (HOSPITAL_CONDUCTOR_IDLE_MIN, default 30). Invalid = default + warning.
const CONDUCTOR_IDLE = parseConductorIdleMin(process.env.HOSPITAL_CONDUCTOR_IDLE_MIN);
if (CONDUCTOR_IDLE.warning) console.error(`[hospital] ${CONDUCTOR_IDLE.warning}`);
const CONDUCTOR_IDLE_MS = CONDUCTOR_IDLE.ms;
const viewOf = (state, now) => derive(state, now, { conductorIdleMs: CONDUCTOR_IDLE_MS });
// The view each client sees: derived state plus each case's archive id (opaque; the Archive room opens it).
const viewFor = (src, now) => viewWithArchiveIds(viewOf(src.state, now), src.caseKeys);

if (!MODES.includes(DEFAULT_MODE)) {
  console.error('[hospital] HOSPITAL_MODE must be demo or live');
  process.exit(1);
}
if (!(WINDOW_H > 0)) {
  console.error('[hospital] HOSPITAL_WINDOW_H must be a positive number of hours');
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
  const messages = v.messages.filter((m) => ids.has(m.from) && (!v.agents[m.to] || ids.has(m.to)));
  const workflows = v.workflows?.[sid] ? { [sid]: v.workflows[sid] } : {};
  const escalations = (v.escalations ?? []).filter((e) => e.sessionId === sid);
  return { ...v, agents, cases, workflows, messages, escalations };
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
      console.error('[hospital] HOSPITAL_ALLOWED_HOSTS entry ignored (give hostnames or addresses, no port)');
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
    const hostMatch = HOST_RE.exec(hostHeader);
    if (!hostMatch || u.hostname.toLowerCase() !== hostMatch[1].toLowerCase()) return false;
    const hostPort = hostMatch[2] ?? '80';
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
    console.error(`[hospital] doc read failed: ${safeErrorCode(err)}`);
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
  const src = { mode, state: EMPTY_STATE({ trustedDemo: mode === 'demo' }), clients: new Set(), stops: [], tailers: [], cwds: new Map(),
    firstT: new Map(), caseKeys: new Map(), codexEvidence: new Map() };

  // Single entry point for every event (demo or live). Rejected events are logged with context.
  src.ingest = (evs) => {
    const applied = [];
    for (const ev of evs) {
      try {
        if (ev.kind === 'agent_spawn' && ev.agentId === ev.sessionId && Number.isFinite(ev.t))
          src.firstT.set(ev.sessionId, Math.min(src.firstT.get(ev.sessionId) ?? Infinity, ev.t));
        src.state = reduce(src.state, ev);
        if (ev.sessionId?.startsWith('codex-') && ev.agentId && ev.agentId !== ev.sessionId) {
          if (ev.kind === 'agent_spawn' && ev.parentAgentId?.startsWith('codex-')) {
            const children = src.codexEvidence.get(ev.sessionId) ?? new Map();
            children.set(ev.agentId, { parentAgentId: ev.parentAgentId, role: ev.subagentType, handback: false });
            src.codexEvidence.set(ev.sessionId, children);
          } else if (ev.kind === 'agent_done') {
            const child = src.codexEvidence.get(ev.sessionId)?.get(ev.agentId);
            if (child) child.handback = true;
          }
        }
        applied.push(ev);
      } catch (err) {
        console.error(`[hospital] ${mode} rejected event (${safeErrorCode(err)})`);
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
    const onCwd = (sid, cwd, sessionStartedAt) => {
      src.cwds.set(sid, cwd);
      const startedAt = typeof sessionStartedAt === 'string' ? Date.parse(sessionStartedAt) : sessionStartedAt;
      if (Number.isFinite(startedAt)) src.firstT.set(sid, Math.min(src.firstT.get(sid) ?? Infinity, startedAt));
    };
    src.tailers = [
      createTailer({ root: PROJECTS_DIR, windowMs: WINDOW_H * 3600_000, emit: src.ingest, onCwd }),
      createCodexTailer({ root: CODEX_DIR, windowMs: WINDOW_H * 3600_000, emit: src.ingest, onCwd }),
    ];
    for (const tailer of src.tailers) {
      tailer.start();
      src.stops.push(() => tailer.stop());
    }
    const caseTimer = setInterval(() => refreshCaseFiles(src), CASE_REFRESH_MS);
    src.stops.push(() => clearInterval(caseTimer));
  }
  const ticker = setInterval(() => src.ingest([{ kind: 'idle_tick', t: Date.now(), conductorIdleMs: CONDUCTOR_IDLE_MS }]), IDLE_TICK_MS);
  src.stops.push(() => clearInterval(ticker));
  console.log(`[hospital] source started: ${mode}`);
  return src;
}

// A case file belongs to a live session only when its cwd is observed, its file is confined and fresh,
// and it is the sole eligible state file in that plans directory. We never bind the newest arbitrary file.
function matchedCaseFile(plans, startedAt, now, sessionId) {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  const names = [];
  let dir;
  let overflow = false;
  let closeFailed = false;
  try {
    dir = fs.opendirSync(plans);
    let entries = 0;
    for (let ent = dir.readSync(); ent; ent = dir.readSync()) {
      if (++entries > 256) { overflow = true; break; }
      if (ent.name.endsWith('-state.md')) names.push(ent.name);
    }
  } catch (err) {
    console.error(`[hospital] case directory read failed: ${err.code ?? 'unknown'}`);
    return null;
  } finally { try { dir?.closeSync(); } catch { closeFailed = true; } }
  if (overflow) { console.error('[hospital] case directory entry cap exceeded (256)'); return null; }
  if (closeFailed) { console.error('[hospital] case directory close failed'); return null; }
  const matches = [];
  for (const name of names) {
    try {
      const real = fs.realpathSync(path.join(plans, name));
      if (path.dirname(real) !== plans || !inside(real, CASE_ROOTS)) continue;
      const st = fs.statSync(real);
      if (!st.isFile() || st.mtimeMs < startedAt || st.mtimeMs > now || now - st.mtimeMs > WINDOW_H * 3600_000) continue;
      const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let head;
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size
          || fs.realpathSync(path.join(plans, name)) !== real) continue;
        const buf = Buffer.alloc(Math.min(st.size, 16 * 1024));
        head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8').split('\n').slice(0, 40).join('\n');
      } finally { fs.closeSync(fd); }
      const poolHeaders = /^Owner:\s*Conductor\s*$/m.test(head)
        && /^Classification:\s*Tier [SML]\b/m.test(head) && /^Plan file:\s*\S+/m.test(head);
      const boundSession = head.split('\n').map((line) => /^Hospital session:\s*(\S+)\s*$/.exec(line)?.[1]).find(Boolean);
      if (poolHeaders) matches.push({ file: real, key: `${real}|${st.mtimeMs}|${st.size}`, modifiedAt: st.mtimeMs,
        dev: st.dev, ino: st.ino, size: st.size, sessionBound: boundSession === sessionId });
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[hospital] case candidate read failed: ${err.code ?? 'unknown'}`);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function liveSessions(src, now = Date.now()) {
  const cutoff = now - WINDOW_H * 3600_000;
  return src.tailers.flatMap((tailer) => tailer.sessions()).filter((s) => s.lastT >= cutoff)
    .sort((a, b) => b.lastT - a.lastT || a.sessionId.localeCompare(b.sessionId));
}

// Refresh only confirmed pool cases. Codex confirmation requires a fresh, confined state file plus
// structural parent/child role evidence; Codex has no SubagentHandback event.
function refreshCaseFiles(src) {
  const now = Date.now();
  const sessions = liveSessions(src, now);
  const live = new Set(sessions.map((s) => s.sessionId));
  const dropped = pruneAbsent(src.caseKeys, live);
  if (dropped.length) console.log(`[hospital] case keys pruned (sessions left the window): ${dropped.length}`);
  for (const sid of src.codexEvidence.keys()) if (!live.has(sid)) src.codexEvidence.delete(sid);
  const cwdCounts = new Map();
  for (const sid of live) {
    const cwd = src.cwds.get(sid);
    if (cwd) cwdCounts.set(cwd, (cwdCounts.get(cwd) ?? 0) + 1);
  }
  for (const session of sessions) {
    const sid = session.sessionId;
    const cwd = src.cwds.get(sid);
    const explicitClaudePool = session.provider === 'claude'
      && src.state.workflows?.[sid]?.workflow === 'subagent-pool'
      && src.state.workflows[sid].reason === 'skill_invocation';
    if (!cwd || (cwdCounts.get(cwd) !== 1 && !explicitClaudePool)) continue;
    const plans = resolveCaseDir(cwd, CASE_ROOTS);
    if (!plans) continue;
    const startedAt = src.firstT.get(sid);
    const matched = matchedCaseFile(plans, startedAt, now, sid);
    if (!matched) continue;
    let confirmed = src.state.workflows?.[sid]?.workflow === 'subagent-pool';
    if (!confirmed && session.provider === 'codex') {
      const children = [...(src.codexEvidence.get(sid)?.values() ?? [])];
      const poolRoles = children.some((a) => ['planning-agent', 'implement-agent', 'review-agent'].includes(a.role));
      const handback = children.some((a) => a.handback && ['planning-agent', 'implement-agent', 'review-agent'].includes(a.role));
      const result = classifyWorkflow({ runtime: 'codex', sessionId: sid, sessionStartedAt: startedAt,
        observedAt: now, parentChild: children.length > 0, poolRoles, handback,
        caseFile: { confined: true, active: true, sessionBound: matched.sessionBound,
          sessionId: sid, poolHeaders: true, modifiedAt: matched.modifiedAt } });
      if (result.workflow === 'subagent-pool') {
        src.ingest([{ t: now, kind: 'workflow_confirmed', sessionId: sid, ...result }]);
        confirmed = src.state.workflows?.[sid]?.workflow === 'subagent-pool';
      }
    }
    if (!confirmed) continue;
    const prev = src.caseKeys.get(sid);
    const stateChanged = !prev || prev.stateKey !== matched.key;
    if (!stateChanged && (planFileOf(plans, prev.cf.planFile, CASE_ROOTS)?.key ?? null) === prev.planKey) continue;
    let cf = prev?.cf;
    if (stateChanged) {
      try { cf = loadCaseFile(matched.file, 256 * 1024, matched); }
      catch (err) { console.error(`[hospital] case file read failed for ${sid}: ${err.code ?? 'unknown'}`); continue; }
    }
    const plan = loadPlanPhases(plans, cf.planFile, CASE_ROOTS);
    if (plan.error) console.error(`[hospital] plan read failed for ${sid}`);
    if (!plan.key && cf.planFile) console.error(`[hospital] plan of ${sid} not readable or outside its plans dir (${cf.planFile.length} chars)`);
    src.caseKeys.set(sid, { stateKey: matched.key, planKey: plan.key, cf, caseId: caseId(matched.file) });
    const t = Date.now();
    const evs = [{ t, kind: 'triage', sessionId: sid, tier: cf.tier, caseKind: cf.caseKind ?? '',
      phases: plan.phases, filePhasesDone: phasesDoneFromFile(cf.progress, plan.phases), fileComplete: cf.progress.complete }];
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
  const sessions = liveSessions(src).map((s) => ({ sessionId: s.sessionId, provider: s.provider,
    runtime: s.provider, project: String(s.project ?? '').slice(0, 60), name: String(s.project ?? s.provider ?? '').slice(0, 60), lastT: s.lastT }));
  return sendJson(res, 200, { windowH: WINDOW_H, sessions });
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
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') console.error(`[hospital] static stat failed: ${err.code ?? 'unknown'}`);
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
        .on('error', (e) => { console.error(`[hospital] static read failed: ${e.code ?? 'unknown'}`); res.destroy(); })
        .pipe(res);
    });
  } catch (e) {
    console.error(`[hospital] static request failed: ${e.code ?? 'unknown'}`);
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
  console.error(`[hospital] uncaught exception: ${safeErrorCode(err)}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(`[hospital] unhandled rejection: ${safeErrorCode(err)}`);
  process.exit(1);
});

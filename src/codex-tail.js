// Read-only, bounded observer for Codex rollout JSONL. Only structural metadata crosses this boundary.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;
const MAX_FILES = 256;
const MAX_ENTRIES = 4096;
const MAX_LINE = 256 * 1024;
const CHUNK = 256 * 1024;
const MAX_BYTES_PER_TICK = 1024 * 1024;
const MAX_LINES_PER_TICK = 4096;
const ID = (uuid) => `codex-${uuid.toLowerCase()}`;
const isUuid = (value) => typeof value === 'string' && UUID.test(value);
const isDir = (entry) => entry.isDirectory() && !entry.isSymbolicLink();
const safeTool = (value) => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(value)
  ? value.slice(0, 40) : '';
const validTime = (value) => {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** @returns {{start: () => void, stop: () => void, sessions: () => object[]}} */
export function createCodexTailer({ root, windowMs, emit, log = () => {}, now = () => Date.now(), pollMs = 1000, onCwd }) {
  if (typeof root !== 'string' || !root || !Number.isFinite(windowMs) || windowMs <= 0 || typeof emit !== 'function') {
    throw new TypeError('invalid Codex tailer options');
  }
  const files = new Map();
  const dormant = new Map();
  const rejected = new Set();
  const sessionsById = new Map();
  const parents = new Map();
  const knownRoots = new Set();
  const warned = new Set();
  let timer = null;
  let busy = false;
  let scanCursor = 0;
  let dayScan = null;
  let closeWhenIdle = false;
  let realRoot = null;
  let activityClock = 0;

  function warn(code) {
    if (warned.has(code)) return;
    warned.add(code);
    log(`[codex-tail] ${code}`); // count/code only: never paths or transcript text
  }

  function active(t) { return t >= now() - windowMs && t <= now() + 60_000; }
  function rootOf(id) {
    const seen = new Set();
    let current = id;
    while (parents.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parents.get(current);
    }
    return current;
  }
  function sessionFor(file) { return ID(rootOf(file.id)); }
  function touch(file, t) {
    const sessionId = sessionFor(file);
    const old = sessionsById.get(sessionId);
    const lastT = Math.max(t, old?.lastT ?? 0);
    sessionsById.set(sessionId, { sessionId, project: old?.project || file.project, lastT, provider: 'codex' });
    file.lastActive = ++activityClock;
  }
  async function* entries(dir) {
    try {
      const directory = await fsp.opendir(dir);
      for await (const entry of directory) yield entry;
    } catch (err) { warn(`scan failed (${err.code ?? 'unknown'})`); }
  }
  function retire(file) {
    files.delete(file.path);
    dormant.delete(file.path);
    dormant.set(file.path, file);
    if (dormant.size > MAX_FILES) dormant.delete(dormant.keys().next().value);
  }
  function makeRoom() {
    const complete = [...files.values()].filter((file) => file.invalid || (file.offset >= file.size && !file.pending.length));
    const victims = complete.length ? complete : [...files.values()];
    if (!victims.length) return false;
    victims.sort((a, b) => Number(a.calls.size > 0) - Number(b.calls.size > 0)
      || a.lastActive - b.lastActive);
    retire(victims[0]);
    return true;
  }
  async function closeDay() {
    const scan = dayScan;
    dayScan = null;
    if (scan) {
      try { await scan.handle.close(); }
      catch (err) { warn(`day scan close failed (${err.code ?? 'unknown'})`); }
    }
  }
  async function discover() {
    let rootStat;
    try { rootStat = await fsp.lstat(root); }
    catch (err) { warn(`root unavailable (${err.code ?? 'unknown'})`); return; }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) { warn('root is not a real directory'); return; }
    realRoot = await fsp.realpath(root);
    const days = [];
    let traversed = 0;
    for await (const y of entries(root)) {
      if (++traversed > MAX_ENTRIES) break;
      if (!isDir(y) || !/^\d{4}$/.test(y.name)) continue;
      for await (const m of entries(path.join(root, y.name))) {
        if (++traversed > MAX_ENTRIES) break;
        if (!isDir(m) || !/^(0[1-9]|1[0-2])$/.test(m.name)) continue;
        for await (const d of entries(path.join(root, y.name, m.name))) {
          if (++traversed > MAX_ENTRIES) break;
          if (isDir(d) && /^(0[1-9]|[12]\d|3[01])$/.test(d.name)) days.push(path.join(root, y.name, m.name, d.name));
        }
      }
      if (traversed > MAX_ENTRIES) break;
    }
    if (traversed > MAX_ENTRIES) warn('directory entry limit reached');
    days.sort();
    if (dayScan && !days.includes(dayScan.dir)) await closeDay();
    if (!days.length) return;
    if (dayScan) scanCursor = days.indexOf(dayScan.dir);
    scanCursor %= days.length;
    let candidates = 0;
    for (let visited = 0; visited < days.length && candidates < MAX_ENTRIES;) {
      const dir = dayScan?.dir ?? days[scanCursor];
      if (!dayScan) {
        try { dayScan = { dir, handle: await fsp.opendir(dir) }; }
        catch (err) {
          warn(`scan failed (${err.code ?? 'unknown'})`);
          scanCursor = (scanCursor + 1) % days.length;
          visited++;
          continue;
        }
      }
      let exhausted = false;
      while (candidates < MAX_ENTRIES) {
        let ent;
        try { ent = await dayScan.handle.read(); }
        catch (err) { warn(`scan failed (${err.code ?? 'unknown'})`); exhausted = true; break; }
        if (!ent) { exhausted = true; break; }
        candidates++;
        if (!ent.isFile() || ent.isSymbolicLink()) continue;
        const match = ROLLOUT.exec(ent.name);
        if (!match) continue;
        const p = path.join(dir, ent.name);
        if (files.has(p) || rejected.has(p)) continue;
        let st;
        try { st = await fsp.lstat(p); }
        catch (err) { warn(`candidate stat failed (${err.code ?? 'unknown'})`); continue; }
        if (!st.isFile() || st.isSymbolicLink() || st.mtimeMs < now() - windowMs) continue;
        try { if (!withinRoot(await fsp.realpath(p))) { warn('candidate escaped root'); continue; } }
        catch (err) { warn(`candidate resolve failed (${err.code ?? 'unknown'})`); continue; }
        const previous = dormant.get(p);
        if (previous && (previous.dev !== st.dev || previous.ino !== st.ino || st.size < previous.offset)) {
          dormant.delete(p);
          rejected.add(p);
          warn('tracked file changed identity');
          continue;
        }
        if (previous && previous.offset >= st.size && !previous.pending.length) continue;
        if (files.size >= MAX_FILES && !makeRoom()) continue;
        if (previous) dormant.delete(p);
        files.set(p, previous ?? { path: p, expectedId: match[1].toLowerCase(), dev: st.dev, ino: st.ino, offset: 0,
          pending: Buffer.alloc(0), id: null, parent: null, role: null, project: '', startedAt: null, spawned: false,
          done: false, completedTurns: new Set(), discarding: false, calls: new Map(), invalid: false,
          size: st.size, lastActive: 0 });
      }
      if (!exhausted) break;
      await closeDay();
      scanCursor = (scanCursor + 1) % days.length;
      visited++;
    }
    if (candidates >= MAX_ENTRIES || files.size >= MAX_FILES) warn('candidate/file limit reached');
  }
  function withinRoot(resolved) {
    const relative = path.relative(realRoot, resolved);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  function reject(file, reason) {
    file.invalid = true;
    file.pending = Buffer.alloc(0);
    rejected.add(file.path);
    warn(reason);
  }
  function metadata(file, obj) {
    const p = obj.payload;
    const startedAt = validTime(obj.timestamp);
    if (obj.type !== 'session_meta' || !p || !isUuid(p.id) || p.id.toLowerCase() !== file.expectedId || startedAt === null) {
      reject(file, 'invalid session metadata'); return;
    }
    const sub = p.source?.subagent;
    if (sub?.other === 'guardian') { reject(file, 'internal helper ignored'); return; }
    const spawn = sub?.thread_spawn;
    if (sub && !spawn) { reject(file, 'unrecognized subagent metadata'); return; }
    if (spawn && (!isUuid(spawn.parent_thread_id) || spawn.parent_thread_id.toLowerCase() === file.expectedId)) {
      reject(file, 'invalid parent metadata'); return;
    }
    file.id = p.id.toLowerCase();
    file.startedAt = startedAt;
    file.parent = spawn ? spawn.parent_thread_id.toLowerCase() : null;
    file.role = spawn && typeof spawn.agent_role === 'string' && /^[a-z][a-z0-9-]{0,39}$/i.test(spawn.agent_role)
      ? spawn.agent_role : 'codex-agent';
    file.project = typeof p.cwd === 'string' ? path.basename(p.cwd).slice(0, 60) : '';
    if (file.parent) parents.set(file.id, file.parent);
    else knownRoots.add(file.id);
    if (!file.parent && typeof p.cwd === 'string' && path.isAbsolute(p.cwd)) onCwd?.(ID(file.id), p.cwd, startedAt);
  }
  function spawn(file, t, out) {
    if (file.spawned || !file.id) return;
    file.spawned = true;
    out.push({ t, kind: 'agent_spawn', sessionId: sessionFor(file), agentId: ID(file.id),
      subagentType: file.parent ? file.role : 'assistant', parentAgentId: file.parent ? ID(file.parent) : null,
      workflow: 'unknown', runtime: 'codex' });
  }
  function processLine(file, bytes, out, metadataOnly = false) {
    if (!bytes.length) return;
    let obj;
    try { obj = JSON.parse(bytes.toString('utf8')); }
    catch { reject(file, 'malformed rollout record'); return; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    if (!file.id) { metadata(file, obj); if (file.invalid) return; }
    if (metadataOnly) return;
    const t = validTime(obj.timestamp);
    if (!t) return;
    if (!active(t)) return;
    const p = obj.payload;
    // A completed child may receive another turn after the reducer has removed its sprite.
    // Spawn it again before forwarding the new turn's first tool.
    if (file.parent && file.done && p && typeof p === 'object'
      && ((obj.type === 'event_msg' && p.type === 'task_started')
        || (obj.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')))) {
      file.spawned = false;
      file.done = false;
    }
    spawn(file, t, out);
    touch(file, t);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return;
    const base = { t, sessionId: sessionFor(file), agentId: ID(file.id) };
    if (obj.type === 'response_item') {
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.call_id === 'string') {
        const tool = safeTool(p.name);
        if (tool && p.call_id.length <= 128 && !file.calls.has(p.call_id)) {
          const toolUseId = `codex-tool-${randomUUID()}`;
          file.calls.set(p.call_id, toolUseId);
          if (file.parent) file.done = false; // A later send_input turn can resume this child.
          if (file.calls.size > 4096) { reject(file, 'tool call limit reached'); return; }
          out.push({ ...base, kind: 'tool_start', tool, label: '', toolUseId });
        }
      } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && typeof p.call_id === 'string' && file.calls.has(p.call_id)) {
        const toolUseId = file.calls.get(p.call_id);
        file.calls.delete(p.call_id);
        out.push({ ...base, kind: 'tool_end', toolUseId });
      }
    } else if (obj.type === 'event_msg' && file.parent) {
      if (p.type === 'task_started') file.done = false;
      if (p.type !== 'task_complete') return; // item_completed may carry commands and output.
      const turnId = typeof p.turn_id === 'string' && p.turn_id.length <= 128 ? p.turn_id : null;
      if (turnId && file.completedTurns.has(turnId)) return;
      if (file.done) return;
      if (turnId) {
        file.completedTurns.add(turnId);
        if (file.completedTurns.size > 1024) file.completedTurns.delete(file.completedTurns.values().next().value);
      }
      file.done = true;
      out.push({ ...base, kind: 'agent_done' });
    }
  }
  async function advance(file, metadataOnly = false) {
    if (metadataOnly && file.id) return;
    let st;
    try { st = await fsp.lstat(file.path); }
    catch (err) { reject(file, `tracked file unavailable (${err.code ?? 'unknown'})`); return; }
    if (!st.isFile() || st.isSymbolicLink() || st.dev !== file.dev || st.ino !== file.ino || st.size < file.offset) {
      reject(file, 'tracked file changed identity'); return;
    }
    file.size = st.size;
    if (st.size === file.offset) return;
    try { if (!withinRoot(await fsp.realpath(file.path))) { reject(file, 'tracked file escaped root'); return; } }
    catch (err) { reject(file, `tracked file resolve failed (${err.code ?? 'unknown'})`); return; }
    let handle;
    try {
      handle = await fsp.open(file.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = await handle.stat();
      const current = await fsp.lstat(file.path);
      if (opened.dev !== file.dev || opened.ino !== file.ino || current.dev !== file.dev || current.ino !== file.ino
        || !withinRoot(await fsp.realpath(file.path))) {
        reject(file, 'tracked file changed during open'); return;
      }
      let bytes = 0, lines = 0;
      const lineLimit = metadataOnly ? 1 : MAX_LINES_PER_TICK;
      const out = [];
      while (!file.invalid && file.offset < opened.size && bytes < MAX_BYTES_PER_TICK && lines < lineLimit) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, opened.size - file.offset, MAX_BYTES_PER_TICK - bytes));
        const { bytesRead } = await handle.read(buf, 0, buf.length, file.offset);
        if (!bytesRead) break;
        file.offset += bytesRead;
        bytes += bytesRead;
        const data = Buffer.concat([file.pending, buf.subarray(0, bytesRead)]);
        let from = 0, end;
        while ((end = data.indexOf(0x0a, from)) !== -1 && lines < lineLimit) {
          if (file.discarding || end - from > MAX_LINE) {
            warn('oversized rollout record skipped');
          } else {
            processLine(file, data.subarray(from, end), out, metadataOnly);
          }
          file.discarding = false;
          lines++;
          from = end + 1;
          if (file.invalid) break;
        }
        if (file.invalid) break;
        if (lines >= lineLimit) {
          // Re-read only the unconsumed bytes on the next poll; pending remains bounded.
          file.offset -= data.length - from;
          file.pending = Buffer.alloc(0);
          break;
        }
        const remainder = data.subarray(from);
        if (file.discarding || remainder.length > MAX_LINE) {
          file.discarding = true;
          file.pending = Buffer.alloc(0);
          if (remainder.length > MAX_LINE) warn('oversized rollout record skipped');
        } else {
          file.pending = Buffer.from(remainder);
        }
      }
      if (out.length) emit(out);
    } catch (err) {
      reject(file, `read failed (${err.code ?? 'unknown'})`);
    } finally { await handle?.close(); }
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      await discover();
      const list = [...files.values()].filter((f) => !f.invalid).sort((a, b) => Number(!!a.parent) - Number(!!b.parent) || a.path.localeCompare(b.path));
      for (const file of list) await advance(file, true);
      const ready = list.filter((file) => file.id && knownRoots.has(rootOf(file.id)));
      const spawns = [];
      for (const file of ready) {
        if (!file.spawned && active(file.startedAt)) {
          spawn(file, file.startedAt, spawns);
          touch(file, file.startedAt);
        }
      }
      if (spawns.length) emit(spawns);
      for (const file of ready) await advance(file);
    } finally {
      if (closeWhenIdle) { await closeDay(); closeWhenIdle = false; }
      busy = false;
    }
  }
  function run() { tick().catch((err) => warn(`poll failed (${err.code ?? 'unknown'})`)); }
  return {
    start() { if (timer) return; run(); timer = setInterval(run, pollMs); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; if (busy) closeWhenIdle = true; else void closeDay(); },
    sessions() { return [...sessionsById.values()].filter((session) => active(session.lastT))
      .sort((a, b) => b.lastT - a.lastT || a.sessionId.localeCompare(b.sessionId)); },
  };
}

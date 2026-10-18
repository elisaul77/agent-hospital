// Source layer for live mode. Discovers transcripts modified inside the time window under `root`
// (the read-only ~/.claude/projects mount), tails them by byte offset and emits normalized events.
// NEVER writes: files are opened with 'r' only. fs.watch only schedules a tick; the poll is the fallback.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseLine, normalizeLine, spawnEvents, modeOf, specialtyOf } from './normalize.js';
import { effectiveAgentType } from './roles.js';

const CHUNK_BYTES = 1 << 20;
const WATCH_DEBOUNCE_MS = 150;
const SUB_RE = /^agent-(.+)\.jsonl$/;

// Complete lines only. The unterminated tail stays in the caller's buffer for the next read.
export function takeCompleteLines(buf) {
  const last = buf.lastIndexOf(0x0a);
  if (last < 0) return { lines: [], consumed: 0 };
  return { lines: buf.subarray(0, last).toString('utf8').split('\n'), consumed: last + 1 };
}

function textOf(obj) {
  const c = obj.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.find((b) => b?.type === 'text')?.text ?? '';
  return '';
}

/**
 * @param {{root: string, windowMs: number, emit: (events: object[]) => void,
 *          log?: (msg: string) => void, now?: () => number, pollMs?: number,
 *          onCwd?: (sessionId: string, cwd: string) => void}} opts
 *   onCwd: called when a main session reports its working directory (case files are looked up from it)
 */
export function createTailer({ root, windowMs, emit, log = (m) => console.error(m), now = () => Date.now(), pollMs = 1000, onCwd }) {
  const files = new Map(); // path -> tracked file state
  const owners = new Map(); // parent tool_use id -> agentId that issued it (global: ids are unique)
  const sessions = new Map(); // sessionId -> {sessionId, project, lastT}
  const cwds = new Map(); // sessionId -> last reported cwd (main sessions only)
  const warned = new Set();
  let timer = null;
  let watcher = null;
  let debounce = null;
  let busy = false;
  let again = false;

  const warnOnce = (key, msg) => {
    if (warned.has(key)) return;
    warned.add(key);
    log(msg);
  };

  function touchSession(sessionId, project, t) {
    const s = sessions.get(sessionId) ?? { sessionId, project, lastT: 0 };
    if (t > s.lastT) s.lastT = t;
    sessions.set(sessionId, s);
  }

  async function track(file, info, cutoff) {
    if (files.has(file)) return;
    let st;
    try {
      st = await fsp.stat(file);
    } catch (err) {
      warnOnce(`stat:${file}`, `[hospital] stat ${file}: ${err.code ?? err.message}`);
      return;
    }
    if (st.mtimeMs < cutoff) return;
    files.set(file, { ...info, path: file, offset: 0, pending: Buffer.alloc(0), meta: null, spawned: false, mode: undefined, bad: 0 });
    touchSession(info.sessionId, info.project, 0);
  }

  async function discover() {
    const cutoff = now() - windowMs;
    const projects = await fsp.readdir(root, { withFileTypes: true }).catch((err) => {
      warnOnce(`root:${root}`, `[hospital] cannot read transcripts root ${root}: ${err.code ?? err.message}`);
      return [];
    });
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const pdir = path.join(root, p.name);
      const entries = await fsp.readdir(pdir, { withFileTypes: true }).catch((err) => {
        warnOnce(`dir:${pdir}`, `[hospital] cannot read ${pdir}: ${err.code ?? err.message}`);
        return [];
      });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          await track(path.join(pdir, e.name), { kind: 'main', sessionId: e.name.slice(0, -'.jsonl'.length), project: p.name }, cutoff);
        } else if (e.isDirectory()) {
          const sdir = path.join(pdir, e.name, 'subagents');
          const subs = await fsp.readdir(sdir, { withFileTypes: true }).catch((err) => {
            if (err.code !== 'ENOENT') warnOnce(`dir:${sdir}`, `[hospital] cannot read ${sdir}: ${err.code ?? err.message}`);
            return [];
          });
          for (const s of subs) {
            const m = SUB_RE.exec(s.name);
            if (m && s.isFile()) {
              await track(path.join(sdir, s.name), { kind: 'sub', sessionId: e.name, agentId: m[1], project: p.name }, cutoff);
            }
          }
        }
      }
    }
  }

  // Sidecar meta: null while absent (the child waits, nothing is consumed). Malformed -> unknown type, logged once.
  async function readMeta(subPath) {
    const metaPath = subPath.replace(/\.jsonl$/, '.meta.json');
    let text;
    try {
      text = await fsp.readFile(metaPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      warnOnce(`meta:${metaPath}`, `[hospital] malformed meta ${metaPath} (${text.length} chars); using agentType unknown`);
      return { agentType: 'unknown' };
    }
  }

  function processLine(f, raw, out) {
    let obj;
    try {
      obj = parseLine(raw);
    } catch (err) {
      f.bad += 1;
      if (f.bad <= 3) log(`[hospital] ${f.path}: ${err.message} (bad lines: ${f.bad})`);
      return;
    }
    // Metadata lines (mode, last-prompt, ai-title, permission-mode, ...) carry no timestamp and no events.
    if (!obj || (obj.type !== 'user' && obj.type !== 'assistant')) return;
    const ms = Date.parse(obj.timestamp);
    if (Number.isNaN(ms)) warnOnce(`ts:${f.path}`, `[hospital] ${f.path}: message line without a valid timestamp; using read time`);
    const t = Number.isNaN(ms) ? now() : ms;

    if (f.kind === 'sub' && f.mode === undefined && obj.type === 'user') {
      const prompt = textOf(obj);
      f.mode = modeOf(prompt) ?? null;
      f.specialty = f.mode === 'consult' ? specialtyOf(prompt) : null;
    }
    const subagentType = f.kind === 'main' ? 'conductor' : effectiveAgentType(f.meta);
    if (!f.spawned) {
      f.spawned = true;
      if (f.kind === 'main') {
        out.push({ t, kind: 'agent_spawn', sessionId: f.sessionId, agentId: f.sessionId, subagentType: 'conductor', description: 'Conductor', parentAgentId: null });
      } else {
        out.push(...spawnEvents({ sessionId: f.sessionId, agentId: f.agentId, meta: { ...f.meta, agentType: subagentType }, t, owners, mode: f.mode ?? undefined, specialty: f.specialty ?? null }));
      }
    }
    const ctx = {
      sessionId: f.sessionId,
      agentId: f.kind === 'main' ? f.sessionId : f.agentId,
      isMain: f.kind === 'main',
      owners,
      subagentType,
      mode: f.mode ?? undefined,
      now,
    };
    if (f.kind === 'main' && typeof obj.cwd === 'string' && cwds.get(f.sessionId) !== obj.cwd) {
      cwds.set(f.sessionId, obj.cwd);
      onCwd?.(f.sessionId, obj.cwd);
    }
    out.push(...normalizeLine(obj, ctx));
    touchSession(f.sessionId, f.project, t);
  }

  async function advance(f) {
    if (f.kind === 'sub' && !f.meta) {
      const meta = await readMeta(f.path);
      if (!meta) return;
      f.meta = meta;
    }
    const st = await fsp.stat(f.path);
    if (st.size < f.offset) {
      log(`[hospital] ${f.path} shrank (${f.offset} -> ${st.size} bytes); re-reading from 0`);
      f.offset = 0;
      f.pending = Buffer.alloc(0);
    }
    if (st.size === f.offset) return;
    const len = Math.min(CHUNK_BYTES, st.size - f.offset);
    const buf = Buffer.alloc(len);
    const fh = await fsp.open(f.path, 'r');
    let bytesRead;
    try {
      ({ bytesRead } = await fh.read(buf, 0, len, f.offset));
    } finally {
      await fh.close();
    }
    const data = Buffer.concat([f.pending, buf.subarray(0, bytesRead)]);
    const { lines, consumed } = takeCompleteLines(data);
    f.pending = Buffer.from(data.subarray(consumed));
    f.offset += bytesRead;
    const out = [];
    for (const raw of lines) processLine(f, raw, out);
    if (out.length) emit(out);
  }

  async function tick() {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      await discover();
      // Main sessions first, so tool_use owners exist before subagents look up their parent.
      const list = [...files.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1));
      for (const f of list) {
        try {
          await advance(f);
        } catch (err) {
          if (err.code === 'ENOENT') {
            files.delete(f.path);
            log(`[hospital] ${f.path} disappeared; stopped tracking it`);
          } else {
            warnOnce(`read:${f.path}:${err.code ?? err.message}`, `[hospital] tail ${f.path}: ${err.code ?? err.message}`);
          }
        }
      }
    } finally {
      busy = false;
    }
    if (again) {
      again = false;
      await tick();
    }
  }

  const run = () => tick().catch((err) => log(`[hospital] tick failed: ${err.stack || err.message}`));
  const scheduleRun = () => {
    clearTimeout(debounce);
    debounce = setTimeout(run, WATCH_DEBOUNCE_MS);
  };

  return {
    tick,
    start() {
      run();
      timer = setInterval(run, pollMs);
      timer.unref?.();
      try {
        watcher = fs.watch(root, { recursive: true }, scheduleRun);
        watcher.on('error', (err) => {
          log(`[hospital] fs.watch error, polling only: ${err.message}`);
          watcher?.close();
          watcher = null;
        });
      } catch (err) {
        log(`[hospital] fs.watch unavailable, polling only: ${err.message}`);
      }
    },
    stop() {
      clearInterval(timer);
      clearTimeout(debounce);
      watcher?.close();
    },
    sessions() {
      return [...sessions.values()].sort((a, b) => b.lastT - a.lastT);
    },
  };
}

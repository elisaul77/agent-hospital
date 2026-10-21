// Raw transcript line -> zero or more Event (schema in state.js header). Pure: no I/O, no clock reads
// except the explicit fallback. PRIVACY: forwards tool name, a <=60 char single-line label, ids,
// timestamps and verdict tokens. Never prompts, tool results, commands or handback bodies.
// Warning texts are the one exception: cut to 120 chars and sanitized by warnings.js.
import { warningsOf, rulingsOf } from './warnings.js';
import { createHash } from 'node:crypto';
import { approvalActionOf, approvalOfHandback, isBlockedHandback } from './escalation.js';
import { isConsult, specialtyToken } from './roles.js';

export const LABEL_MAX = 60;
export function opaqueToolId(raw) {
  return `claude-tool-${createHash('sha256').update(String(raw)).digest('hex').slice(0, 24)}`;
}
export const ownerKey = (sessionId, rawToolId) => `${sessionId}\0${rawToolId}`;
const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookRead', 'NotebookEdit']);
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

export function clip(s, n = LABEL_MAX) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

// One JSONL line. Blank -> null. Malformed -> throws (length only, never the content).
export function parseLine(text) {
  const s = String(text).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`malformed transcript line (${s.length} chars)`);
  }
}

function tailPath(p) {
  if (typeof p !== 'string' || !p) return '';
  return clip(p.split(/[\\/]/).filter(Boolean).slice(-2).join('/'));
}

function hostOf(u) {
  try {
    return clip(new URL(String(u)).host);
  } catch {
    return '';
  }
}

// Label shown next to a tool. Free-form descriptions and search patterns stay private.
export function labelOf(tool, input) {
  const inp = input && typeof input === 'object' ? input : {};
  if (PATH_TOOLS.has(tool)) return tailPath(inp.file_path ?? inp.notebook_path);
  if (tool === 'Grep' || tool === 'Glob' || tool === 'Bash' || SPAWN_TOOLS.has(tool)) return '';
  if (tool === 'SendMessage') return clip(inp.to);
  if (tool === 'WebFetch') return hostOf(inp.url);
  return '';
}

// Codex prompt prefix `mode=implement|review` (first 200 chars only, anchored at the start).
// Real prompts vary in case ("Mode=", "mode=") and sometimes use ":"; any other mode is not a review/implement.
export function modeOf(prompt) {
  const m = /^\s*mode\s*[=:]\s*(implement|review|consult)\b/i.exec(String(prompt ?? '').slice(0, 200));
  return m ? m[1].toLowerCase() : undefined;
}

// Consult specialty (`mode=consult specialty=x`, first 200 chars). Token only, validated; anything else is null.
const CONSULT_SPECIALTY_RE = /^\s*mode\s*[=:]\s*consult\b[^\n]*?\bspecialty\s*[=:]\s*([A-Za-z0-9_-]+)/i;
export function specialtyOf(prompt) {
  const m = CONSULT_SPECIALTY_RE.exec(String(prompt ?? '').slice(0, 200));
  return m ? specialtyToken(m[1]) : null;
}

// A consult is never a reviewer, even though it is a review-agent.
export function isReviewer(subagentType, mode) {
  if (isConsult(subagentType, mode)) return false;
  return subagentType === 'review-agent' || (subagentType === 'codex-agent' && mode === 'review');
}

export function isImplementer(subagentType, mode) {
  return subagentType === 'implement-agent' || (subagentType === 'codex-agent' && mode === 'implement');
}

// Phase 5a: STATUS token and FILES_CHANGED presence of a handback (tokens only, never the text).
// filesChanged: true when a file is listed, false for none/empty, null when the header is absent.
const HEADER_RE = /^[A-Z][A-Z_]+:/;
// Lines under a header: the inline value first, then the lines until the next header.
function sectionOf(lines, i) {
  const out = [lines[i].slice(lines[i].indexOf(':') + 1).trim()];
  for (let k = i + 1; k < lines.length && !HEADER_RE.test(lines[k]); k++) out.push(lines[k].trim());
  return out.filter(Boolean);
}
export function progressOf(message) {
  const lines = String(message ?? '').split(/\r?\n/);
  const st = /^STATUS:\s*(DONE|PARTIAL|BLOCKED)\b/m.exec(String(message ?? ''));
  const i = lines.findIndex((l) => l.startsWith('FILES_CHANGED:'));
  let filesChanged = null;
  if (i >= 0) {
    const body = sectionOf(lines, i).filter((l) => !/^\(?none\b/i.test(l));
    filesChanged = body.length > 0;
  }
  return { status: st ? st[1] : null, filesChanged };
}

// Phase 5a: REQUIRED_CHANGES of a reviewer handback -> a short hash of its normalised text (null for none/absent).
// The hash lets the reducer see "the same text twice" without keeping the text.
export function requiredHashOf(message) {
  const lines = String(message ?? '').split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('REQUIRED_CHANGES:'));
  if (i < 0) return null;
  const text = sectionOf(lines, i).join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text || /^\(?none\.?\)?$/.test(text)) return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// SubagentHandback body -> verdict token. Only reviewers carry verdicts. Unknown words -> null.
export function verdictOf(message, subagentType, mode) {
  if (!isReviewer(subagentType, mode)) return null;
  const text = String(message ?? '');
  const st = /^STATUS:\s*(APPROVED|NEEDS_REVISION|FAILED)\b/m.exec(text);
  if (!st) return null;
  const og = /^FAILURE_ORIGIN:\s*([a-z_]+)/m.exec(text);
  return { verdict: st[1], failureOrigin: og && og[1] !== 'none' ? og[1] : null };
}

// Events for a subagent's meta sidecar. `owners` maps a parent tool_use id to the agent that issued it.
export function spawnEvents({ sessionId, agentId, meta, t, owners, mode, specialty = null }) {
  const rawToolUseId = typeof meta?.toolUseId === 'string' && meta.toolUseId ? meta.toolUseId : null;
  const parentAgentId = (rawToolUseId && owners?.get(ownerKey(sessionId, rawToolUseId))) || sessionId;
  const toolUseId = rawToolUseId ? opaqueToolId(rawToolUseId) : null;
  const evs = [{
    t, kind: 'agent_spawn', sessionId, agentId,
    subagentType: clip(meta?.agentType ?? 'unknown', 60), description: '',
    parentAgentId, mode, specialty,
  }];
  if (toolUseId) evs.push({ t, kind: 'agent_link', sessionId, agentId, toolUseId });
  return evs;
}

/**
 * @param {object} obj parsed transcript line
 * @param {{sessionId: string, agentId: string, isMain?: boolean, owners: Map<string,string>,
 *          subagentType?: string, mode?: string, now?: () => number}} ctx
 * @returns {object[]} events (may be empty)
 */
export function normalizeLine(obj, ctx) {
  if (!obj || typeof obj !== 'object') return [];
  const ms = Date.parse(obj.timestamp);
  const t = Number.isNaN(ms) ? (ctx.now ?? Date.now)() : ms;
  const base = { t, sessionId: ctx.sessionId, agentId: ctx.agentId };
  const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
  const out = [];

  if (obj.type === 'assistant') {
    for (const b of blocks) {
      if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue;
      const name = String(b.name ?? '');
      if (name === 'SubagentHandback') {
        const msg = b.input?.message;
        // Warnings first, so the reducer has the gate state before it applies this agent's verdict.
        if (isReviewer(ctx.subagentType, ctx.mode)) {
          for (const r of rulingsOf(msg)) {
            out.push({ ...base, kind: 'warning_ruling', index: r.index, label: r.label, ruling: r.ruling });
          }
        } else if (isImplementer(ctx.subagentType, ctx.mode)) {
          const { items } = warningsOf(msg);
          if (items.length) out.push({ ...base, kind: 'warning_open', items });
        }
        // A consult never rings the bell: its handback carries no verdict, no block and no approval.
        if (isConsult(ctx.subagentType, ctx.mode)) {
          out.push({ ...base, kind: 'agent_done' });
          continue;
        }
        // BLOCKED that needs the user's go-ahead (merge/push/deploy/...) goes to the Direction room, not a plain block.
        const approval = approvalOfHandback(msg);
        if (approval) out.push({ t, sessionId: ctx.sessionId, kind: 'approval_pending', agentId: ctx.agentId, action: approval });
        const v = verdictOf(msg, ctx.subagentType, ctx.mode);
        const blocked = isBlockedHandback(msg) && !approval ? { blocked: true } : {};
        // Phase 5a: tokens and hashes for the escalation rules (never the text).
        const reviewHash = isReviewer(ctx.subagentType, ctx.mode) ? { requiredHash: requiredHashOf(msg) } : {};
        out.push({ ...base, kind: 'agent_done', ...(v ?? {}), ...blocked, ...progressOf(msg), ...reviewHash });
        continue;
      }
      if (name === 'Skill' && typeof b.input?.skill === 'string') {
        if (b.input.skill === 'subagent-pool') out.push({ t, kind: 'workflow_confirmed', sessionId: ctx.sessionId, workflow: 'subagent-pool', runtime: 'claude', reason: 'skill_invocation' });
        else out.push({ t, kind: 'workflow_observed', sessionId: ctx.sessionId, workflow: 'other', runtime: 'claude', reason: 'other_skill_invocation' });
      }
      if (SPAWN_TOOLS.has(name) && ctx.owners) ctx.owners.set(ownerKey(ctx.sessionId, b.id), ctx.agentId);
      if (name === 'Bash') {
        const action = approvalActionOf(b.input?.command);
        if (action && !isConsult(ctx.subagentType, ctx.mode)) {
          // The issuing agent is the delegate that holds at the Direction door (reducer). The Conductor is never
          // drawn executing git: its approval rings Direction, and its Bash call draws no tool.
          out.push({ t, sessionId: ctx.sessionId, kind: 'approval_pending', agentId: ctx.agentId, action });
          if (ctx.isMain) continue;
        }
      }
      out.push({ ...base, kind: 'tool_start', tool: clip(name, 40), label: labelOf(name, b.input), toolUseId: opaqueToolId(b.id) });
      if (name === 'SendMessage') {
        const to = b.input?.to;
        if (typeof to === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(to))
          out.push({ t, sessionId: ctx.sessionId, kind: 'message_send', from: ctx.agentId,
            to: to.startsWith('claude-') ? to : `claude-${to}` });
      }
    }
    // Main session only: a turn that ends with a question and no tool call waits for the user.
    if (ctx.isMain && !blocks.some((b) => b?.type === 'tool_use')) {
      const text = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n').trimEnd();
      if (text.endsWith('?')) out.push({ t, sessionId: ctx.sessionId, kind: 'question' });
    }
  } else if (obj.type === 'user') {
    for (const b of blocks) {
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        out.push({ ...base, kind: 'tool_end', toolUseId: opaqueToolId(b.tool_use_id) });
      }
    }
    // A typed message from the user (not a tool result, not a <tag> injection) answers the bell.
    const typed = typeof obj.message?.content === 'string'
      ? obj.message.content
      : (blocks.some((b) => b?.type === 'tool_result') ? '' : blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(''));
    if (ctx.isMain && typeof typed === 'string' && typed.trim() && !typed.trimStart().startsWith('<')) {
      out.push({ t, sessionId: ctx.sessionId, kind: 'user_message' });
    }
  }
  return out;
}

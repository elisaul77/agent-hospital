// Presentation policy only. Workflow evidence belongs to the server; a missing record stays unknown.
import { ROOMS } from './map.js';

const ALL = ROOMS.map((room) => room.id);
const ORDINARY_ROOMS = new Set(['architect', 'diagnosis', 'specialists', 'operating', 'radiology']);

export function activeAgent(agent) {
  return Boolean(agent) && (agent.leaving === true || (!agent.sleeping && !['handback', 'done', 'finished', 'idle'].includes(agent.status)));
}

export function roomForAgent(agent, workflow) {
  if (workflow === 'subagent-pool') return ALL.includes(agent.room) ? agent.room : 'specialists';
  return ORDINARY_ROOMS.has(agent.room) ? agent.room : 'specialists';
}

export function visibleRooms(view, session = null, { demo = false } = {}) {
  if (demo) return new Set(ALL);
  const workflows = view.workflows ?? {};
  const sessions = session ? [session] : [
    ...new Set([...Object.keys(workflows), ...Object.values(view.agents ?? {}).map((a) => a.sessionId).filter(Boolean)]),
  ];
  if (sessions.some((id) => workflows[id]?.workflow === 'subagent-pool')) return new Set(ALL);
  const rooms = new Set(['specialists']);
  for (const agent of Object.values(view.agents ?? {})) {
    if (!sessions.includes(agent.sessionId) || !activeAgent(agent)) continue;
    rooms.add(roomForAgent(agent, workflows[agent.sessionId]?.workflow));
  }
  return rooms;
}

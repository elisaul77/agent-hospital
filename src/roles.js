// subagent_type -> role + room. Pure data; shared by the reducer (server) and labels for the HUD.
// Unknown types (general-purpose, Explore, fork, anything new) go to the Specialist pool.

export const ROLE_LABELS = {
  conductor: 'Conductor (recepción)',
  planning: 'Planificador',
  implement: 'Implementador',
  review: 'Revisor',
  codex: 'Codex',
  'council-spec': 'Consejo · spec',
  'council-architect': 'Consejo · architect',
  'council-lateral': 'Consejo · lateral',
  'council-risk': 'Consejo · risk',
  architect: 'Arquitecto',
  consultant: 'Especialista',
};

const ROLE_BY_TYPE = {
  conductor: 'conductor',
  'planning-agent': 'planning',
  'implement-agent': 'implement',
  'review-agent': 'review',
  'council-spec': 'council-spec',
  'council-architect': 'council-architect',
  'council-lateral': 'council-lateral',
  'council-risk': 'council-risk',
  // Team members named without the council- prefix (Council room, same seats).
  spec: 'council-spec',
  architect: 'council-architect',
  lateral: 'council-lateral',
  risk: 'council-risk',
  // Specialist pool members.
  alfa: 'consultant',
  beta: 'consultant',
  AgentArchitect: 'architect',
};

const ROOM_BY_ROLE = {
  conductor: 'reception',
  planning: 'diagnosis',
  implement: 'operating',
  review: 'radiology',
  'council-spec': 'council',
  'council-architect': 'council',
  'council-lateral': 'council',
  'council-risk': 'council',
  architect: 'architect',
  consultant: 'specialists',
  codex: 'specialists',
};

// Specialty desk token of a consult (`mode=consult specialty=x`). Lowercased, then this pattern; else no desk.
export const SPECIALTY_RE = /^[a-z][a-z0-9-]{0,23}$/;
export function specialtyToken(value) {
  const t = String(value ?? '').toLowerCase();
  return SPECIALTY_RE.test(t) ? t : null;
}

// A consult is the review-agent in consult mode: a specialist that never reviews, so it never moves a case.
export function isConsult(subagentType, mode) {
  return subagentType === 'review-agent' && mode === 'consult';
}

/**
 * @param {string} subagentType  meta.agentType / Agent input.subagent_type
 * @param {string} [mode]        codex-agent: 'implement' | 'review'; review-agent: 'consult' (from its prompt prefix)
 * @returns {{role: string, room: string}}
 */
// Council members spawned under a free name (spec5, architect5, council-lateral-<task>...) fall back to the name.
const COUNCIL_NAME_RE = /^(?:council-)?(spec|architect|lateral|risk)(?:[-\d].*)?$/;

export function roleOf(subagentType, mode, workflow = 'subagent-pool') {
  if (isConsult(subagentType, mode)) return { role: 'consultant', room: 'specialists' };
  // A name is not evidence that an ordinary skill convened the Council.
  if (workflow !== 'subagent-pool' && (subagentType === 'conductor' || subagentType === 'AgentArchitect' || ROLE_BY_TYPE[subagentType]?.startsWith('council-')
      || COUNCIL_NAME_RE.test(String(subagentType ?? '')))) {
    return { role: 'consultant', room: 'specialists' };
  }
  if (subagentType === 'codex-agent') {
    const room = mode === 'implement' ? 'operating' : mode === 'review' ? 'radiology' : 'specialists';
    return { role: 'codex', room };
  }
  let role = ROLE_BY_TYPE[subagentType];
  if (!role) {
    const m = COUNCIL_NAME_RE.exec(String(subagentType ?? ''));
    role = m ? `council-${m[1]}` : 'consultant';
  }
  return { role, room: ROOM_BY_ROLE[role] };
}

/**
 * Real subagent type of a spawned agent. The meta sidecar records it in customAgentType / spawnedAgentType
 * (e.g. council-architect for a teammate named architect5); it wins only when it is a known role type.
 * Otherwise the agentType (the spawn name) is kept.
 * @param {{agentType?: string, customAgentType?: string, spawnedAgentType?: string}} [meta]
 * @returns {string|undefined}
 */
export function effectiveAgentType(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  for (const real of [meta.customAgentType, meta.spawnedAgentType]) {
    if (typeof real === 'string' && Object.hasOwn(ROLE_BY_TYPE, real)) return real;
  }
  return meta.agentType;
}

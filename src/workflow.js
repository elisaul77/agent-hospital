// Workflow classification uses structured observations, never prompt text or agent names.
export const WORKFLOWS = new Set(['subagent-pool', 'other', 'unknown']);
export const RUNTIMES = new Set(['claude', 'codex']);
export const POOL_REASONS = new Set(['skill_invocation', 'matched_case_file']);

export function runtimeOf(value) {
  return RUNTIMES.has(value) ? value : 'claude';
}

/** Classify one bounded observation. The caller verifies case-file confinement and exact session binding. */
export function classifyWorkflow(observation = {}) {
  const runtime = runtimeOf(observation.runtime);
  const skill = observation.skill ?? observation.input?.skill;
  if (observation.tool === 'Skill' && typeof skill === 'string') {
    return skill === 'subagent-pool'
      ? { workflow: 'subagent-pool', runtime, reason: 'skill_invocation' }
      : { workflow: 'other', runtime, reason: 'other_skill_invocation' };
  }
  const file = observation.caseFile;
  if (file?.confined === true && file.active === true && file.poolHeaders === true && file.sessionBound === true
      && file.sessionId === observation.sessionId && typeof observation.sessionId === 'string'
      && observation.sessionId.length > 0 && Number.isFinite(file.modifiedAt)
      && Number.isFinite(observation.sessionStartedAt) && Number.isFinite(observation.observedAt)
      && file.modifiedAt >= observation.sessionStartedAt && file.modifiedAt <= observation.observedAt
      && observation.parentChild === true && observation.poolRoles === true && observation.handback === true) {
    return { workflow: 'subagent-pool', runtime, reason: 'matched_case_file' };
  }
  return { workflow: 'unknown', runtime, reason: 'insufficient_evidence' };
}

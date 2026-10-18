// Escalation bell (subagent-pool v9.12 human gates). Pure: no I/O, no clock. The reducer (state.js) decides when
// a reason fires; this module holds the labels and the trigger matchers. PRIVACY: triggers return only the
// action token (e.g. 'git merge'), never the command or the handback text.

export const ESCALATION_LABEL = {
  approve: 'aprobación de Dirección',
  blocked: 'agente bloqueado',
  failed: 'revisión FAILED',
  stall: 'agente detenido >2 min',
  ask_user: 'pregunta sin respuesta',
  exhausted: 'revisiones agotadas',
  unruled: 'sin dictamen (ACCEPTED_RISK o dictamen)',
};

// Git/registry/publish actions that need the user's go-ahead (Direction room). Lookahead keeps merge-base out.
const APPROVAL_RE = /\bgit\s+(merge|push)(?![\w-])|\bdocker\s+push\b|\bnpm\s+publish\b/;
const BLOCKED_RE = /^STATUS:\s*BLOCKED\b/m;
const BLOCKED_KEYWORD_RE = /\b(merge|push|deploy|publish|migration)\b/i;

/** Bash command -> approval action token, or null. The command itself is never returned. */
export function approvalActionOf(command) {
  const m = APPROVAL_RE.exec(String(command ?? ''));
  if (!m) return null;
  if (m[1]) return `git ${m[1]}`;
  return m[0].startsWith('docker') ? 'docker push' : 'npm publish';
}

export function isBlockedHandback(message) {
  return BLOCKED_RE.test(String(message ?? ''));
}

/** A BLOCKED handback that mentions merge/push/deploy/publish/migration needs the Direction room. */
export function approvalOfHandback(message) {
  const text = String(message ?? '');
  if (!isBlockedHandback(text)) return null;
  const m = BLOCKED_KEYWORD_RE.exec(text);
  return m ? m[1].toLowerCase() : null;
}

// Escalation bell helpers (pure: no DOM, imported by node:test too).
// The bell rings once per escalation id; ids seen at connect time are not rung (the stream replays state).

/** Escalations in `list` whose id is not yet in `seen`. */
export function freshEscalations(seen, list) {
  return (list ?? []).filter((e) => !seen.has(e.id));
}

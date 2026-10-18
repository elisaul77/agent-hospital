# Council brief — Phase 5b1: case-file viewer + Archive room

Task: define (plan only, no code) how the hospital lets the user open case files and finished plans. Output: plans/hospital-5b1-draft.md + plans/council/hospital-5b1/decisions.md (architect synthesizes).
Tier L · feature · council — user asked for a council. Risk HIGH axis: first feature that serves file contents from disk to the browser.
First move (feature): check what exists to reuse (src/casefile.js confinement, parseCaseFile/parseCaseProgress/loadPlanPhases, server static handler hardening, inspector UI in public/js/main.js).

## Project context
- <projects-root>/hospital-agentes — Node 22 stdlib server, SSE, Canvas client (user-approved Codex look). Plan: plans/hospital-plan.md. State: plans/hospital-state.md. 223/223 tests.
- Mounts :ro: ~/.claude/projects, <projects-root>, <ai-projects-root> (HOSPITAL_CASE_DIRS). Bound to 127.0.0.1:8700, no auth.
- Existing confinement (security-probed): realpath under roots, inside plans/, symlink-safe, 256 KB cap, only plans/*-state.md read today.
- An implementer was STOPPED before writing code (only read files). The prior brief it got proposed: opaque case id + server-listed allowlisted names; .md/.log/.png only; text/plain + nosniff rendered via textContent <pre>; images image/png; archive scan depth 3, ≤200 entries, cache 30 s.

## User decisions (invariants)
1. From the hospital the user can open, read-only: the case's state.md, its plan file, plans/council/<task>/decisions.md + debate.log, and screenshots in plans/shots/.
2. An Archive (the "Archivo del caso" room) lists ALL plans/*-state.md found, including STATUS: COMPLETE and old ones beyond the 6 h transcript window, and opens them in the viewer.
3. Read-only, localhost only, nothing served outside plans/. Untrusted text never becomes HTML.
4. Also in 5b1 (already decided, no debate needed): Conductor idle walk-out 30 min via env HOSPITAL_CONDUCTOR_IDLE_MIN; prune idle Conductors from reducer storage.

## Questions to settle
- Is the opaque-id + allowlist API the right shape, or something simpler/safer (e.g. no new endpoints at all; reuse an existing tool)? Any reason to not serve files and instead open them in the user's own editor/file manager?
- Markdown: plain text only, or a safe minimal render? Images: which types, size caps?
- Threats: DNS rebinding / other local web pages reading 127.0.0.1:8700 (no auth, CORS), path tricks, huge dirs, secrets inside plans/ (e.g. a debate.log quoting a token) — what to do.
- Archive scan cost and freshness; how an archived case relates to live cases (same patient model?).
- UI: where it lives in the map/HUD; how it looks in the Codex style; phone width.
- Tests and probes that prove it.

CODEX: off unless your protocol detects it. Members: spec, architect, lateral, risk.

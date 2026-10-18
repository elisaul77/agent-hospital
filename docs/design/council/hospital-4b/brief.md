# Council brief — Phase 4b: phases as patients + consult routing

Task: define (plan only, no code) how Phase 4b of the Agent Hospital works. Output: plans/hospital-4b-draft.md + plans/council/hospital-4b/decisions.md (architect synthesizes).
Tier L · tweak (case model changes) · council — user explicitly asked for the council to define it.
Operation first move (tweak): identify current behavior + tests that pin it (src/state.js case model, test/state.test.js, test/warnings.test.js) and plan their change in the same phase.

## Project context
- <projects-root>/hospital-agentes — Node 22 stdlib backend tails ~/.claude/projects jsonl (ro), SSE /events {events,state}, Canvas client (user-approved Codex look: public/js/scenery.js, sprites.js, render.js). Plan: plans/hospital-plan.md. State: plans/hospital-state.md.
- Phases 1, 2, 3, 3b approved (81 tests). Phase 4 is being implemented RIGHT NOW (case-file mounts :ro of <projects-root> and <ai-projects-root>, src/casefile.js wired, Direction room, bell, tubes, council room). Do NOT touch code; 4b starts after 4.
- Today: ONE case per session = one gurney (folder) walking the whole hospital; Conductor sits in Reception (one per session).
- Skill being visualized: ~/.claude/skills/subagent-pool/SKILL.md v9.12 (case file plans/{task}-state.md fields; consult = review-agent `mode=consult specialty=<x>` or planning-agent for code facts).

## User decisions (invariants)
1. Each item/phase of a plan is a PATIENT. Pending phases wait (waiting room / reception area); current phase is in surgery/review; approved phases discharged; NEEDS_REVISION returns that phase to surgery.
2. Reception stays the Conductor's desk (escalations, user talk).
3. The expediente (case) = the whole plan (triage line, warnings, accepted risks).
4. Consults (review-agent mode=consult specialty=X) must appear in the Specialist pool at the desk of that specialty, not Radiology. Only the prefix/specialty is read; prompts are never shown.
5. Visual style = approved Codex look. Labels never leak prompts/commands; textContent only; no new runtime deps; demo mode must show it.

## Questions to settle
- Source of truth for the phase list: plan headings (`## Phase N`), state.md (`Completed phases`, `Current`), or transcript events (which phase a subagent works on — how to link an implement/review agent to phase N?). Plans without phases (tier S, no state.md)?
- Multiple concurrent plans/sessions: how many patients on screen, where they wait, overflow.
- Mapping verdicts/warnings (per phase vs per case) without breaking the Phase 3 gate invariant.
- Waiting room placement in the current map; patient look (wristband label), sub-phases like 3b.
- Tests that must change and how to prove it.

CODEX: off (quota exhausted until 12:26 PM). Members: spec, architect, lateral, risk.

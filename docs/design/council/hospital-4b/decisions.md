# Decisions — hospital-4b

| # | Decision | Chosen | Rejected (by whom proposed) | Why | Open? |
|---|---|---|---|---|---|
| 1 | Phase list source | Plan-file headings, `^## Phase (\d+[a-z]?)\b`, fallback to `### Phase` only if zero `##` match; fenced ignored; dedupe by id (first wins); parse cap 24; title clip 40 | `^#{2,3}` at once (architect/spec R1: nested `###` would double patients); ignore list on duplicates (risk) | Real plans repeat "Phase 1" in summaries; hospital-plan.md uses `###` | no |
| 2 | Delivery | `phases[]` inside the existing `triage` event; cache key state mtime + plan mtime | New `plan_phases` event + second watcher (architect) | One read path, fewer parts (lateral) | no |
| 3 | Patient status | Pure derived array `case.phases[{id,title,state}]` (done/current/waiting) from phasesDone, status, room, held; reducer gate untouched | Client-only ghosts from `{phasesDone,phasesTotal}` (lateral) | Needs NEEDS_REVISION=current in surgery and a test seam (spec) | no |
| 4 | Link agent to phase | None; current = phasesDone+1 | Prompt/description parsing (risk R2, architect); explicit tag in dispatch prompts (lateral second voice: skill change out of scope, memory forbids reactive skill edits) | Fragile, leaks prompts | no |
| 5 | Parallel phases ("Current is a set") | Not supported; single current patient (cosmetic failure only) | Set of current phases (lateral second voice) | Conductor loop is serial; gate is case-level | no |
| 6 | Wristband "x/N" | Shown when phases non-empty; none when phases=[] | Fake phase for no-plan cases (architect R1) | Spec crit. 7 | no |
| 7 | No plan / zero headings / unreadable | phases=[], one synthetic "Case" patient, today's view | Guess from Completed phases | Zero regression | no |
| 8 | Caps | Parse 24; draw 6 waiting + "+N" (Reception), 4 discharged + "+N" (Discharge room); current always drawn | 8 (spec), 12 (risk), rack of 8 (lateral) | One set of numbers | no |
| 9 | Drift wristband / reading `Completed phases` | Dropped in 4b | phasesDrift "?" (architect), cross-check (lateral) | No criterion; widens scope | no |
| 10 | Restart / transcript window | phasesDone may undercount after restart (tail.js windowed discovery); documented limit; test first APPROVED outside window does not throw; final discharge marks all remaining discharged | Drift flag | Out of scope | Accepted limit |
| 11 | Consult detection | `mode=consult specialty=<token>` from first 200 chars; lowercase then `^[a-z][a-z0-9-]{0,23}$`; invalid/missing = generic specialist desk | Whitelist else "general" (lateral) | Loses new specialties (invariant: desk of THAT specialty) | no |
| 12 | Consult isolation | consult:true, reviewer:false in normalize.js (isReviewer/verdictOf/rulingsOf) AND state.js; no closePhase/loopBack/leaveUnruled, no bell, no room move, case deepEqual | "state.js: no change" (lateral) | Consult is a review-agent, so it is a reviewer today | no |
| 13 | Plan path | basename inside confined plans dir, no `..`/absolute/symlink escape, 256 KB cap | Open `planFile` directly | Header text is untrusted | no |
| 14 | Per-phase fuzz "discharged k implies no blocking warning phase<=k" | Replaced by purity test of derive + unchanged gate tests | Risk R1 fuzz | Gate is case-level | no |
| 15 | Waiting-room place | Reception lower band as small wristband chips | Counter rack (lateral) | Same cap, chips match spec | no |
| 16 | Demo | Every status plus one consult at a specialty desk | none | Spec crit. 11 | no |

## Consistency pass
No crossed acceptances. Heading regex was stated three ways (`#{2,3}`, `##`, `##`+fallback); settled as row 1. Caps stated four ways; settled as row 8.

## Open disagreements
none

## Override 2026-10-18
- Row 9 overridden by the user: user chose options a+d. phasesDone = max(transcript count, state.md count from `Completed phases:`/`Phase N APPROVED`/last `Current:` mapped to plan ids); terminal `STATUS: COMPLETE` (case-insensitive) = all patients done (view only).

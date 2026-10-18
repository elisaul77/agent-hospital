# Council brief — Phase 5c: open decisions + activity column + two-step council

Task: give the user a recommendation (plan only, no code) on three open decisions and design Phase 5c. Output: plans/hospital-5c-draft.md + plans/council/hospital-5c/decisions.md (architect synthesizes). Each open decision must end with ONE recommended option, its reason, and what would change the call.
Tier L · feature · council — user asked for the council's opinion.

## Project context
- <projects-root>/hospital-agentes — Node 22 stdlib server, SSE /events, Canvas client (user-approved Codex look). State: plans/hospital-state.md. 321/321 tests. Redeployed on 127.0.0.1:8700 (demo default, ?mode=live).
- Read-only mounts: ~/.claude/projects, <projects-root>, <ai-projects-root>. Host guard (loopback or HOSPITAL_ALLOWED_HOSTS → else 421), Origin/Sec-Fetch-Site 403, archive viewer /api/archive + /api/doc with best-effort redaction (src/archive.js REDACTION_RULES).
- Privacy today: labels only — tool name + short label (Bash shows description, never command), no prompts, no tool results, no user text. See src/normalize.js labelOf.
- Council members spawn as named teammates; .meta.json has customAgentType council-*; rounds: R1 blind draft file plans/council/<task>/<member>.md + "R1 done" SendMessage to main; R2a/R2b objections/replies via SendMessage between members (debate.log); R3 architect writes <task>-draft.md + decisions.md. Today all four sit in the Council room the whole time.

## Open decisions (recommend one each)
1. Redaction false positive: the key=value rule redacts placeholders like `api_key = value`. Options: (a) skip bare-word placeholders (value, null, none, x…) and anything in backticks or <…> (reviewer's pick; (b) would let short real passwords like hunter2 through); (b) require a digit or 8+ mixed chars; (c) accept.
2. Phone access: compose publishes 127.0.0.1:8700 only. Options: keep loopback; also publish on LAN <lan-ip>; on WireGuard <wg-ip> only; both — with HOSPITAL_ALLOWED_HOSTS. Consider: no auth, case files readable, LAN devices (guests, other devices on the network).
3. Activity column level (new feature: click a character → right-side column like a thought cloud with its activity): (a) tool + label + time as today; (b) plus the assistant's text between tools, redacted; (c) everything incl. commands and tool results.

## Phase 5c features to design (user ideas)
- Click on a character → right-side column ("thought cloud") with that agent's activity timeline; live updates; close; phone layout.
- Council in two steps: during R1 each member sits at a desk in the Specialist pool writing (pen animation); when its R1 draft is done a ✓ appears, it stands up and walks to the Council room to wait; R2 debate + R3 synthesis happen at the Council table (SendMessage capsules between members); after the architect's final return they leave. Detection from tokens only (file paths under plans/council/<task>/, "R1 done"/"R2a"/"R2b"/"R3" message prefixes), never content.

CODEX: off unless your protocol detects it. Members: council-spec-5c, council-architect-5c, council-lateral-5c, council-risk-5c.

# Plan: Agent Hospital (hospital-agentes)

**Operation:** feature (greenfield). **Port:** 8700 (`ss -ltn` on 2026-10-18: 8680, 8683, 8710 taken; 8700 free).
**Graphify:** skipped (empty project, nothing to graph). **Instructions found:** ~/AGENTS.md and ~/.claude/CLAUDE.md (global): Docker for everything, Flatpak Chrome for screenshots, UI/prose in user's language where relevant. No project-level AGENTS.md.

**TL;DR:** Node 22 (zero npm deps) tails `~/.claude/projects/**/*.jsonl` (read-only mount), normalizes to events, runs a per-agent state machine plus a per-case "patient" machine on the server, pushes snapshots/deltas over SSE; a vanilla Canvas 2D frontend draws a top-down pixel hospital with procedural sprites. Demo mode (synthetic scripted stream) ships in Phase 1 so the app is visible without live sessions.

## Transcript layout (verified on disk)

Root: `~/.claude/projects/<project-id>/` (e.g. `-home-<user>`).

| Item | Path / field | Example |
|---|---|---|
| Main session | `<project-id>/<sessionId>.jsonl` | `5106a33d-e1ad-4c6c-95f4-cdbda297725b.jsonl` |
| Subagent transcript | `<project-id>/<sessionId>/subagents/agent-<agentId>.jsonl` | `agent-a4158cb06e99f0bdb.jsonl` |
| Subagent meta (sidecar) | `.../subagents/agent-<agentId>.meta.json` | keys: `agentType`, `description`, `toolUseId`, `spawnDepth`, `requestShape`, `finished` |
| agent type (child) | `meta.agentType` | `"review-agent"` (also `attributionAgent` on child assistant lines) |
| parent link | `meta.toolUseId` = tool_use id of the Agent call in the parent file | `toolu_01DXsy2s...` |
| parent spawn call | parent line `type=assistant`, `message.content[]` block `{type:"tool_use", name:"Agent"\|"Task", id, input:{description, subagent_type, prompt}}` | `subagent_type:"planning-agent"` |
| async launch ack | parent `type=user` line, `toolUseResult:{isAsync:true,status:"async_launched",agentId,description,outputFile}` | `agentId:"ae9d5b4e2559a9a68"` links tool_use id (via `message.content[].tool_use_id`) to child agentId |
| completion (async) | parent line containing `<task-notification>` with `<tool-use-id>`, `<status>completed</status>` | status text inside a user/attachment line |
| child line fields | `isSidechain:true, agentId, sessionId, parentUuid, uuid, timestamp (ISO Z), type` | `timestamp:"2026-10-18T11:46:53.250Z"` |
| tool use | assistant line `message.content[]` `{type:"tool_use", name, id, input}` | `name:"Bash"`, `input.command` |
| tool result | user line `message.content[]` `{type:"tool_result", tool_use_id}` plus top-level `toolUseResult` | result `tool_use_id` matches the use id |
| agent finished | child calls tool `SubagentHandback` (last meaningful tool_use) and `meta.finished:true` | `SubagentHandback` at 11:47:40Z |
| noise line types | `attachment`, `api-request`, `api-request-blob`, `api-request-shape`, `queue-operation`-like | must be ignored; huge, never forward |
| Observed subagent_type counts (one project) | implement-agent 354, review-agent 296, planning-agent 75, codex-agent 69, fork 56, general-purpose 33, council-spec/architect/lateral/risk 6 each | |
| Case file | `<project>/plans/*-state.md`; line 1 `STATUS: IN_PROGRESS`, `Plan file: plans/x-plan.md`, `Tier L · feature` | in `<projects-root>/<other-project>/plans/anatomy-ideas-state.md` |
| Verdict text | inside child final `SubagentHandback.input.message`: `APPROVED / NEEDS_REVISION / FAILED`, `FAILURE_ORIGIN` | regex on text |

Caveats: tool inputs and prompts contain user content; the server must forward only `{name, short label ≤60 chars}`, never prompts/results. Case-file path comes from `cwd` on the lines (`cwd` field present) -> readable only if that project dir is also mounted (see MISSING).

## Reference research (all MIT; concepts only, no code copied)

| Repo | License | Worth reusing | Skip |
|---|---|---|---|
| pablodelucca/pixel-agents | MIT | Session = character, Task subagents = separate linked characters; heuristic transcript mode normalizing to a shared `AgentEvent`; walking to desks with pathfinding on a tile grid; furniture manifest (sprite, rotation, state groups, frames); speech bubbles for waiting/permission; JSON layout import/export | VS Code webview shell, full layout editor (post v1) |
| YehudaLevi/pixelagents | MIT | Tool-to-animation table (Read/Grep/Glob reading; Bash command; Edit/Write editing; WebSearch/WebFetch web; SubagentStart minions; idle > 5 min sleeping; turn end confetti); SSE push to a plain canvas page; zero runtime deps; generic `source` field on events | Hook-based event capture (we are read-only on transcripts; hooks would need writes to settings) |
| IvanWng97/pixtuoid | MIT | Single event channel feeding a pure reducer into state, renderer has no knowledge of sources; A* routed walking; per-agent look derived from stable data (hash of cwd/agentId) so looks persist; monitor glow colored by active tool | Rust/terminal half-block rendering |

Decision: parser -> `Event` -> pure reducer (pixtuoid) ; tool->animation table (pixelagents) ; tile-grid A* + furniture-as-data (pixel-agents).

## Avoiding the predictable: visual concept "The Night Ward with Pneumatic Tubes"

Predictable: white hospital, blue scrubs, beds, red crosses. Instead:
- **Palette:** dim night-shift clinic, 16-color fixed palette (dark teal floor, amber lamps, one accent per room). Each room has its own colored floor tile pattern and a light pool, so rooms read at a glance without labels.
- **The patient is a case-file gurney, not a person:** a rolling cart carrying a thick folder; folder thickness = number of phases done, tag color = Tier (S/M/L), lamp on cart = state (green discharge-ready, red FAILED). Agents push it room to room (the case "moves" only on a transition).
- **Roles by silhouette/headgear, not by color of scrubs** (readable at 12x16 px): planning = clipboard + round glasses; implement = surgical cap + mask + small tool arm; review = lead apron + light-box film; codex-agent = same role silhouettes but with a teal halo ring (provider marker); council-* = four robed figures with distinct hats around a round table (spec: scroll, architect: compass, lateral: tilted hat, risk: hazard lamp); AgentArchitect = drafting table + oversized blueprint roll; general-purpose/Explore/fork = unlicensed "visiting" trainee with lanyard; Conductor = night-shift charge nurse at reception with a headset.
- **Tools are equipment, not icons floating over heads:** Read = light-box film glows; Grep/Glob = microscope; Bash = defibrillator paddles with spark pixels; Edit/Write = scalpel + stitching animation on the folder; WebSearch/WebFetch = rooftop radio dish rotating; Task/Agent = pager buzz and a new character is "paged in" through the door; SendMessage = **pneumatic tube capsule** that visibly flies along ceiling tubes drawn between rooms (the tube network is the map's backbone and shows who talks to whom); SubagentHandback = capsule drops into the discharge chute at the room's door and the character walks out.
- **Time as light:** idle agents dim their desk lamp; > 5 min no events -> sleeping with a "zz" in the corridor chairs.
- Sprites generated procedurally in code (small bitmap templates per role + per-agent hue/hair derived from hash of agentId); all original, no Habbo assets.

## Room map (top-down tile grid 48x30 tiles, 16 px tiles, scale x3 integer)

```
+----------+----------+-----------+-------------+
| RECEPTION| TRIAGE   | CASE FILE | AGENT-      |
| Conductor| main/tech| archive   | ARCHITECT   |
| + User   | /risk    | state.md  | office      |
+----+-----+----+-----+-----+-----+------+------+
     |  (corridor with chairs + tube junctions)     |
+----+-----+----+-----+-----+-----+------+------+
| DIAGNOSIS| SPECIALIST POOL      | COUNCIL      |
| planning | arch|sec|data|ui|perf| boardroom    |
| + tools  | |infra (consult hub) | round table  |
+----------+----------+-----------+------+-------+
| OPERATING ROOM      | RADIOLOGY/ | DISCHARGE | STOPPED |
| implement, codex-im | REVIEW     | (Alta)    | CASE    |
+---------------------+------------+-----------+---------+
```
Each room = rect + door tiles + named "seats" (desk anchors). Defined as data in `public/js/map.js` (JSON-like), A* over walkable tiles, doors as waypoints.

Agent -> room mapping (reducer rules): Conductor (main session) -> Reception; `planning-agent` -> Diagnosis; consulting specialists / `general-purpose`/`Explore`/unknown types -> Specialist pool; `council-*` -> Council; `implement-agent` and `codex-agent` doing implement -> Operating; `review-agent` and `codex-agent` doing review -> Radiology; `AgentArchitect` -> its office. codex-agent mode is detected from its prompt prefix `mode=...` (server extracts only the mode token). Case ("patient") room is derived from the latest agent activity per case (see state machine) with transitions from the brief (review FAILED + FAILURE_ORIGIN=implementation -> back to Operating; =hypothesis -> Diagnosis; =scope -> Triage; APPROVED on last phase -> Discharge; stalled/exhausted -> Reception then Stopped).

## Event model

1. **Source layer** (`src/tail.js`): scan dirs, `fs.watch` + 1 s poll fallback (watch is unreliable on bind mounts), byte-offset tailing per file, partial-line buffering, never writes. New `.meta.json` read once (and re-read until `finished`).
2. **Normalizer** (`src/normalize.js`): raw line -> zero or more `Event` (drops noise types). Shape:
   `{t, sessionId, agentId|'main', kind, ...}` with kinds: `agent_spawn {parentToolUseId, subagentType, description, parentAgentId}`, `agent_link {toolUseId, agentId}`, `tool_start {tool, label, toolUseId}`, `tool_end {toolUseId}`, `message_send {from, to?}` (SendMessage), `agent_done {verdict?, failureOrigin?}`, `triage {tier, kind}`, `case_status {file, status}`, `idle_tick`.
3. **Reducer** (`src/state.js`, pure): `reduce(state, event) -> state` plus `derive(state, now)`.
   Agent machine: `spawned -> walking(to room seat) -> working(tool) <-> thinking(no tool) -> waiting(on user/tool result) -> handback -> leaving -> gone`; `sleeping` after 5 min without events; `stalled` visual if tool_start has no tool_end > 120 s.
   Case machine: `request -> reception -> triage -> diagnosis -> (consult|council)* -> plan -> operating -> review -> (operating | diagnosis | triage | discharge | escalated -> reception -> triage | stopped)`, driven by agent type + verdict + `case_status`.
4. **Transport** (`src/server.js`): `GET /events` SSE (`snapshot` on connect, then `delta`), `GET /api/state`, `GET /api/health`, static files. `?mode=demo|live`.
5. **Client** (`public/js/*`): applies snapshot/delta to a mirror state; render loop (requestAnimationFrame) interpolates walking along A* paths, picks animation from `(role, tool)` table, draws speech bubbles and capsule flights.

Tool -> equipment table (Phase 3): Read/NotebookRead -> lightbox; Grep/Glob -> microscope; Bash -> defib sparks; Edit/Write/MultiEdit -> scalpel+stitch; WebSearch/WebFetch -> radio dish; Task/Agent -> pager; SendMessage -> tube capsule; mcp__* -> generic console; unknown -> generic working.

## Stack and file list

Stack: Node 22 (alpine) stdlib only (http, fs, readline), ES modules, vanilla Canvas 2D, `node:test`. Docker compose, `~/.claude/projects` mounted `:ro`, user `1000:1000`. Rejected: React/Phaser (deps, build step, brief says minimal); WebSocket (SSE is enough, one-way, no lib); chokidar (poll+fs.watch is enough).

All paths under <projects-root>/hospital-agentes/ (verified: directory empty except plans/, so all ⊕create):

| Path | Purpose |
|---|---|
| ⊕create Dockerfile | node:22-alpine, copy src+public |
| ⊕create docker-compose.yml | port 8700:8700, `~/.claude/projects:/data/projects:ro`, env HOSPITAL_MODE |
| ⊕create package.json | scripts only, no deps |
| ⊕create .dockerignore, .gitignore | |
| ⊕create README.md, CHANGELOG.md | |
| ⊕create src/server.js | http + SSE + static |
| ⊕create src/tail.js | file discovery + offset tailing |
| ⊕create src/normalize.js | line -> events |
| ⊕create src/state.js | reducer + derive |
| ⊕create src/roles.js | subagent_type -> role/room/appearance table |
| ⊕create src/demo.js | scripted synthetic stream |
| ⊕create src/casefile.js | parse `plans/*-state.md` header (STATUS, Tier, Plan file) |
| ⊕create public/index.html | canvas + HUD |
| ⊕create public/js/main.js, net.js, map.js, path.js, sprites.js, render.js, anim.js, hud.js | client modules |
| ⊕create test/normalize.test.js, state.test.js, path.test.js, casefile.test.js | node:test |
| ⊕create test/fixtures/*.jsonl | tiny SANITIZED synthetic transcripts mirroring the verified shape (no real content) |
| ⊕create scripts/shot.sh | Flatpak Chrome headless screenshot |
| ⊕create docs/screenshots/ | evidence |

## Phases

### Phase 1: Visible app in Docker, demo mode
- **Rationale:** functional first; user must see the hospital moving before any parser exists.
- **Contracts:** server serves `/` and `/events`; demo emits events of the same `Event` schema the live path will use (so Phase 2 swaps only the source); client never reads demo-specific fields; no write access to anything outside container.
- **Files:** Dockerfile, docker-compose.yml, package.json, src/server.js, src/demo.js, src/state.js (minimal), src/roles.js, public/index.html, public/js/{main,net,map,path,sprites,render}.js (all ⊕create).
- **Steps:** static room map drawn (floors, walls, doors, labels); A* walking; procedural sprites for Conductor + 5 roles; demo script runs one full case (reception -> triage -> diagnosis -> operating -> review FAILED -> operating -> review APPROVED -> discharge); case gurney moves; bubble text shows tool name.
- **Tests:** `test/path.test.js` (A* reaches every seat from reception).
- **Verify with:** `docker compose up -d --build && curl -sf localhost:8700/api/health && curl -sN --max-time 3 localhost:8700/events | head -c 300`, then `scripts/shot.sh` -> `docs/screenshots/p1-demo.png` read visually.
- **Acceptance (proof):** (a) health returns `{"ok":true,"mode":"demo"}`; (b) two screenshots 8 s apart differ in character positions (`cmp` shows different files) and show >= 3 rooms occupied; (c) container logs no errors.
- **Risk flags:** none. **Security trigger:** no.

### Phase 2: Live transcript ingestion
- **Rationale:** swap synthetic source for the real transcripts without touching the client.
- **Contracts:** read-only (mount `:ro`, code opens files with `r` only); forwards only tool name + <= 60 char label, never prompt/result text; offsets survive partial lines; each child links to exactly one parent via `meta.toolUseId` -> parent `tool_use.id`; unknown line types ignored not thrown; timestamps are UTC ISO parsed to ms.
- **Files:** src/tail.js, src/normalize.js, src/state.js (extend), src/casefile.js, test/*.test.js, test/fixtures/* (⊕create); src/server.js, docker-compose.yml (✓exists after P1).
- **Steps:** discover sessions modified in last N hours (default 6, `HOSPITAL_WINDOW_H`); tail main + `subagents/`; spawn/link/done/verdict/triage/SendMessage events; live/demo switch by `?mode=` and env; session picker in HUD.
- **Verify with:** `node --test test/*.test.js` (= `npm test`) ; `docker compose up -d --build` then open live mode while this very session is running and screenshot `p2-live.png`.
- **Acceptance:** fixtures tests green (spawn link, handback, verdict parse, partial line); live screenshot shows >= 1 real subagent character with correct role; `docker inspect` shows mount `RW:false`; `touch` inside container on the mount fails.
- **Risk flags:** reading user transcripts (privacy). **Security trigger:** yes (file paths / sensitive data exposure; bind server to 127.0.0.1 by default, sanitize labels, path-traversal-safe static server).

### Phase 3: Tool animations, case machine, warnings gate (v9.12)
- **Rationale:** the activity bubble/equipment is the product's "aha"; and the case machine must mirror subagent-pool v9.12, where nothing closes a phase while an implementer WARNING is open (source: SKILL.md §7 "Open WARNINGS block closing the phase", prompts.md §2/§3).
- **Contracts:** one animation per (role, tool) from the table above; case room transitions follow the brief exactly (FAILURE_ORIGIN mapping); an agent is never in two rooms; room of case derives only from events, not from demo flags. **Warnings invariant:** a case with >=1 warning in state `open` or `acceptable-pending` NEVER enters Discharge nor advances to the next phase; warning states are exactly `open | unruled | fixed | acceptable | must_fix | accepted`; a warning's text is stored truncated to 120 chars and sanitized (privacy). Absence of a `WARNINGS:` line, or `WARNINGS: none`, = zero warnings (never "unknown" -> open).
- **Files:** public/js/anim.js ✓(P1), public/js/render.js ✓(P1), src/state.js ✓(P1), src/roles.js ✓(P1/P2), src/normalize.js ✓(P2), test/state.test.js ✓(P1), ⊕create src/warnings.js (pure parser), ⊕create test/warnings.test.js. (Re-verify with ls before starting; P2 is in progress.)
- **Detection rules (transcript text; all anchored to line start, case-sensitive, inside the subagent's final text / SubagentHandback message or the Task tool_result):**
  1. *Warning opened:* implement-agent (or codex-agent implementing) final report contains line `WARNINGS:` followed by text other than `none` (case-insens.); items = the text after the colon plus following `- `/`* `/`N.` continuation lines until the next ALL-CAPS `KEY:` line (next keys in contract: `NOT_VERIFIED:`, `NEXT:`). Emit `warning_open {caseId, phase, items[]}`. Fallback if items can't be split: one item = whole text.
  2. *Reviewer verdict per warning:* review-agent final report line `WARNINGS_RULING:` then one line per item ending in `fixed | acceptable | must fix` (values from prompts.md). Match each line to an open item by index order, falling back to substring similarity. Emit `warning_ruling {item, ruling}`. `must fix` -> item `must_fix`, case returns Operating (implementation loop, max 2/phase). `fixed` -> `fixed`. `acceptable` -> `acceptable` (waits for user). Missing/invalid ruling for an item -> item stays `open` and gurney shows "unruled" (Conductor asks reviewer once; do not guess).
  3. *Binding rule:* `STATUS: APPROVED` + any `must fix` ruling is treated by the Conductor as NEEDS_REVISION(implementation); the reducer must do the same (case -> Operating, not Discharge/next phase).
  4. *Accepted risk:* handled in Phase 4 (case-file `ACCEPTED_RISK:` line); until the casefile source reports it, an `acceptable` item stays pending even if the transcript says "ok".
- **Visual (avoid the predictable: no red badge counters):** open warnings are **loose stitches/threads hanging from the folder on the gurney**, one thread per open warning, each ending in a tiny tag; threads sway. The gurney's wheels get a **brake chock** while any warning is open, and the Discharge chute door shows a **drawn shutter** (rolled down, small padlock sprite) if that case tries to approach it: the gurney visibly stops at the corridor in front of Discharge ("held at the door"), it does not teleport back. Reviewer rulings animate at Radiology per thread: `fixed` -> thread is cut by scissors and drops; `must fix` -> thread turns red and tugs the gurney back toward Operating; `acceptable` -> thread gets a **wax-seal blob** (amber, unsigned, dull) and waits. Lamp on cart: amber blink = warnings gate, distinct from green (discharge-ready) and red (FAILED).
- **Tests:** table-driven: no WARNINGS line -> 0; `WARNINGS: none` -> 0; 2 bullets -> 2 open; ruling mix {fixed, acceptable, must fix} -> states; APPROVED + must fix -> Operating; APPROVED + only acceptable -> held (not Discharge); last phase APPROVED + open warning -> never Discharge; fixed-all -> Discharge allowed; each brief transition incl. stalled->reception->stopped.
- **Verify with:** `node --test test/state.test.js test/warnings.test.js` and demo screenshots per tool `p3-*.png` plus `p3-warning-held.png` (gurney stopped before shuttered Discharge, 2 threads) and `p3-warning-cut.png`.
- **Acceptance:** (a) screenshot shows lightbox, sparks, microscope in separate frames (`?freeze=tool`); (b) demo scenario "implementer leaves a warning" (mirrors flujo-v9-12 scenario) shows threads appear on implement handback, gurney held, ruling resolves thread, gurney then reaches Discharge; (c) no code path lets a case reach Discharge with open/pending warnings (test asserts this over randomized event orders); (d) per-warning verdict is visible (thread state) for each of the three rulings.
- **Risk flags:** state.js is the central reducer (high blast radius). **Security trigger:** no (warning text is sanitized/truncated, rendered via canvas text only).

### Phase 4: Pneumatic tubes, council, specialist pool, case file room, Direction room, escalation bell
- **Rationale:** multi-agent coordination (SendMessage, councils) differs from a single agent; and the v9.12 human gates (accepted risk, merge/deploy approval, escalation) are where the user must be pulled in, so they get dedicated places and signals.
- **Contracts:** capsule flights only for real SendMessage events (from, to); council seats map one-to-one to the four council-* types; case-file room shows STATUS text from `*-state.md` (needs project mounted). **Accepted-risk invariant:** an item becomes `accepted` ONLY from a case-file line `ACCEPTED_RISK:` (never from Conductor prose); format per SKILL.md §2b: `ACCEPTED_RISK: {item} — {user's words} — {date}` (em dash separators). **Direction invariant:** the Direction room only lights for Approve-tier actions; the Conductor's character never appears executing git (v9.12 M3: merge/commit/push are delegated), so the Direction scene shows the delegate agent holding at the door until the user answers. **Bell invariant:** one ring per distinct escalation (dedupe by case+reason+minute); sound is off by default, opt-in toggle persisted in localStorage, only after a user gesture (browser autoplay rule).
- **Files:** public/js/{render,anim,hud,map}.js ✓(P1), src/casefile.js ⊕create (P1 list; verify), src/escalation.js ⊕create, public/js/audio.js ⊕create (WebAudio synth, no asset files), docker-compose.yml ✓(P1), test/casefile.test.js ⊕create, test/escalation.test.js ⊕create.
- **Map change (Direction room):** add room **DIRECTION (Sala de dirección)** to `map.js`, placed in the top row replacing nothing: widen to a 5th top cell by shrinking AGENT-ARCHITECT, or alternatively as a glass-walled mezzanine office overlooking Reception reachable by one door and one tube (preferred: mezzanine, keeps the 48x30 grid). Contents: long table with a single stamp/seal press and a **brass "APPROVE" key switch** (two-position); a wall window to Reception. Agent mapping: no resident; a delegate (implement-agent/general-purpose doing git) is drawn standing at the door with a sealed envelope while the approval is pending. The user is represented by an empty high-backed chair that fills (silhouette) when the user answers. Tube junction connects Reception<->Direction. Also add a tube from Case File to Direction.
- **Detection rules:**
  1. *Accepted risk (case file):* `src/casefile.js` parses `^ACCEPTED_RISK: (.+?) — (.+) — (\d{4}-\d{2}-\d{2})$` from `plans/*-state.md` into `{item, userWords, date}`; matched to a warning/ledger row by item-text similarity. Emit `risk_accepted`. Warning `acceptable` -> `accepted` -> gate lifts (Phase 3 invariant). Ambiguous-answer rule: no ACCEPTED_RISK line = not accepted. Visual in the Case File room: a **wax-sealed index card pinned to the archive drawer for that case**, the seal pressed with a thumbprint in the user's accent color, date stamped, `userWords` shown on hover/click (truncated 80 chars); on the gurney the dull wax blob from P3 turns into a bright signed seal and the thread is tied off. Also draws the unaccepted ones as empty seal rings (so absence is visible).
  2. *Direction room trigger (merge/deploy approval):* (a) any subagent final text containing `STATUS: BLOCKED` whose text mentions `merge|push|deploy|publish|migration|git push` (case-insens.), or (b) a Bash tool_use input (any agent, incl. main) matching `\bgit\s+(merge|push)\b` / `docker\s+push` / `npm publish`, or (c) case file status/next-action mentioning `Gate 2` or `Merge / push / deploy`. Emit `approval_pending {caseId, action}`. Clears on the next user-role message in the main transcript (the answer) or on a following tool_use of that action succeeding. Visual: case gurney rolls into Direction, key switch glows amber and the envelope waits; on user "yes" the stamp comes down (green ink), on "no/not yet" the envelope is returned to a tray. NOT_VERIFIED: the exact user-answer detection is a heuristic (see MISSING).
  3. *Escalation bell:* emit `escalation {caseId, reason}` where reason is one of: `approve` (as rule 2 or a BLOCKED STATUS), `blocked` (any `STATUS: BLOCKED` or `PARTIAL` x2 with no files changed), `stall` (agent stalled >120 s per P2 rule, or same REQUIRED_CHANGES text twice consecutively, or 2 diagnosis rounds w/o evidence per case file), `ask_user` (main-session assistant turn that ends with a question mark and has no tool_use, followed by no new events for 15 s; also an `AskUserQuestion` tool_use if present), `failed` (review `STATUS: FAILED`, which per §7 goes to the user first), `exhausted` (case file re-route count >= 3). Clears when a user-role message appears after it.
  4. *Visual of the bell (avoid corner-icon toast):* an **old brass desk bell on Reception counter** that the Conductor character slaps; a physical **bell-pull cord** runs along the ceiling tubes to a **clapper-lamp over the browser tab/HUD edge**: whole screen border pulses a warm amber vignette (not red) for 2 s, then a persistent small bell stays "ringing" (vibrating) in the HUD with reason text (`approve - merge en forja`) until cleared. Browser tab title gets a leading `(!)` and favicon swaps to a bell. Click on the HUD bell centers the camera on the case's room. Optional sound: synthesized two-note strike via WebAudio (no files), volume slider, off by default.
- **Tests:** casefile parser (STATUS, Tier, Plan file, ACCEPTED_RISK, both malformed variants: missing date, `-` instead of em dash -> ignored); escalation table (each reason fires once, dedupe, clears on user message); direction trigger regexes (positive: `git merge main`, `STATUS: BLOCKED ... push`; negative: `git merge-base`, `git log`).
- **Verify with:** `node --test test/casefile.test.js test/escalation.test.js`; demo extended with council scene, accepted-risk scene and merge-approval scene; screenshots `p4-council.png`, `p4-direction.png`, `p4-bell.png`, `p4-accepted-seal.png` (`?freeze=` params).
- **Acceptance:** screenshot shows four distinct council hats and a capsule mid-flight; accepted-risk demo: card with signature appears in Case File and gurney proceeds; Direction scene shows pending envelope + key switch, then stamp; bell: amber border pulse + persistent HUD bell with reason, sound only after opt-in; clearing works; casefile and escalation tests green; with sound disabled no AudioContext is created.
- **Risk flags:** extra mount of project dirs `:ro`; map.js layout change touches P1 room geometry (re-run A* path tests). **Security trigger:** yes (paths from transcript `cwd`; allow-list of mounted roots only; `userWords` and warning text are untrusted, render as canvas text only, truncate).

### Phase 5: Polish and ops
- **Rationale:** robustness once the behavior is right.
- **Contracts:** sleeping after 5 min idle; reconnect SSE with snapshot; bounded memory (drop gone agents after 10 min).
- **Files:** public/js/hud.js, src/server.js, README.md, CHANGELOG.md, scripts/shot.sh.
- **Verify with:** `node --test test/*.test.js` (= `npm test`), soak: replay a large real jsonl (>20 MB) through the tailer, RSS < 150 MB (`docker stats --no-stream`).
- **Acceptance:** numbers recorded in CHANGELOG; README has the screenshot.
- **Risk flags:** none. **Security trigger:** no.

## Alternatives considered
- Hooks-based capture (pixelagents) — rejected: needs writing user settings; brief is read-only transcripts.
- Person-shaped patient — rejected: the case is the thing that moves; a gurney+folder encodes tier/progress.
- Isometric/Habbo view — deferred: brief says top-down for v1.

## Assumptions
- Server binds `0.0.0.0` inside container but compose publishes `127.0.0.1:8700` only.
- UI labels in Spanish (user), identifiers in English.
- Live window default 6 h; `fork` and unknown subagent types go to the Specialist pool.

## Open Questions
1. Mount only `~/.claude/projects` or also project dirs (for `plans/*-state.md`)? Proposed default: mount `~/.claude/projects` in P1-P3, add explicit `:ro` project mounts (<other-project>, hospital-agentes) in Phase 4.
2. Is the transcript content privacy fine on LAN? Proposed default: localhost only.

## Graph Warnings
None (no graph).

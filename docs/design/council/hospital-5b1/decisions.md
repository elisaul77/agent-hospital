# decisions — hospital-5b1

| # | Decision | Chosen | Rejected (by whom proposed) | Why | Open? |
|---|----------|--------|-----------------------------|-----|-------|
| 1 | API shape | `GET /api/archive` (list) + `GET /api/doc?case=<id>&doc=<kind>`; ids server-minted (sha256 of real state path, 16 hex); `doc` = enum `state\|plan\|decisions\|debate\|shot-<n>` (n = index in the server listing); no client path ever | `?path=` / handleStatic-style path API (architect alt 2); open in editor/xdg-open (architect alt 1, lateral "don't build") | Container is :ro with no desktop; a host helper is a new exec path; opaque ids remove traversal input | no |
| 2 | Extend /api/state with parsed case content (lateral sec.1) | NOT adopted | lateral | Pushes case content over SSE to any client; casefile.js never forwards bodies (risk) | no |
| 3 | Archived cases as discharged patient sprites / synthetic patients (lateral inversion) | NOT adopted; archive = list rows, same case id as the live case, `live` flag from `src.caseKeys` | lateral | Scope change (spec); keeps reducer and renderer untouched | no |
| 4 | Index-at-write-time INDEX.md (lateral) | dropped | lateral | No writer we control; mounts :ro | no |
| 5 | Archive UI as DOM panel (not Canvas list) (lateral) | ADOPTED | Canvas list | Selectable text, phone friendly, textContent-safe | no |
| 6 | Scan | fixed probes, no recursive walk: `<root>/plans`, `<root>/*/plans`, `<root>/*/*/plans` (3 levels), one readdir per child, skip dot dirs, node_modules, .git, venv, __pycache__; no symlink follow; cap 200; sorted mtime desc; cache 30 s; refresh on miss; per-dir try/catch; sync fs allowed because cached | lateral depth-2 (dropped by lateral itself); risk "async fs" (relaxed by risk: ok if fixture test passes) | Today every case is at depth 2, but invariant is ALL cases and IA has group dirs; fixed probes are bounded by construction | no |
| 7 | Host guard | hostname in localhost\|127.0.0.1\|[::1] (case-insensitive, any port) or in `HOSPITAL_ALLOWED_HOSTS` (default empty); mismatch/missing/duplicate/odd forms = **421**; on ALL routes incl. /events, /api/state, static; plus `Sec-Fetch-Site` not in {same-origin,none} on /api/* = 403; no `Access-Control-*` ever | exact `127.0.0.1:8700` pin (spec R1); 403 for Host (spec R1) | Breaks LAN/WG phone use and random-port tests; status settled to 421 (crossed 403/421 resolved) | no |
| 8 | Redaction | best-effort named-token patterns only (sk-, ghp_/gho_…, xox*, AKIA, Bearer, JWT, private-key blocks, `password\|secret\|token\|api_key = value`); viewer shows `redactado: n` + best-effort banner; **no** generic hex/base64 rule | no redaction (spec R1 A2); 40+ hex/base64 rule (architect R1, risk R1) | Mangles SHAs; spec accepted redaction with banner | no |
| 9 | Refusal codes | one identical 404 body for every refusal (unlisted, symlink out, non-regular, bad PNG magic, oversize PNG excluded from listing); 421/403/405 only for guard and method; 413/415 never | 413/415 (risk R1) | No oracle | no |
| 10 | Text cap | 256 KB, truncated with `[recortado]` + `truncated:true`; NUL in text -> refuse (404); PNG <= 2 MB | 413 | Spec A4 | no |
| 11 | Markdown | plain text only | safe mini-render | Doubles XSS surface | no |
| 12 | caseDocs council path | exactly `plans/council/<state stem minus -state>/decisions.md` and `debate.log` | "prefixed councils" clause | Self-contradictory (spec) | no |
| 13 | Conductor idle env | `HOSPITAL_CONDUCTOR_IDLE_MIN`, default 30; invalid/<=0/NaN = 30 + console.error, no boot exit | exit(1) (architect R1) | Typo would crash-loop under restart | no |
| 14 | Council room role fix | `.meta.json` records `customAgentType`/`spawnedAgentType` (e.g. `council-architect`) for teammates (verified on this council's 5 members); tail.js uses it when it is a known role type; fallback = name regexp `^(?:council-)?(spec\|architect\|lateral\|risk)(?:[-\d].*)?$` | name-only matching | Real type beats guessing; fallback covers old transcripts | no |
| 15 | Real test of "same patient" | case id for live case = sha256 of the same real state path used in `latestCaseFile` | per-session join | One key both sides (spec A5) | no |

## Consistency pass (crossed acceptances)
- Host mismatch status: spec said 403, architect 421; spec accepted 421 in log -> 421.
- Scan depth: lateral said depth 2, architect/spec/lateral final said depth<=3 with skip list; architect's own log text proposed fixed 3-level probes; lateral's final accept says "depth<=3 scan with skip list" — compatible; settled as fixed 3-level probes (row 6).
- Invalid env: architect exit(1) vs spec/risk default 30; all restated default 30.
- No genuine swap found.

## Open disagreements
none

## Changes after approval
- 2026-10-18 (hospital-5b1, Fix B): row 12 is superseded. The council docs are every direct subdirectory of `plans/council/` (max 20, by name) as `council-<n>-decisions|debate|brief` with the dir name as label; the bare `decisions`/`debate` kinds and the stem-only path are gone, because real council dirs are per task (hospital-4b, hospital-5b1) and the stem lookup never found them.

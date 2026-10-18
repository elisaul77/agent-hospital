# decisions — hospital-5c

| # | Decision | Chosen | Rejected (proposed by) | Why | Open? |
|---|----------|--------|------------------------|-----|-------|
| D1 | Redaction false positive | (a) keep key=value rule, skip exact placeholders and backticked/<…> bare placeholders; negative tests letmein, hunter2, quoted real | (b) digit/8+ rule (reviewer, lateral hybrid); (c) accept; drop key=value for token shapes (lateral) | (b) leaks `letmein`; shapes miss plain passwords; (a) leaks only a secret literally equal to a placeholder word. Changes if: such a leak happens -> (b)+placeholder hybrid | no |
| D2 | Phone access | WireGuard <wg-ip> only, via separate compose.wg.yml (-f) and HOSPITAL_ALLOWED_HOSTS=<wg-ip>; base stays loopback | LAN <lan-ip>, both (user options); WG bind in base compose (architect R1) | No auth + readable case files; LAN has smart-home devices and guests; WG peers are own devices; base bind would kill loopback if WG is down at boot. Changes if: phone cannot use WG -> LAN + token as separate phase | no (needs user approval to redeploy) |
| D3 | Activity level | (a) tool + label + time, ring buffer of labels only | (b) assistant text; (c) commands/results (user options) | Redaction is best effort; text/commands/results hold secrets. (b) possible later behind default-off flag HOSPITAL_ACTIVITY_TEXT, never in demo. Changes if: user accepts best-effort + banner as in the archive viewer | no |
| D4 | Council detection signal | structure first (council-* name/type at spawn, Write path), msgTag as R1-done trigger; body prefix fallback | body-only (architect R1) | lateral: structure beats text | no |
| D5 | Walk vs teleport | reuse existing walk path | teleport first (lateral second voice) | cost ~0 | no |
| D6 | Silent member | timeout moves to Council room | desk forever | crash safety (lateral to spec) | no |
| D7 | Source-side allowlisted labels (lateral) | not adopted in 5c; labelOf already allowlists by tool | rewrite normalize | no gain beyond tests | no |
| D8 | Deep-link to archive instead of rich column (lateral) | withdrawn by lateral | — | — | no |
| D9 | Pool desks | 4 draft desks reserved apart from the 12 consult seats (spec's wording, accepted) | picking free consult seats (architect) | live consults never collide | no |
| D10 | Trigger token | msgTag = 12-char regex prefix of message text; summary/recipient not used | summary as trigger (lateral) | spec: recipient says who, not which round | no |
| D11 | Silent-member timeout | default 10 min, env-tunable | — | spec | no |

## Crossed acceptances
None: each objection got one restated result in debate.log.

## Open disagreements
None.

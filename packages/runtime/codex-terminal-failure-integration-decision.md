# D-EXT-CODEX-TERMINAL — Owner integration decision

The project owner approved option1 with the exact reply “Duyệt phương án 1: bổ sung tương thích” on2026-11-03.
The approved [proposal](codex-terminal-failure-integration-proposal.md) has SHA-256
`abe0ccad2ddfebd740c387968befb08209c55f6f1bd01675dabf091c228c6f43`; its bytes are preserved.
The original reply is recorded in the private audit evidence `owner-native-format-decision.json`.

Motivation: installed Codex0.166.0 emits native quota errors under `task_complete.error.codex_error_info`;
Bflow's existing reader accepts only the older direct error frame and missed an actual controlled spike.
The consent authorizes the proposal's additive ingress normalization and Runtime reader guards,
Contracts/Runtime package-local tests and documentation, plus Agent Providers compatibility tests or necessary typing fixes.
It is the explicit exception to the old design's prohibition on widening an unsupported native parser.

Compatibility: retain legacy Codex/Claude inputs, canonical native-error output projection,
ProviderFailureObservation v3, receipt/storage formats and all Core/SDK signatures. No historical upcast,
release-label allowlist, prose classifier or synthetic native failure proof. Session/turn/time/path checks
and actual authenticated execution, stop, reconcile, policy, lease/fence and TDD requirements remain in force.
Unknown or malformed structures do not gain failover eligibility.

This project decision is not a Runtime human business/design/document approval, does not certify live
failover, and does not authorize global provider configuration changes or Git push.

Bounded reader limitation: session metadata and transcript tail each have a512KiB budget.
New terminal failures require a visible matching native turn anchor inside the accepted execution window;
missing, truncated or earlier anchors fail closed. Herdr may acknowledge after a native turn has started,
so this does not establish complete first-turn failure coverage. No timestamps are relaxed and no cursor
or turn receipt is fabricated. The planned controlled live probe faults a later turn after trusted Red
on the already accepted execution; its actual correlation still must be verified.

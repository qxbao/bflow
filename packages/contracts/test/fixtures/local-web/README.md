# D-WEB-01 fixture bundle — W00 freeze fixtures

`approval-bundle.json` contains synthetic design, delivery and specialist
user-decision requests, decisions, native-v1 human envelopes and proposed
web commands. It is not a record of owner approval, a real physical hook,
a signed web proof or workflow success. IDs, paths and digests are test data.

`command-vectors.json` records proposed positive/negative WebCommand cases.
Positive command vectors are exercised by the exported WebCommandSchema tests.
Stateful negative replay/staleness vectors remain W02 host test obligations. A well-formed stale
generation must parse, then fail the authoritative host concurrency check.

`packages/contracts/test/web-compatibility.test.ts` checks current exported
ApprovalRequest/Decision/PaneBinding parsing, target/version retention and
static native-envelope checksum identity. It does not invoke Runtime's
HostReceiptJournal or prove host replay. W02 must load the same native v1
envelopes through its actual journal codec and test wrong origin, scope,
checksum, decision evidence and conflicting web/native settlement.

W00 includes RED→GREEN tests for the browser-safe web subpath,
exact command schemas/response union, host receipt schema and asset build.
No proposal vector should be relaxed to fit an implementation mismatch.

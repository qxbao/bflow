# P17 review and remediation

Reviewed the implementation at `01eba53` against the v2 contracts, P15 artifact
content codec, P16 strategy boundary, and the accepted task/workflow verification
policies. The review request also authorizes fixes and local main integration.

Reproduced eight failures before implementation changes (49 existing tests passed).
Added further cases for reused change-set IDs/revisions, complete workflow provenance
and below-threshold coverage reuse. The regression suite now covers:

- Reject an attempt, change-set ID or Git revision used anywhere in the cycle,
  including nonadjacent earlier iterations. Checking only the immediately previous
  iteration allowed an older submission identity to be reused.
- Require valid passing evidence from every planned check of a criterion. A passing
  primary test previously let the criterion remain passed when an additional mapped
  check returned malformed/missing evidence.
- Reuse only fully successful checks. A gate labelled passed could still have a
  failing review exit or insufficient measured coverage; those checks must rerun.
- Reject new gate results with evaluation timestamps before dispatch or after
  collection on the trusted host clock. Immutable earlier receipts remain reusable
  only through the separately validated impact/receipt path.
- Reject `*`/`?` glob expressions in literal repository scope/dependency paths;
  silently treating a glob as a literal could skip an affected check.
- Require workflow integration provenance to cover all task IDs traced in the
  approved specification, reject duplicate IDs, and forward integration context
  to the independent runner. Task-level success remains insufficient.
- Emit a scoped finding for every observed failing check/criterion even if another
  gate already emitted an error. Include the evidence artifact and responsible
  Developer task/role so one failure cannot hide a second repair obligation.

The existing port boundaries remain: actual OS/process independence and Git state
are established by the trusted host; Runtime supplies the latest cycle and enforces
optimistic versions, leases, Core rework limits and safe dispatch. This package does
not authenticate a process, implement P19, deliver messages or perform Git merges.
No shared contract change, migration, bootstrap adapter or direct shell runner was
introduced. Root build/lockfile/documentation registration is handled separately
on the integration branch under the user's merge authorization.

See [VALIDATION.md](VALIDATION.md) for the original implementation evidence and the
integration closure evidence appended during local merge validation. The original
implementation and its review fixes are preserved in Git history.

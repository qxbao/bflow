# D-CANCEL-01 — launch-bound process-stop evidence (proposed, not approved)

## Problem and evidence

Cancellation currently has two independent gaps. Runtime exhausts five observations
and stops observing; an explicit operator reconciliation path can fix that liveness
gap. However, `HerdrAdapter.wait` always returns `correlationVerified: false`, and
its accepted interrupt explicitly has `stopConfirmed: false`. Neither native
idle/done nor a cancellation-time shell/PID snapshot proves every old writer has
stopped. The Runtime/CLI patch in this branch therefore preserves that blocker;
it does not certify recovery of the legacy live session.

## Remaining process-proof integration

Launch-bound process evidence can remain Runtime-private. Existing contracts
already carry launch IDs, executable/config fingerprints, environment variables
and native identities; Runtime owns private launch journals and authenticated
control calls. A strict private schema can pin process scope to the exact handle
without changing public contracts. Only an actual new shared contract would need
the separate integration approval described in AGENTS.md. The user's existing
source/build/test authorization is not interpreted as lacking permission for a
private implementation.

A viable Linux extension would need all of the following, rather than a
cancellation-time snapshot:

1. Verify existing cgroup-v2 delegation and create a unique scope before launch;
   durably record kernel boot ID, scope generation, launch identity and launcher
   digest. Missing delegation remains unsupported; do not install components or
   change machine policy during `up`.
2. Use a pinned launcher that enters the scope before executing provider code,
   verifies membership, and preserves existing launch/config attestations and
   Agy's environment wrapper. Verify actual Herdr PATH resolution in an isolated
   named session before relying on any shim.
3. Bind scope generation to the immutable accepted execution/native-session
   digest before dispatch; retain that binding across daemon restart.
4. Seal admission before emptiness checks and retain uncertainty for every
   outstanding dispatch. A never-started or replaceable empty scope proves
   nothing. Scope migration must be prevented, not assumed absent.
5. Observe recursive `cgroup.events` populated=false for the original scope and
   persist exact evidence before allocation cleanup, launch revocation, Registry
   settlement and Core confirmation.

This scope backend is not implemented by the current bounded-reconciliation
patch. It cannot retroactively create missing launch evidence for existing
legacy sessions. Source/local tests of this branch must not be advertised as
live Herdr process-containment acceptance.

## Compatibility and legacy-session migration

Existing v2 handles and v1–v5 journals are retained without fabricated process
scope bindings. The current Runtime recovery patch writes private journal v6
only after genuine correlated evidence; older binaries reject v6. A later process
proof format needs its own explicit private-codec compatibility review.

Legacy sessions without launch-bound scope have no automatic positive proof.
Keep their worktrees and unresolved ownership. An operator must provide a
supported externally verifiable stop source; for example, a controlled machine
reboot with a trusted boot witness recorded beforehand could prove all processes
from that witnessed boot have ended. Such a reboot is a separate operator action,
never performed by this patch. Repeating cancel, resetting counters, expiring a
lease, editing manifest/Registry files, or inferring absence from inaccessible
`/proc` entries is not migration.

## Acceptance required before live claims

A detached descendant that changes SID/cwd and closes descriptors must still keep
the launch scope populated. No successful proof may appear after only idle,
interrupt ACK, timeout, pane replacement or lease expiry. A failed proof or
uncertain delivery must retain writer ownership. A proven stop must preserve
dirty work, settle Registry release versus expiry honestly, and recover across
crashes between proof, allocation cleanup and lease settlement. Cross-run tests
must prove another escalated run and its resume budget are unchanged.

No installation, reboot, remote merge/push, task approval, or resumption of
Việc #2 is performed by this patch.

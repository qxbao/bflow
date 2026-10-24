# NFR criterion worked examples

These are illustrative drafts, not project SLAs, installed commands or verification
results. All four JSON blocks are complete AcceptanceCriterion values for an existing
Specification acceptanceCriteria array. There are no metric/threshold fields: the
oracle and conditions live in description and supporting requirement prose. Keep
status pending and evidenceArtifactIds empty until the existing verification flow
has real evidence. Parsing these examples proves contract compatibility only.

Use the requirements-analysis clarification brief for elicitation. Pass the accepted
oracle/conditions to test-planning and its selected test-design reference for check
selection, fixtures and TestStrategy mapping; do not duplicate that process or change
TddDecision. Tool names below describe candidate methods, not permission to install
or run them. Resolve an actual repository-supported command before execution.

## 1. Latency under an explicit workload

Before: “Search is fast.” Outcome: avoid interactive search stalls. The example
product owner proposes a 250 ms interaction budget; its workload fit and threshold
are unconfirmed, so this remains a proposal, not a universal target.

```json
{
  "id": "ac-nfr-latency",
  "description": "PROPOSED, pending owner confirmation: search GET requests have nearest-rank p95 client-observed latency <= 250 ms. Measure all completed responses across one 10-minute window after a separate 60-second warm-up, using 20 concurrent closed-loop clients without think time, the fixed search-v1 query mix and 100000 seeded records. Count timeouts and non-2xx responses as failure, never exclude them from a passing run. Proposed environment: one dedicated Linux host with 4 vCPU, 8 GiB RAM, local service/database and no competing jobs; record exact OS/runtime/database/config and fixture digest. Pass only if this setup is confirmed, the full window completes without errors and p95 meets the target. Retain timestamped raw samples, load-generator version/options, command/exit status, percentile calculation, environment manifest and candidate revision. Target source: proposed product-owner interaction budget, not an accepted SLA.",
  "category": "performance",
  "verificationMethod": "integration_test",
  "required": true,
  "status": "pending",
  "evidenceArtifactIds": []
}
```

Candidate measurement: an authorized HTTP load generator such as k6, plus a check
of the specified nearest-rank calculation over raw samples. Runner readiness is
unknown until the repository's script/config, actual invocation, fixture and host
are inspected. Do not invent a benchmark command or substitute a tool's default
percentile convention. If the host is unavailable, report the gap; no measurement
has run and no evidence has been independently confirmed.

## 2. Authorization and tenant isolation without a numeric score

Before: “The endpoint is secure.” Risk: cross-tenant disclosure or mutation.
Assumed source for this illustration: a product-owner tenant-isolation rule. Confirm
that rule and the 403 response contract in the real project; neither follows merely
from this example. No statistical threshold or time window is applicable: the oracle
is observable behavior for each defined case.

```json
{
  "id": "ac-nfr-isolation",
  "description": "PROPOSED tenant-isolation rule: in an isolated integration environment with synthetic tenants A/B, one user token per tenant and one document per tenant, a user authenticated only for A requesting B's document by known ID via GET or PATCH receives HTTP 403 with the agreed generic error body, no B document fields or existence details in response body/headers, and no changes to B's stored document. Include an A-to-A allowed control under the same roles. Run the complete case matrix once per candidate with concurrency 1; compare stored content before/after PATCH and inspect sanitized response captures for every case, without averaging away failures. Pass only if every denial, non-disclosure, no-mutation and allowed-control assertion holds. Retain case IDs, fixture identity, response assertions, before/after integrity assertions, actual command/exit status, environment/tool versions and candidate revision; never retain tokens or protected payloads. Expected behavior source: proposed product-owner isolation rule, response contract awaiting confirmation.",
  "category": "security",
  "verificationMethod": "integration_test",
  "required": true,
  "status": "pending",
  "evidenceArtifactIds": []
}
```

Candidate tool: the repository's integration runner with an HTTP client and isolated
database fixtures. Missing credentials/authorized fixture access is a readiness gap,
not permission to test real tenants. Successful local cases prove only this matrix
and environment, not all security properties. Independent verification checks the
accepted response contract and captures before recording satisfaction.

## 3. Crash recovery and data integrity

Before: “Storage is stable.” Outcome: preserve acknowledged writes through a process
crash. Proposed source: the storage owner's acknowledged-write durability guarantee.
This example covers process failure on a local filesystem, not power loss or remote
storage, and makes no recovery-time commitment.

```json
{
  "id": "ac-nfr-integrity",
  "description": "PROPOSED acknowledged-write integrity rule: in an isolated Linux/local-filesystem fixture with 100 seeded records and one writer (concurrency 1), acknowledge an update to record 42, terminate the service process with SIGKILL immediately after the acknowledgment using the fixture barrier, then restart with the same data directory. After normal startup completes, record 42 must contain exactly the acknowledged value, all other records must match the seed snapshot, and enumeration must show exactly the original record IDs with no duplicates or partial records. Run the fault scenario once per candidate; compare every record and ID, with no aggregate tolerance. Pass only if all assertions hold and the fault/barrier/restart are demonstrated. If acknowledgment timing or restart completion cannot be established, report inconclusive evidence instead of success. Retain barrier and acknowledgment trace, exit/signal and restart logs, fixture digest, full comparison result, actual command/exit status, filesystem/runtime versions and candidate revision. Rule source: proposed storage-owner durability guarantee; recovery time and power-loss durability are outside this criterion.",
  "category": "non_functional",
  "verificationMethod": "integration_test",
  "required": true,
  "status": "pending",
  "evidenceArtifactIds": []
}
```

Candidate tool: an existing subprocess integration runner with a deterministic
acknowledgment barrier and isolated temporary data directory. A sleep-based crash
without proof of the fault point cannot confirm this criterion. If no barrier exists,
record the runner gap for the authorized owner rather than claiming recovery passed.
One fixture run does not establish a statistical reliability rate.

## 4. Unknown target and environment: retain pending

Before: “Uploads must be fast at production scale.” The upload path changed, so
latency is relevant; however, production scale and the customer budget are unknown.
A proposed percentile alone is not a complete measurement definition.

```json
{
  "id": "ac-nfr-upload-pending",
  "description": "PENDING CLARIFICATION: outcome is to avoid interactive upload stalls. Proposed observable is client-observed upload p95 in ms with comparator <=; threshold and its authority/rationale are UNKNOWN. Payload distribution, data scale, concurrency, dependency topology, target environment, warm-up, measurement window, aggregation convention and timeout/error oracle are UNKNOWN. Runner/tool and actual measurement command are not yet confirmed. No pass/fail determination is possible until these are resolved through Runtime and Conversation and the existing specification revision flow. Planned evidence is raw latency/error samples, workload/fixture identity, tool/config versions, command/exit status, environment identity, aggregation output and candidate revision; no measurements or independent confirmation exist.",
  "category": "performance",
  "verificationMethod": "integration_test",
  "required": true,
  "status": "pending",
  "evidenceArtifactIds": []
}
```

Send a focused clarification through Runtime → Herdr → Conversation: who owns the
upload budget, and which payload/concurrency/environment should it cover? Retain
correlation and waiting state until the actual decision arrives. This is a valid draft
record, not a measurable accepted commitment. Do not invent a threshold, use a local
laptop as production evidence, waive the criterion or self-approve dependent work.

For every example, retain planned evidence separately from collected evidence.
ArtifactProposal ingestion by ArtifactStore supplies trusted IDs/references; example
filenames, script existence and hand-written artifact IDs do not. Missing evidence
keeps satisfaction unproven. Review/QA use the existing bounded verification flow;
this reference adds no engine, gate, approval, monitoring system or benchmark suite.

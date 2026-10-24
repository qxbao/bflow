# specification-driven-development worked example

## Input

Add a bounded retry policy for run-42.

## Authorized steps

Propose AC-1: unknown_delivery never resends automatically; AC-2: a proven not_delivered reconciliation permits a policy-bounded retry.

## Expected output and evidence

The accepted specification revision and both criterion IDs accompany task-parser. A prose draft alone cannot authorize implementation.

## Failure branch

If specification persistence or approval evidence is missing, retain a proposal and blocked reason. Do not self-approve or treat a document file as accepted state.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## NFR drafting

Use [the four NFR examples](nfr-examples.md) for latency, tenant isolation, crash
integrity and an unresolved target/environment. Each JSON block is an existing
AcceptanceCriterion suitable for a draft Specification acceptanceCriteria array;
none represents a run result or an approved project requirement.

# requirements-analysis worked example

## Input

A request says retries must be automatic and never duplicate delivery.

## Authorized steps

Identify the uncertainty case, propose a non-delivery reconciliation criterion and request the desired behavior when delivery cannot be proven.

## Expected output and evidence

The analysis exposes the tradeoff rather than promising exactly-once transport without evidence.

## Failure branch

Conflicting requirements remain explicit. Do not resolve them by inventing a user preference or silently deleting an older criterion.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

## NFR clarification branch

Before: “Retries are stable and recovery is fast.” After analysis: identify the
risk of duplicate delivery after a crash; ask which acknowledgment boundary must
survive and which fault/storage environment is in scope. Recovery-time target is
unknown, not a guessed SLA. Keep the dependent criterion pending and send the
focused clarification through Runtime → Herdr → Conversation. Use
[the clarification brief](nfr-clarification.md); the specification-driven-development
skill contains contract-valid recovery and unresolved-target examples.

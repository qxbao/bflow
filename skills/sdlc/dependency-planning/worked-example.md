# dependency-planning worked example

## Input

Seven leaf packages can build against a frozen contracts baseline.

## Authorized steps

Plan the leaf tasks in parallel, then a sequential merge/check synchronization gate, then Runtime integration.

## Expected output and evidence

The DAG prevents post-prerequisite Runtime wiring from starting while any required leaf implementation or integration check remains incomplete.

## Failure branch

A cycle or unknown predecessor blocks the affected plan. Report the specific edges rather than deleting a dependency to force scheduling.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

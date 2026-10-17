# report-task-result worked example

## Input

Developer completes task-parser after package tests pass.

## Authorized steps

Submit the scoped patch proposal, exact tested HEAD and test-result proposal, with live Herdr acceptance explicitly unverified.

## Expected output and evidence

Runtime validates the correlated result and independent gates; the task report does not directly transition the whole workflow to completed.

## Failure branch

If result delivery is uncertain, preserve request/idempotency identity and reconcile. Do not submit a new attempt merely because no acknowledgment arrived.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

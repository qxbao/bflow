# recover-execution worked example

## Input

The host restarts after dispatch intent but before acknowledgment.

## Authorized steps

Reload the original request and manifest, reconcile its delivery and retain unknown_delivery if no conclusive binding or non-delivery proof exists.

## Expected output and evidence

No automatic resend occurs. The bflow recover command is documented only for an empty legacy lifecycle lock and cannot repair workflow receipts.

## Failure branch

Corrupt receipts, missing aggregate state or uncertain side effects stay unresolved. Do not fabricate checkpoints, approvals or execution bindings.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

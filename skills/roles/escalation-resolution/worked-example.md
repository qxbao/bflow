# escalation-resolution worked example

## Input

Verification has failed for the configured third iteration.

## Authorized steps

Coordinator summarizes failing AC-2, prior repairs and safe options for the human, then asks Runtime to persist escalation.

## Expected output and evidence

The task remains escalated until an authenticated decision; no fourth automatic repair is dispatched.

## Failure branch

If information is insufficient, preserve the blocker and request the smallest missing fact; avoid speculative repair side effects.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

# fix-review-findings worked example

## Input

Review R-7 shows timeout-triggered resend.

## Authorized steps

Add the required reproduction in Red-first order if required, preserve unknown_delivery, rerun the targeted fixture and submit an R-7 resolution note.

## Expected output and evidence

The note identifies the new revision and passing check; it asks for independent re-review rather than changing approval state.

## Failure branch

If a finding is stale or cannot be reproduced, preserve that evidence and ask Runtime to resolve applicability rather than silently marking it fixed.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

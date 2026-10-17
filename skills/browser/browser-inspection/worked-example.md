# browser-inspection worked example

## Input

QA checks that Save is disabled for an invalid configuration.

## Authorized steps

Acquire the approved browser profile lease, open the assigned test origin, enter invalid data and capture the disabled state with the candidate revision.

## Expected output and evidence

A screenshot proposal and reproducible steps support the criterion; a lease timeout after Save would be reported uncertain rather than repeated.

## Failure branch

A busy browser is blocked, not permission to steal a lease. Timeout after a possible click/write is uncertain and must be reconciled before retry or reassignment.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

# understand-task worked example

## Input

User asks to make retries safe without specifying delivery semantics.

## Authorized steps

Conversation asks whether unknown transport delivery must block automatic resend, preserving the request correlation.

## Expected output and evidence

The clarified outcome explicitly prohibits replay until reconciliation proves non-delivery; the Coordinator receives a correlated delegation.

## Failure branch

If received context conflicts with accepted requirements, record the conflict and request a versioned change instead of silently changing scope.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

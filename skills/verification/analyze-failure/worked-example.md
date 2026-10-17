# analyze-failure worked example

## Input

A storage test fails only after a worker subprocess starts.

## Authorized steps

Compare source and dist revision; confirm the package requires rebuilding before worker tests, then repeat the same authorized check after build.

## Expected output and evidence

The diagnosis distinguishes stale build output from a product defect and preserves both observations rather than claiming the initial failure never happened.

## Failure branch

If reproduction fails, report variability and environment differences. Do not rerun until green and discard failed evidence.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

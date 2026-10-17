# workflow-orchestration worked example

## Input

A Developer reports completion while QA is pending.

## Authorized steps

Coordinator submits the result through Runtime, requests the next allowed independent verification and reports the waiting gate.

## Expected output and evidence

No direct status mutation marks the workflow complete and no pane/process command bypasses the scheduler.

## Failure branch

Conflicts or unknown delivery require reconciliation of authoritative state. Never launch a direct provider process or write workflow success state yourself.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

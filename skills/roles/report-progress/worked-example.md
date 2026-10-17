# report-progress worked example

## Input

User asks whether the retry fix is done.

## Authorized steps

Conversation reports that the patch and local tests passed while independent QA is still running and human delivery approval remains pending.

## Expected output and evidence

The update gives a meaningful milestone without treating local checks as final workflow acceptance.

## Failure branch

If status cannot be refreshed, label the last observation and its uncertainty rather than presenting stale state as current.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

# request-approval worked example

## Input

Runtime requests delivery approval for task-ship at revision 2 generation 1.

## Authorized steps

Conversation presents the exact candidate evidence and approved/rejected/changes_requested options, then forwards the authenticated answer.

## Expected output and evidence

Only Runtime records the decision after validation. A specialist cannot run an approval CLI command by impersonating a human actor.

## Failure branch

An ambiguous or stale answer remains pending/invalid; explain what concrete decision is still required without auto-selecting an option.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

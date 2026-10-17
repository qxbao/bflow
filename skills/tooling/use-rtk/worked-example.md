# use-rtk worked example

## Input

Developer receives a package test command with verbose success output.

## Authorized steps

Use only the approved wrapper mapping, retain the underlying test exit code and attach the complete test-result evidence separately.

## Expected output and evidence

The report contains the actual failed/skipped counts even if the conversational view shows a short summary.

## Failure branch

Unsupported wrapping or evidence loss means stop using the wrapper for that check and report the limitation. Do not install or update RTK as a side effect of skill loading.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

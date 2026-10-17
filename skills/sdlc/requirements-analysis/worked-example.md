# requirements-analysis worked example

## Input

A request says retries must be automatic and never duplicate delivery.

## Authorized steps

Identify the uncertainty case, propose a non-delivery reconciliation criterion and request the desired behavior when delivery cannot be proven.

## Expected output and evidence

The analysis exposes the tradeoff rather than promising exactly-once transport without evidence.

## Failure branch

Conflicting requirements remain explicit. Do not resolve them by inventing a user preference or silently deleting an older criterion.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

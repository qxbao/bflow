# architecture-analysis worked example

## Input

A new skill manifest must join provider startup.

## Authorized steps

Propose a Runtime-composed port boundary and pinned manifest fingerprint; keep provider and skills leaf packages independent.

## Expected output and evidence

The design identifies P30 integration ownership rather than importing a leaf adapter directly or widening a public signature silently.

## Failure branch

If source contradicts design documents, record the mismatch rather than rebuilding implemented modules from an old bootstrap.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

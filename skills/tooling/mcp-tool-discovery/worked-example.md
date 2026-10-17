# mcp-tool-discovery worked example

## Input

Reviewer needs a repository graph operation.

## Authorized steps

Discover only the approved GitNexus service operations under the reviewer registration and inspect the caller-query schema.

## Expected output and evidence

The selected tool is authorized and bounded. A guessed admin operation is neither shown nor called.

## Failure branch

Missing or denied tools produce a concrete diagnostic. Do not add an arbitrary URL, launch a second upstream worker or change global provider configuration.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

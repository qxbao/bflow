# use-context7 worked example

## Input

A developer must change a call to a third-party HTTP client. package-lock.json resolves it to `2.4.1`, and the developer does not remember whether the timeout option was renamed after that release.

## Authorized steps

1. `bflow docs lookup httpclient --query "configure the request timeout in the client constructor" --json`.
2. The result reports `requestedVersion: "2.4.1"`, `versionSource: "installed"`, `versionMatch: "exact"` and the library id with the `/v2.4.1` suffix, so the excerpt describes the version the repository uses.
3. The developer opens the installed package's type definitions, confirms the option name, and runs the existing test that builds a client with a timeout.

## Expected output and evidence

The task note cites the library id and version of the excerpt, states that the option name was confirmed by the installed types and a passing test, and treats the documentation as reference rather than authority over the accepted specification.

## Failure branch

If the result is `version_not_found` and lists only later versions, the developer does not use the newest documentation. The note records that the repository's version is undocumented, the decision to rely on the installed package and its tests instead, and the gap. If the service is unreachable, the developer reports that documentation was not checked and continues from repository sources. No query includes repository code, and no unapproved search tool is used instead.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.

# @bflow/docs-retrieval

Looks up current, version-specific library documentation through Context7 (or any caller that offers the same two MCP
tools), and reports exactly what came back. A leaf package: no workspace dependencies, no network code of its own. The caller
(`DocsToolCaller`) is injected; the CLI supplies one that goes through the shared MCP Gateway with the agent's own registration.

## What it does

- `detectInstalledVersion(root, library)` reads the version a project actually uses: lockfile first (`package-lock.json`,
  `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `go.mod`, `Cargo.lock`), then the
  manifest (`package.json`, `requirements*.txt`, `pyproject.toml`). It says whether the version is exact. Name variants
  (`next.js` -> `next`) are tried. The search starts in `options.from` and walks up to the root, so a workspace package is found
  from its own directory and a lockfile kept at the workspace root is used. A lockfile with several copies that cannot be tied to the
  declared range is not guessed from: the manifest's lowest version is returned as inexact. Lockfile parsers are small and format-tolerant, not complete.
- `parseResolveResult` / `selectLibrary` / `selectVersion` parse Context7's `resolve-library-id` text and choose a library and a
  version. An unknown name makes Context7 return the nearest unrelated libraries, so a candidate qualifies only if its title or id
  contains the requested name. A library that offers the project's version outranks one that does not. The version chosen is the
  exact one, else the nearest at or below it in the same minor, then the same major. It never moves to a newer release; when
  nothing matches it says so and lists what is offered.
- `DocsClient` runs resolve -> choose -> query, records the version requested and the version used, and returns typed failures.
  `probe()` exercises discovery and both tools with public queries.
- `classifyToolError` / `classifyGatewayError` separate `network`, `timeout`, `auth_missing`, `auth_invalid`, `rate_limited`,
  `library_not_found`, `version_not_found`, `no_documentation`, `invalid_arguments`, `permission_denied`, `unavailable`,
  `upstream_error` and `protocol`. The hosted server reports several of these with HTTP 200 and `isError`, so the text is parsed.
  The rate-limit and quota wording was **not observed** (it could not be provoked) and is matched loosely.
- Optional cache (`MemoryDocsCache`, `FileDocsCache`): key = library id + version + query + language, hashed; the query is never
  stored; directory `0700`, files `0600`; TTL, size bounds, invalidation by library or entirely, hit/miss/eviction counters. Errors
  are never cached. With an API key answers may come from private libraries, so they are not cached unless `allowAuthenticated`.

## Evidence

Unit tests parse responses captured from the hosted service on 2026-10-19 (`test/fixtures`, see its README). Real-service tests
live in `apps/cli/test/context7-live.test.ts` and run only with `BFLOW_TEST_LIVE_CONTEXT7=1`.

## Not covered

Documentation caching beyond what Context7's own terms allow is the operator's responsibility. Lockfile support covers the
formats above only. OAuth, quota inspection and Windows are not implemented.

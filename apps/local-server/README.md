# @bflow/local-server

W00 buildable composition boundary, not a functioning server. No listener,
bootstrap, registry, workflow adapter or fabricated successful response is
implemented. W03 owns the secure HTTP foundation; W04 injects CLI lifecycle
services. Dependencies are apps/cli → apps/local-server → runtime; CLI is
never imported by this package. Contracts are frozen by D-WEB-01 (ADR 0006).

From repository root: `pnpm --filter @bflow/local-server build`,
`pnpm --filter @bflow/local-server typecheck`,
`pnpm --filter @bflow/local-server test`. Run `pnpm run build` before tests: the asset smoke needs both the server
entry and the web production assets/resolver, not just the server package build.
Tests establish package importability only, not HTTP or host readiness.

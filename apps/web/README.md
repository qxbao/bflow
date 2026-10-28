# @bflow/web

W00 Vite/React build skeleton and Node asset resolver. No W06–W08 UI,
web API, session pairing, commands or chat is implemented. The one browser
smoke proves production assets/contract import only; it is not visual design
compliance, live Herdr or SDLC acceptance. W06 must read docs/DESIGN.md and
apply the installed ui-ux-pro-max skill before building actual screens.

From repository root:

- `pnpm --filter @bflow/web build`: frontend typecheck, Node resolver, Vite assets.
- `pnpm --filter @bflow/web typecheck`: Bundler/JSX app and Node resolver.
- `pnpm --filter @bflow/web test`: dedicated `.test.tsx` jsdom tests.
- `pnpm --filter @bflow/web test:e2e`: Playwright production-asset smoke (build first; install Chromium with `pnpm --filter @bflow/web exec playwright install chromium` if unavailable; `BFLOW_WEB_TEST_BROWSER=/absolute/path/to/chrome` selects an existing local browser).

Frontend output is `dist/client`; `@bflow/web/assets` exports
`getWebAssetDirectory()` from `dist/node`. Only the Node resolver is in the
root tsc build graph. Browser code imports `@bflow/contracts/web`, never the
Node-bearing contracts barrel or `web-host`. No Vite API proxy or auth bypass
is configured. Dependency versions are exact in this package's manifest;
root pnpm@12.5.1 and Node >=22.13 are retained.

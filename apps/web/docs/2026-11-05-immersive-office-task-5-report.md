# Immersive office — Task5 local evidence

This report records implementation and evidence in the immersive-office worktree. The implementation baseline was `d1dd453dc15d52b8cd28324add694ab218435a4e` (`agent/web/immersive-office`). Core recovery work is committed as `23e23d1a`; the focused HUD fix and final root verification are on source HEAD `ee832641b0086e0a0b3a65a0c89b4609cbb09221`. This report-only update does not change that tested source. The feature flag remains off by default.

## Changes

- Added opt-in, per-project/per-tab chat and decision draft persistence. Restored decision snapshots pass the exported `WebDecisionSchema`; malformed snapshots are ignored while bounded reason text remains available. Storage reads/writes are guarded by `VITE_BFLOW_IMMERSIVE_OFFICE === 'true'`. Pending chat ID/session recovery remains in its existing `localStorage` record and no POST is replayed on mount.
- Made successful ACK/reconciliation clear only the submitted text with functional state updates. Handoff text is combined with the latest draft functionally; same-tick duplicate submits remain guarded by the synchronous in-flight lock.
- Fixed short-landscape dialogue recovery with a scrollable body and compact suggestion disclosure. Launch/read controls, the composer, and recovery remain reachable. The recovery status sits beside its action. Inactive dialogue has no backdrop.
- Added a projected Director label connector to the dialogue on wide screens. It is imperative, hidden when the label/dialogue is unavailable, hidden immediately when interaction closes, and removed on stage loss/unmount. It does not supply workflow evidence.
- Preserved TaskBoard `search` and `phase` URL filters, clarified that inbox counts are lower bounds when capped, and explained when a deep-linked decision is outside the loaded result.
- AppShell Escape handling now respects IME composition and retains flag-off Classic panel styling.

## Verification completed by this agent

Commands from the worktree root:

```sh
pnpm --filter @bflow/web exec vitest run --config vitest.config.ts --maxWorkers=2 --minWorkers=1
VITE_BFLOW_IMMERSIVE_OFFICE=true pnpm --filter @bflow/web build
VITE_BFLOW_IMMERSIVE_OFFICE=true BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web exec playwright test e2e/director-visual.spec.ts -g 'Immersive flag|short landscape'
```

- Web unit suite: **54 files, 560 tests passed**.
- Flag-on Web build: passed. Vite reports the existing >500 kB renderer chunk warning; no new dependency was added.
- Flag-on scripted Local Server/Chrome E2E: **2 passed**. It checks the Director dialogue and a server-committed POST with lost ACK; only the original message ID is reconciled, with no automatic resend or workflow command.
- The recovery scenario checks 375×812, 812×375, 768×900, 1099×900, 1100×900, 1440×900 and 1920×1080 for horizontal overflow and reachable close/read/launch/reconcile controls. It center-hit-tests those controls and the suggestion disclosure. Reduced motion uses Playwright media emulation. Touch uses Chrome DevTools Protocol touch emulation. “200% zoom” uses `document.documentElement.style.zoom = '2'`; it is a CSS zoom simulation, not physical browser zoom or a mobile keyboard test.
- Screenshot: `apps/web/dist/test-results/task9/14-office3d-landscape-lost-ack.png` (ignored output).

After the core commit, root's first broad flag-on run recorded **9 failed, 1 interrupted, 9 not run, 1 passed**. Triage found real HUD/guide overlaps, fixed in the HUD follow-up, plus legacy browser selectors that did not match the new review modal/card and composer layout. After the HUD fix, bounded Chrome checks passed: `office-a11y.spec.ts` **6/6**, `office-csp.spec.ts` **3/3**, and `office-recovery.spec.ts -g 'unknown_delivery|lost WebGL context'` **2/2**. The recovery/workflow E2E helper updates for the modal/card are present, but the full workflow scenarios were not rerun.

### Independent parent verification on source HEAD `ee832641`

- `pnpm check:deps`: passed, 24 packages / 54 edges.
- `pnpm typecheck`: passed.
- `pnpm --filter @bflow/web test --maxWorkers=2 --minWorkers=1`: passed, 54 files / 560 tests.
- `pnpm test:affected --base7009edf9 --run`: passed. The selector widened from the requested base because of `commit_mismatch`, scoped to `apps/web`; it printed 73 unit candidates and 0 root E2E candidates, and ran 17 files / 171 tests. The root Vitest config selects `.test.ts`; `.tsx` and browser suites are covered by the dedicated Web commands above.
- Default-off build and Chrome Classic/Office3D smoke: passed, 2/2.
- `git diff --check` and status: clean. The current follow-up commit changes only this report.

## Performance measurement

The parent ran `apps/web/scripts/measure-office.mjs` against the stable flag-on build from `23e23d1a` with 30 fixture agents, before the HUD-only follow-up. The final HUD follow-up was not performance-retested. Environment: Intel i5-12500 (12 threads), 15.3 GiB RAM, Linux `7.0.0-38`, Node `24.16.0`, Chrome `152.0.7977.82`, headless SwiftShader, viewport `1280×800`. The ignored JSON output is `apps/web/dist/immersive-office-measurement.json`.

| Measure | Result | Target / assessment |
| --- | ---: | --- |
| Whole-window moving frame rate | **5.44 fps** | 30 fps — **miss** |
| Fast camera burst frame rate | 33 fps, only 2% of frame gaps | Does not meet sustained 30 fps target |
| TaskBoard response | **207 ms** | 100 ms — **miss** |
| Active WebGL contexts | 1 | At most 1 — sampled pass |
| Contexts after close | 0 | 0 — sampled pass |
| Heap after forced GC, 0/5/10/15/20 toggles | 8.33 / 8.96 / 9.34 / 9.44 / 9.47 MiB | Small tail growth; this sample does not prove no continuous growth |
| Gzipped chunks / office assets | 176.2 KiB / 2.743 MiB | Informational |

The 5.44 fps whole-window rate covers the preset cycle, including 750 ms waits between camera presets, idle gaps and test automation time; it is not a continuous active-render-frame measurement. The full-cycle rate and TaskBoard response miss their targets. The 33 fps burst rate covers only 2% of gaps and is not used to claim a 30 fps pass. No renderer redesign or result cherry-picking was performed. Continuous active-frame and hardware-GL acceptance remain open.

## Remaining gates

- The owner chose handoff with open acceptance gates. No further live machine/provider setup, live workflow, or five-person study was authorized or performed for this handoff.
- Full platform fault acceptance still requires explicit evidence for every required stopped/offline/stale/session-change/unknown-operation, asset-failure and WebGL-loss case against the final bundle. The two Task5 browser cases above do not close that whole matrix.
- Manual physical browser zoom, mobile keyboard, assistive-technology and contrast review are not claimed here. No novice user study was run.
- No live provider, Herdr workflow or active connection-fault campaign was run. The isolated worktree lacks `.bflow/config.yml`; no machine/provider configuration was changed. Historical live evidence is outside this branch’s acceptance.

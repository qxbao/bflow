# Compact Tailwind UX implementation plan

> Execute directly in this session using executing-plans. Owner approved UX-IMPROVEMENTS.md and the dependency lockfile exception.

**Goal:** Preserve Bflow's identity while making every web screen compact, responsive and easier to operate.
**Architecture:** Tailwind Vite build and semantic theme; shared loading/pagination primitives; cursor history for server lists and bounded local pages for loaded collections. Existing authority and recovery code remains authoritative.
**Tech Stack:** React 19, React Router 7, Tailwind, Vite, Vitest, Playwright.
**Spec:** UX-IMPROVEMENTS.md.

## Constraints and review focus

Scope apps/web plus approved pnpm-lock.yaml. Keep palette/fonts/square hairlines. Desktop body 16px, page titles 28–32px, controls 36px; mobile controls >=44px and input text >=16px. No API/contracts change. Protect revision-bound decisions, mutation recovery, chat drafts and CSRF.

Review deep links without cursor history, background refresh with focus/drafts, review pagination while editing, mobile menu keyboard behavior, and long content at small widths/200% zoom.

## Tasks

- [x] 1. Theme/build and compact primitives: add Tailwind Vite plugin; replace raw layout styles with utility JSX and shared base styles, preserve local fonts. Files: package.json, vite.config.ts, styles/*, main.tsx, components/*.tsx. Verify package build and baseline tests.
- [x] 2. Navigation/loading: AppShell mobile disclosure, route focus and compact desktop layout; LoadingState skeleton only on initial read, background status otherwise. Test mobile open/close/navigation and retained content while refreshing. Files: AppShell.tsx, LoadingState.tsx, app.tsx, feature read consumers, test/ux.test.tsx.
- [x] 3. Lists: Pagination.tsx and pagination.ts shared helpers; projects search/12-item pages, runs cursor stack/query sync/retry preserving filters, review filter/10-item pages and same-run read deduplication with dirty-form protection, chat previous/next cursor while preserving composer. Test actual next/previous, deep links, browser history, empty filters and page clamping.
- [x] 4. Screen hierarchy: compact overview priority and supporting disclosures; run detail column layout; settings anchors/groups and compact role configuration with drafts preserved. Files: app.tsx, runs.tsx, settings.tsx, project-configuration.tsx, requests/decisions/chat. Verify existing form/recovery suite.
- [ ] 5. Validation/review: package build/typecheck/tests, dependency guard, affected selection and browser suite against built production assets. Extend browser checks for compact dimensions, pagination, mobile menu, zoom/reduced motion and long text; inspect screenshots. Update package README and measured evidence. Fresh reviewer checks final diff; fix material findings and rerun affected checks.

Strategy: recommended; test new interaction behavior, avoid tests that mirror utility class strings. Visual-only migration verified with existing behavior suite and browser render checks. No extra owner approval needed for implementation choices within approved design.

## Execution notes

Owner approval covers implementation plus Tailwind lockfile changes; execute inline
without another approval gate. Managed worktree on `agent/web/compact-tailwind-ux`.
A new checkout initially lacked contract dist files; root build resolved module
resolution before interaction validation. Tailwind 4.3.3 adds Vite optional peers
(jiti/lightningcss) in the lockfile. Dependency guard and root typecheck pass.

Independent code review identified browser-history draft loss, page-wide run-read
failure coupling and landscape/YAML control sizing. Fixes preserve in-memory pinned
drafts, isolate per-run errors and switch control density at 1024px. Targeted tests
cover history restoration and stale revision blocking. Rereview found no additional
important issues. An empty-track project-grid artifact found in screenshots was
fixed with auto-fit tracks. Confirmation cleanup returns focus to the trigger.

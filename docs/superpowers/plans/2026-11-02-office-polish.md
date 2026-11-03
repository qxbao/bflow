# Bflow Web 3D office polish and agent transcripts

Owner request (2026-11-02, in Vietnamese, paraphrased as requirements R1–R10):

- R1. Partition walls between the office zones.
- R2. Zone names on a sign board stuck on the wall (not floating labels).
- R3. A keyboard at every staff desk.
- R4. A brighter office.
- R5. More furniture and plants; the office should look beautiful.
- R6. Inactive staff have an unmistakable sleep effect, including "Zzz".
- R7. The chat/output of every staff member can be read in both Bflow Web (Classic) and Bflow Web 3D.
- R8. In 3D, a working staff member shows a message box with their thinking or last output.
- R9. The "Thao tác đã gửi" operations dock can be hidden, and is hidden by default (it is currently fixed on screen).
- R10. "Khởi động phiên" ignores dark mode (cream text on yellow); fix it and every similar styling bug. Pressing the "Toàn cảnh" camera button hides all open panels.

## Global constraints

- Work only in this worktree. Do not touch `.bflow/config.yml`. No push.
- UI copy is Vietnamese. Comment density and code idiom follow the surrounding file (apps/web source uses dense one-line style).
- `features/office/scene/**` imports no command/API code; `model/**` has no three.js/React (`test/office-boundaries.test.ts`). three.js stays behind the dynamic import.
- CSP is unchanged: no image files, `blob:` or workers. GLBs carry colours only. A `CanvasTexture` is allowed (the stage already uses one).
- `scripts/generate-office-models.mjs` stays deterministic, and total GLB size stays under 4 MiB.
- Budgets of ADR 0008 stand: at most 8 fps idle, 0 frames when hidden, no new per-frame allocation per label.
- Respect `prefers-reduced-motion` (`global.css` already disables CSS animations).
- Any text from an agent reaches the DOM only as text (`textContent`/React text). Never `innerHTML`.
- Tests on macOS: `TMPDIR=$(realpath "$TMPDIR")`. Web unit tests: `pnpm --filter @bflow/web test`. Web typecheck: `pnpm --filter @bflow/web typecheck`. Build upstream packages before tests that import `dist/`.
- Existing tests that pin old behaviour are updated only where the requirement changes that behaviour; never weaken an unrelated assertion.

## Task 1: Dark-mode colour pairs (R10)

Problem: `bg-brand text-ink` keeps yellow `--color-brand` in `.office-3d` but `--color-ink` becomes cream there, so primary buttons have cream text on yellow.

- `apps/web/src/styles/global.css`: add a token `--color-on-brand: #1a1a1a` in `@theme`; it is the same in `.office-3d` (no override needed, but state it there if the block lists all pairs).
- Replace `text-ink` with `text-on-brand` on every element that has `bg-brand`: at least `features/settings.tsx`, `features/run-actions/session.tsx`, `features/run-actions/index.tsx`, `features/project-configuration.tsx`, `features/decisions/index.tsx`, `features/requests/index.tsx`. Grep `bg-brand` across `apps/web/src` so none is missed.
- Audit the same class of bug: grep `apps/web/src` for fixed-colour utilities and arbitrary colours used with theme-dependent partners (`bg-[#`, `text-[#`, `bg-white`, `text-white`, `text-black`, `bg-black`, `border-black`). Fix each real light-on-light or dark-on-dark pair inside `.office-3d`. Also check `hover:` and `aria-pressed:` variants on those same buttons. Report what you checked.
- `test/office-contrast.test.ts`: add the `on-brand` on `brand` pair (>= 4.5:1). Add a source-scan test that no `apps/web/src` file has a class list containing both `bg-brand` and a bare `text-ink` (a `hover:` variant does not count).

## Task 2: Furniture models: bright palette, keyboards, new pieces, clearer sleep (R3, R4, R5, R6)

File: `apps/web/scripts/generate-office-models.mjs`, then regenerate `apps/web/public/office/*.glb` by running it.

Keep every existing node, material and clip name. Add:

- Bright palette for the shell: walls a warm off-white (`wall` about `#ece7dc`, `slat` about `#e0d9ca`, `trim` about `#b5ab97`), light oak for `wood`/`woodDark` (about `#cfa97c` / `#a9825a`), `metalDark` a mid grey that stays visible on light floors (about `#6d747e`), `cushion` a saturated teal (about `#3f8f8c`). `amber`, `amberSoft` emissive reduced so they do not read as dark-room LEDs. Lush greens for plants.
- Keyboards: on `desk` move the laptop slightly toward +z if needed and add, on the seated (-z) side of the desk top, a keyboard (dark tray plus 3 rows of light key strips, about 0.44 x 0.16) and a small mouse. Add the same keyboard to `counter`. It must not intersect the laptop base and must sit on the desk surface.
- New nodes (front faces +z, origin on the floor, one unit = one grid cell): `partition` (one cell wide wall segment, 1.3 high, 0.16 thick, centred on z=0, off-white body with a darker base and a light cap), `partition_end` (a slim square post 1.35 high for the ends of a wall run), `sign_board` (dark frame 1 x 1 unit that the scene scales; 0.03 thick; the text plane is added by the scene), `sofa` (2 cells wide), `armchair`, `coffee_table`, `rug` (flat, 3 x 2, thin), `bookshelf` (1 wide, 2.1 high, with coloured book blocks), `water_cooler`, `floor_lamp`, `printer` (on a low cabinet), `whiteboard` (wall mounted, 2 wide, with coloured note blocks), `window` (wall mounted, 2 wide, 1.7 high, emissive sky-blue panes with mullions), `pendant_lamp` (hung shade with emissive bulb, origin at the shade), `plant_tall` (large pot, tall tree form), `plant_small` (desk sized succulent), `wall_art` (framed colour blocks).
- Materials you add follow the existing `M(name, colour, options)` form; add a light floor material only if `floor` no longer suits instancing (the floor is tinted per zone by instance colour, so keep `floor` white).
- Character clip `sleep`: make the pose unmistakable: head dropped far forward (about 52 degrees) and tilted, torso slumped forward (about 22 degrees), arms resting toward the desk, slow breathing motion. The whole character must not sink through the desk: keep the head above desk height.

Tests: add to `test/office-assets.test.ts` (or a new `test/office-models.test.ts`) a check that parses the real GLB JSON chunk and asserts all the new node names exist, the nine clips exist, no image/texture entries exist, and the two files total under 4 MiB. Assert running the generator twice gives identical bytes if that is cheap (write to a temp dir is not supported by the script today, so comparing is optional).

## Task 3: Layout: partitions with doorways, wall signs, decor, bright lighting (R1, R2, R4, R5)

Files: `features/office/scene/world.ts`, `features/office/scene/stage.ts`, `features/office/scene/renderer.ts` (background, exposure, hemi values, zone labels), `features/office/ui/OfficeStage.tsx` (host background class), tests. Uses the nodes from Task 2.

Layout (pure data in `world.ts`, so it is unit-testable):

- Partition walls run on the existing corridor cells, each wall on the cell centre line:
  - Horizontal: row `gy = 8`, `gx` 1..27, doorway gaps at `gx = 4`, `gx = 13`, `gx = 23`.
  - Vertical back: column `gx = 8`, `gy` 1..7, doorway gap at `gy = 5`; column `gx = 18`, `gy` 1..7, doorway gap at `gy = 5`.
  - Vertical front: column `gx = 18`, `gy` 9..18, doorway gap at `gy = 12`.
  - Export `PARTITION_CELLS` (the wall cells) and `DOORWAY_CELLS`. Partition cells block `routeBetween`. Draw with instanced `partition` segments (rotated for vertical runs) and `partition_end` posts at run ends and doorway jambs.
- Move what collides with those lines: `cabinet` to `(7,0)`, `server` to `(17,0)`, `settings` to `(19,9)`, plant `(18,7)` to `(17,7)`, plant `(27,8)` to `(27,9)`. Keep every seat where it is. The Developer zone desks, chairs and seats must not change.
- The Developer room walls are fixed (the room does not shrink with `developerRows`); `zones(rows)` may still cut the Developer floor rectangle, but draw its floor tint for the whole room so walls never enclose lobby-coloured floor.
- Every seat and every object's adjacent cell must remain mutually reachable with every desk drawn. Add a test: with all seats occupied, `routeBetween` finds a route between every pair of seats (pass seats as endpoints), and no route passes through a `PARTITION_CELLS` or decor cell.

Signs:

- `ZONE_SIGNS` in `world.ts`: one per zone, text identical to the existing `ZONE_TITLES` text, with a world position and width. Back rooms: on the north wall above head height (`z` about 0.14, `y` about 3.0): Conversation over `x = 4.5`, Coordinator over `x = 13.5`. Task Board: on the top frame of the hero board (`x = BOARD_X`, `y` about 3.4, `z` about 0.32). Front rooms: on the horizontal partition facing south, standing proud of the wall (`y` about 1.15, `z` about 8.62): Developer Zone over `x = 9.5` (clear of the doorway at `gx = 13`), QA / Reviewer over `x = 21` (clear of the doorway at `gx = 23`).
- Stage draws each sign as a `sign_board` scaled to size plus a plane in front with a `CanvasTexture`: cream text on the dark board, uppercase, bold `IBM Plex Sans`/system-ui, sized to fit, using a `MeshBasicMaterial` with `toneMapped: false`. Canvas 2x-sized for sharpness. Redraw once when `document.fonts?.ready` resolves if the font was not ready. Textures and materials are disposed in `Stage.dispose`. If `getContext('2d')` is null (jsdom) nothing throws.
- Remove the floating zone labels: `projectLabels` no longer emits `kind: 'zone'` labels. Keep `ZONE_TITLES` as the single text source (signs read it), and keep the `kind: 'zone'` styling path in `labelLayer` only if a test needs it; otherwise remove it and update tests. `aria` is unaffected: the DOM mirror holds the truth.

Decor (`DECOR` list in `world.ts`: `{ node, cell, ry?, blocks? }`, drawn by `Stage`, with repeated nodes instanced; a decor item that stands on the floor blocks its cells, wall-mounted and ceiling items do not). It must not overlap any seat, desk footprint (desks are 1.5 wide, chair at -z), object, doorway or doorway approach. Suggested placement, adjust if a test finds overlap:

- Conversation (x 1..7, y 1..7): lounge at the south: `rug` under `sofa` at `(2,6)`, `coffee_table` `(4,6)`, `armchair` `(6,6)`; `floor_lamp` `(7,7)`; `bookshelf` on the north wall `(2,0)`; `window` on the north wall `(5,0)`.
- Coordination (x 9..17): `whiteboard` on the north wall `(11,0)`; `window` `(15,0)`; `plant_tall` `(9,1)`; `bookshelf` `(16,0)`.
- Task Board (x 19..27): `plant_tall` `(19,1)` and `(27,1)`; `armchair` `(20,6)` and `(26,6)`.
- Developer (x 1..17, y 9..18): `plant_tall` `(1,9)` and `(17,9)`; `water_cooler` `(1,12)`; `printer` `(17,12)`; `bookshelf`-free west wall art: `wall_art` on the west wall at `(0,13)`.
- Verification (x 19..27, y 9..18): `plant_tall` `(19,17)`; `coffee_table` `(26,16)`; `plant_small`/`wall_art` where free; `wall_art` on the east wall `(28,12)`.
- `pendant_lamp` at about `y = 2.9` above room centres (no blocking; they must not hide a character's head from the camera, so keep them few: one per room, off the desks' lines). `plant_small` as decoration on the coffee tables. Existing `PLANT_CELLS` stay.

Brightness:

- `BACKGROUND` a soft light tone (about `#dfe5e6`); fog matches it and is lightened so far walls do not grey out. `OfficeStage` host class background follows.
- `FLOOR` light tints per zone (warm oak, pale blue-grey, pale mint and so on), each distinct but all light. Lobby a neutral light tone.
- Lights: hemisphere about `#ffffff`/`#d9cfc0` at high intensity, key light white-warm at about 2.2, shadows soft. `applyQuality` low tier stays readable. Closed-session exposure dims the office but keeps furniture visible (about 0.6). Tune so nothing clips to pure white: the existing additive beams, pools and desk glows are designed for a dark room, so cut their opacity to about a quarter, or remove the wall beams. LED floor trim is dimmed to a subtle tone.

Tests: update `test/office-camera.test.ts`/`office-stage` expectations that pin moved objects or zone labels. Add `test/office-layout.test.ts`: decor cells inside the grid, no overlap between decor, seats, objects, doorways; signs inside the grid and one per zone; reachability from above.

## Task 4: Hideable operations dock and overview closes panels (R9, R10)

Files: `features/office/ui/OfficeHud.tsx`, `features/operations/index.tsx`, `src/app.tsx`, tests.

- `features/operations/index.tsx`: add and export `useOperationsDockSummary(): { count: number; attention: boolean }`. `count` is the number of tracked observations; `attention` is true when the error banner is present or any observation is unsettled and uncertain (`reconciliation_required`, or `failed`). It must not change `OperationsDock` output or Classic's inline dock.
- `OfficeHud`: new prop `dockSummary: { count: number; attention: boolean }`. New local state `dockOpen`, default `false`. The dock container stays mounted (so nothing is lost and live regions keep working) but uses the `hidden` attribute while collapsed. Add a toggle button in the bottom block, `aria-expanded`, `aria-controls`, text `Thao tác đã gửi` with the count; it is shown when `count > 0` or `attention`. `attention` adds a visible warning style plus sr-only text (`Có thao tác cần xem`), and never auto-opens the dock. Toggling works on phones while the panel is open. Measured dock height keeps working (`onDockHeight`).
- Pressing the `overview` camera button (`Toàn cảnh`) closes every open panel: in `src/app.tsx`, `Frame` gains `closePanels` (the existing `close` callback, which already respects `closable`, so the re-pair view stays). `onFocusZone` for `overview` calls it, and the HUD collapses the dock in the same click. The camera ease starts after the closing commit, with the closed inset (`insetFor(false)`), so the office centres in the full view: apply the inset, then call `focusZone`, from a `setTimeout(0)` or an effect, guarded against unmount. Other zones behave as today.
- Keep the rest of the HUD (top panels, rail, camera bar, chat bar) visible; they are the way back.

Tests: extend `test/office-hud.test.tsx` (collapsed by default, toggle, `hidden`, attention text, no toggle when empty, overview collapses it) and `test/office-parity.test.tsx` or `office-mode.test.tsx` for `Toàn cảnh` closing a route panel and an inspector, and not closing the re-pair view. Update any e2e or unit test that expected the dock visible by default (`e2e/office-*.spec.ts`) so it expands first.

## Task 5: Backend: agent transcript and excerpt read ports (R7, R8)

Reads a terminal snapshot of an agent pane through Herdr and exposes it read-only. This is a deliberate, owner-requested additive contract change; the ADR amendment is part of this task.

Contracts (`packages/contracts/src/web.ts`, additive only):

```ts
export const WebAgentExcerptSchema = z.object({ instanceId: id, text: z.string().min(1).max(600), observedAt: time }).strict();
export const WebWorkforceExcerptsSchema = z.object({ apiVersion: version, projectId: id, sessionId: id, items: z.array(WebAgentExcerptSchema).max(100), observedAt: time }).strict();
export const WebAgentTranscriptSchema = z.object({ apiVersion: version, projectId: id, sessionId: id, instanceId: id, source: z.literal("terminal_snapshot"), text: z.string().max(64000), truncated: z.boolean(), observedAt: time }).strict();
```

- Export their types. `UserInteractionClient` gains optional `readWorkforceExcerpts?(projectId)` and `readAgentTranscript?(projectId, instanceId)`.
- `WebHttpContracts` gains `workforceExcerpts` (GET `/api/v1/projects/:id/workforce/excerpts`) and `agentTranscript` (GET `/api/v1/projects/:id/agents/:instanceId/transcript`), both no body, no query, 200. `WebHttpPathParamsSchema` gains `instanceId: id.optional()`.
- Update the `D-WEB-03` comment above the schemas: the workforce view still carries no pane, cwd, worktree, session metadata, token or RoleMessage payload; the transcript routes carry redacted terminal text only.

Runtime:

- `packages/runtime/src/interaction/workforce.ts`: export `instanceIdOf(bindingId)` and use it in the projection, so the id has one definition.
- New `packages/runtime/src/interaction/transcript.ts` (pure parts unit-tested):
  - `cleanTerminalText(raw)`: strips ANSI/control sequences and trailing spaces, keeps line breaks.
  - `excerptOf(cleanText)`: the last meaningful output: drops blank lines, lines that are only box-drawing or ornament characters, input prompt lines (`>`, `❯`, `›` with or without placeholder text), and provider status/footer hints (permission mode lines, `esc to interrupt`, `ctrl+`, `shift+tab`, `? for shortcuts`, token and context percentage footers). Takes the last up to 4 lines, joined by `\n`, cut to 600 UTF-16 safe chars keeping the tail. Empty result yields `undefined`.
  - `readWorkforceExcerpts` and `readAgentTranscript` take `{ manifest, state, sessionId, projectId, observedAt, redact, readPane }`.
  - Excerpts cover active panes with open work, panes whose `transportState` is `working`, plus the Conversation pane; bounded to 4 concurrent pane reads, reading `--lines 60`. A pane read that fails is omitted (never fails the page). Apply the strict `redact` (the one that also removes paths) to the text before cutting.
  - Transcript resolves `instanceId` among listed panes (same listing rules as the workforce, released-too-long excluded). Unknown id: `{ ok: false, error: { code: "not_found", retryable: false, message } }`. Reads `--lines 400`. A read failure of a released or lost pane returns `unavailable` with a safe message, and never a raw error. Text keeps the tail when longer than 64000 chars and sets `truncated`.
- `views.ts`/`schemas.ts`: new private query kinds `workforce_excerpts` and `agent_transcript`, parsed with the exported schemas. `hostInteractionQuery` options gain optional `readPane(paneId, lines)`; without it these kinds answer `operation_not_allowed`.
- `host.ts`: pass `readPane` built on the host's `herdr(["pane","read",paneId,"--source","recent","--lines",String(lines),"--format","text"])` and check the `herdr` helper's existing deadline applies. Cache excerpt results in the host closure for 2 seconds so several browser tabs do not multiply subprocesses, with a single in-flight read shared. Do NOT add these to `webProjectionFingerprint`: output changes must not produce `invalidate` events.
- `client.ts`: add both methods with exported-schema parsing, following `readWorkforce`.

Local server (`apps/local-server/src/routes.ts`): both routes follow the `workforce` block: missing port is `operation_not_allowed`, response parsed by an `OperationResultSchema`, `projectId` mismatch is `unavailable`, transcript `instanceId` mismatch is `unavailable`. Same cookie/Origin checks as other GET routes.

ADR: add an "Amendment 2026-11-02: agent terminal transcripts" section to `docs/adr/0008-web-workforce-projection.md`, stating: motivation (owner asked to read every staff member's output in Classic and 3D, and to see a live message box), the two routes, that terminal text now leaves the host and what that does and does not change (`RoleMessage` payloads still do not; pane ids, cwd and tokens still do not), redaction rule, that the text is an unverified terminal snapshot and never task evidence, `correlationVerified`-style caveat, compatibility (optional ports, old backend answers `operation_not_allowed`), rollback, and evidence level (source and local tests only unless a live probe is recorded). No approver name or verbatim wording.

Tests: `packages/runtime/test/interaction/transcript.test.ts` (clean, excerpt filtering with realistic Claude Code and Codex footers, redaction of a token and an absolute path, unknown id, failure isolation, concurrency bound), and `apps/local-server/test/workforce.test.ts` additions modelled on the existing cases (cookie required, foreign origin, missing port 422, exact ids, upstream extra field `paneId` rejected and mapped to 503 with no leak).

## Task 6: Read every staff member's chat, Classic and 3D (R7)

Depends on Task 5. Files: `apps/web/src/api/client.ts`, new `apps/web/src/features/agents/index.tsx`, `src/app.tsx`, `components/AppShell.tsx`, `features/office/ui/AgentInspector.tsx`, `features/office/ui/OfficeHud.tsx`, tests.

- `client.ts`: `readWorkforceExcerpts(id)` and `readAgentTranscript(id, instanceId)` with the exported contracts.
- `features/agents/index.tsx`:
  - `AgentTranscript({ api, projectId, instanceId })`: reads on mount, then every 5 s while mounted and the document is visible (no overlapping reads). Renders the text in a `role="log"` scroll box with `tabIndex=0`, monospace, `whitespace-pre-wrap`, `[overflow-wrap:anywhere]`, follow-bottom only while the reader is at the bottom (same technique as `features/chat/index.tsx`). A note under the heading: `Bản chụp màn hình terminal của nhân viên, đã che thông tin nhạy cảm. Có thể thiếu và không phải bằng chứng hoàn thành công việc.` A truncated notice when `truncated`. A clear state for `not_found`/`operation_not_allowed` (`Máy chủ chưa cung cấp nội dung của nhân viên này.`), other errors (`Chưa đọc được nội dung. Điều này không cho biết nhân viên đang rảnh.`) keeping the last good text, and empty (`Nhân viên chưa có nội dung nào.`).
  - `AgentsPage({ api, id, revision })`: route `/projects/:projectId/agents`, optional `?agent=<instanceId>`. Reads the workforce with `useRead`. A list of agents (display name, role via `roleLabel`, status from transport plus open work count), a selected transcript beside it on wide screens and stacked on phones. Default selection is the first agent with open work, else the first. Works in Classic and inside the 3D overlay panel, with only design tokens. Handle no session / no workforce with the same language Classic uses.
- Routes and navigation: route in `src/app.tsx`; `Nhân viên` in `AppShell` nav after `Trò chuyện`, in the mirror `list`, and a rail button in `OfficeHud` (`onNavigate` accepts `'agents'`, with a suitable icon path). Update the parity table test if it lists rail entries.
- `AgentInspector`: add a section `Nội dung gần đây` containing `AgentTranscript` for the agent (height bound so the inspector still scrolls), and a link `Xem tất cả nhân viên →`.
- `AgentList`-style text stays as is.

Tests: new `test/agents-page.test.tsx` (list renders, selection via query, transcript shown as text with an injected `<img>` string left inert, polling stops on unmount, unsupported state, error keeps last text), `office-inspector` addition. `test/fixtures` `installApi` extended as needed; do not change other tests' behaviour.

## Task 7: In-scene Zzz and message boxes (R6, R8)

Depends on Tasks 3, 5, 6. Files: `features/office/scene/renderer.ts`, `features/office/ui/labelLayer.ts`, `features/office/ui/OfficeStage.tsx`, new `features/office/ui/useAgentExcerpts.ts`, `src/app.tsx`, `styles/global.css`, tests.

- `ProjectedLabel.kind` gains `'bubble'` and `'sleep'`. Renderer gains `setExcerpts(map: ReadonlyMap<string, string>)`, which stores the map and marks dirty and wakes. In `projectLabels`, using the existing pools (no per-frame allocation per label):
  - `sleep` for every agent with pose `sleeping`: text `Zzz`, anchored above the head. Always shown when the anchor is in the safe area, regardless of overlap.
  - `bubble` for every agent with pose `working`, `typing` or `preparing`: text is the excerpt if present, else `statusText`, anchored above the name tag. At overview zoom (`state.zoom < 1.8`), a bubble that would overlap an earlier one is hidden (use the same rect list, with a bubble-sized rectangle of about 224 x 72 px); closer in everything shows.
- `labelLayer`: classes per kind. `bubble` uses `data-kind="bubble"` and class `office-bubble`; `sleep` uses `data-kind="sleep"` and class `office-zzz`. Elements hold only text (no child elements: `e2e/office-security.spec.ts` asserts `[data-kind] *` is empty). Keep the existing rule that unchanged positions write nothing. Anchors for `agent`, `bubble`, `sleep` are bottom-centre.
- `global.css`: `.office-bubble`: readable on the bright scene: `bg-surface/95`, `border-line`, `text-ink`, `max-width: 14rem`, 3-line clamp, `white-space: pre-line`, small text, rounded, a tail via `::after`. `.office-zzz`: large bold (about 1.25rem), accent coloured with a dark text shadow so it is visible on a light floor, animated by a looping float-and-fade keyframe. Animate the individual `translate` and `opacity` properties, never `transform`, because `labelLayer` writes `transform` for position. Reduced motion already stops it and the text stays visible.
- `useAgentExcerpts({ api, id, enabled })`: polls `api.readWorkforceExcerpts` every 4 s while `enabled` and the document is visible, with no overlapping reads; `operation_not_allowed`/`not_found` stops polling for this mount; a failed read keeps the last map for at most 30 s and then clears it. Returns a stable `Map`, replaced only when contents change.
- `OfficeStage`/`StageControl`: `setExcerpts`, remembered for a renderer created later (same as `inset`). `VisualOffice` in `src/app.tsx` enables the hook when `model?.tier === 'full'` and pushes the map. Excerpts stay outside `OfficeModel`, so `diffVisual` is unaffected. `scene/**` still imports no API.

Tests: `test/office-stage.test.tsx` label layer cases (kinds, classes, no child elements, `<img>` text inert), a new `test/office-excerpts.test.tsx` for the hook (fake timers, no overlap, stop on unsupported, expiry, stable map). A renderer-level test of label selection if the existing stage test harness allows; otherwise extract the pose-to-label choice into a small pure helper in `model/` and test that. e2e `office-a11y` label overlap check must still pass: bubbles are excluded or the check scoped to `agent` labels, with a reason noted.

## Task 8: Docs and full verification

- `apps/web/README.md` "Visualization mode" section: walls and signs, canvas text exception, Zzz and message boxes, dock collapsed by default, `Toàn cảnh` closes panels, `Nhân viên` page, terminal snapshot caveat. `apps/local-server` README if it lists routes. Amend the ADR 0008 line about labels being DOM text, noting zone signs are canvas text (mirror still holds the truth).
- `AGENTS.md`: one sentence in the 3D/Web context about transcript routes; only the fact and evidence level.
- Run and report: `pnpm check:deps`, `pnpm typecheck`, `pnpm test:affected --base 42b526eb --run`, `git diff --check`, `git status --short`. Compare failures against the documented macOS baseline. Fix regressions; report baseline failures as baseline.

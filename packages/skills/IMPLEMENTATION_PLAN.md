# P28 approved scope and acceptance plan

Owner request authorizes implementation of the P24 skills design. Baseline a39374d
retains P24 8dbb056; public schemas remain unchanged. Only packages/skills and skills
are changed. No database migration, provider-home changes, CLI parser changes or
root build/lock changes are included.

1. Implement strict SKILL.md / skill.json validation, complete bounded content hashing,
   local reference checks, unsupported command rejection, and immutable private storage.
2. Implement exact-pin catalog install/update/list, trusted approval checks, dependency
   resolution, role/provider/capability/tool authorization and deterministic manifests.
3. Render metadata/reference-only provider manifests with selected on-demand bundles;
   retain role prompts and policy precedence. Export setup synchronizer and repository
   config helpers for integration owners; never imply nonexistent CLI handlers run.
4. Ship all shared and role skills with realistic local examples and complete metadata.
5. Exercise malformed metadata/references/commands, duplicate names, provider equivalence,
   authorization/stale approvals, immutable updates, preserved config and recovery.
6. Run package checks plus required repository checks and commit owned changes.

Acceptance: all 20 shared IDs and every requested role binding exist; model neutral
bundles use standard name/description frontmatter. No skill executes hooks, grants
permissions, waives Conditional TDD or permits specialist direct user questions.
Machine catalog bytes and session manifests are immutable. Required unavailable content
blocks resolution. Live sessions continue using old pins after update. Provider output
contains only selected names/descriptions/entrypoints and manifest identity, never the
whole instruction library. Runtime keeps independent gates and authenticated decisions.

Implementation policy: required failing tests first for resolver/storage behavior;
content-only examples use structural validation. Full Runtime/CLI activation belongs to
P29/P30 and is explicitly documented as an integration dependency.

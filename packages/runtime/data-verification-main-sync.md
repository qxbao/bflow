# DC-01 integration with updated main and delivery

The owner requested pulling current main and resolving conflicts, then explicitly requested merging into `duc` and opening a PR to main. That later delivery instruction authorizes the necessary source commit/push/PR; earlier no-commit records in the design/review documents describe those earlier handoff stages.

## Main synchronization

- Previous base: `2041d7efa860981833eb6bd58fd9023ce8a727d3`.
- Fetched integration base: `20a38a5ebdfaf8fcc81744d913767f5184cab119` (`origin/main`),35 commits ahead and an ancestry descendant. No shared history was rewritten.
- Saved all38 modified/untracked files, hashes, tracked/index patches and complete file archive in `/tmp/bflow-main-sync-7gg6esq1`; temporary stash `d782560944807f0bded6cfef26aef4458f83e13e` preserves the same WIP.
- Fast-forwarded the DC-01 worktree, restored WIP and resolved the only conflict, at the end of `packages/runtime/src/index.ts`. Both web/interaction exports and DC-01 exports remain. README auto-merged; its upstream content and DC-01 section remain.
- Verified all38 files restored, all36 non-overlap files byte-identical, and both overlap files preserve upstream as a prefix. Index/unmerged entries cleared; feature changes were returned to their original unstaged state before validation.
- Independent reviewer found no lost exports/content or semantic collision in this conflict resolution.
- Frozen lockfile install succeeded. No local edits to root configuration, pnpm lockfile or exported contracts were made; those upstream changes were adopted from main exactly.

## Validation on integrated source

Node22.23.2, pnpm12.5.1. The build now includes the upstream web application. Source/test/skill freeze:30 files, digest `f507d7c1a89d7c082ac9334f4745be228b59af7e222a789257d56763d14f7c51`, `/tmp/bflow-dc01-main-sync-source-freeze.json`. Tests identify main base plus this exact WIP; subsequent documentation does not change executable inputs.

| Command | Exit | Results |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | 0 | Updated ignored dependencies for25 workspace projects; lockfile unchanged |
| `pnpm check:deps` | 0 | 24-package/52-edge acyclic graph and import boundaries |
| `pnpm typecheck` | 0 | Workspace plus upstream web typecheck |
| `pnpm build` | 0 | Workspace plus production web bundle |
| Targeted data/skills/local-server/interaction/structured Conversation tests | 0 | **30 files,286 passed,0 failed/skipped**,33.36s |
| `pnpm test:web` | 0 | **1 file,2 passed,0 failed/skipped** |
| `pnpm test:affected --base 20a38a5ebdfaf8fcc81744d913767f5184cab119 --run` | interrupted | Owner explicitly waived further full validation and requested immediate merge/push/PR. The running process group was stopped; no aggregate full PASS is claimed. Selection424 unit inputs/21 E2E inputs. `/tmp/bflow-dc01-main-sync-affected.log` |
| Final full E2E | not run | Owner explicitly waived further full validation for this delivery |
| Final diff/index/working tree checks | 0 | Conflict resolution complete; no unmerged entries; diff whitespace check passed |

The full checks use the upstream W03 documented fixture-isolation environment: remove inherited AI_ISOLATOR/AI_ISOLATOR_PROFILE/AI_ISOLATOR_REAL_HOME/AI_ISOLATOR_TOOL/AI_ISOLATOR_HOME for the child test process, TMPDIR=/tmp, real fixture dbt enabled, max4/min1 thread/fork pools. No such external selectors were present in this session; no persistent/global environment was changed. The E2E follow-up uses max2/min1 pools to avoid the recorded load-sensitive catalog deadline. Assertions, test timeouts, data thresholds and verification policy are unchanged.

Raw targeted logs: `/tmp/bflow-dc01-main-sync-targeted.log`, `/tmp/bflow-dc01-main-sync-web.log`. The previous baseline host and integration/systemd timing findings remain historical evidence, not an assertion that the updated main run is green. The interrupted full run observed the previously recorded host readiness assertion; it is not a completed full-suite result.

## Scope

Data contract/gate/fixture/skills behavior is unchanged by the main conflict resolution. The source remains an opt-in Runtime library using Linux Bubblewrap and real dbt/DuckDB snapshot measurements, with explicit approval/schema/snapshot pins. No daemon/CLI data command, arbitrary candidate SQL or warehouse/live workflow acceptance is claimed. Existing fixture model revision labels remain2041d7e provenance labels; they do not assert execution of a transformation from the new host software revision.

The owner explicitly instructed: "skip ... merge thẳng vào duc ... tạo pull request ... không cần chạy full validation nữa". This supersedes repository full-suite requirements for this delivery only. Completed targeted286/286 and web2/2 checks, dependency/type/build checks and conflict-resolution review are retained; no assertion or timeout was weakened.

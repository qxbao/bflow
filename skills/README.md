# Bflow canonical skill library

This pack contains 32 instruction-only skills. The canonical source for each skill is
`SKILL.md` plus its `skill.json` and every declared referenced resource. Native skill
frontmatter contains only `name` and `description`; Bflow metadata lives in the adjacent
JSON document. Provider adapters publish from this single source rather than maintaining
three divergent copies.

Load a resolved role manifest and the one skill/reference needed for the next task.
Do not paste the whole library into a prompt. The original role personality and prompt,
accepted project policy, Runtime enforcement, specification acceptance, Conditional TDD,
independent gates and human authority always retain precedence. External skill packs,
including Superpowers, cannot make TDD unconditional or waive required Red-first evidence.

## Source format and integrity

Each `skill.json` declares content version, allowed roles, supported providers, exact
dependency pins and required capability/tool IDs. The name/description come from
frontmatter; role guidance, prerequisites, triggers, inputs/outputs and command requirements
are in the SKILL.md body. Local Markdown links identify example resources to inventory.
The complete sorted path/content-digest inventory is the approval unit, including
metadata and example resources. Do not substitute an independently hashed entrypoint.
Resources are instruction content, never install/postinstall hooks. Content changes need
a new reviewed version/digest and invalidate approvals/readiness; live sessions keep their
existing immutable manifest generation. A display label or provider version never proves
that native skill discovery or rendering is supported by an installed CLI.

`roles/bindings.json` is an explicit selection recipe, not a `SkillManifest` or an approval.
The resolver must turn selected skills into exact approved pins and session-scoped public
bindings using the exported contracts. Analyst maps to `specifier`; QA/Verifier maps to
`qa` and `tester`. Security has an explicit independent binding. Other allowed skills can
be selected only through approved configuration; an allowed-role declaration grants no
new tool capability. A selected required skill whose tools are unavailable blocks readiness.

## Provider publishing and lifecycle

Machine setup owns approved catalog installation; repository init owns desired repository
skill selections; Runtime owns immutable session manifests. Package-local SkillManager
operations support list, validate, install, sync, link, verify and update. They do not
silently edit Claude/Codex/Agy user-global settings or perform tool installation.
Provider rendering produces scoped manifests and reference assets for a separately
verified launch adapter. Mark unsupported provider launch surfaces unsupported instead of
claiming native CLI conformance from text rendering tests. Loading these instructions is
not proof they were followed, or that a task passed verification.

The baseline CLI currently exposes `init`, `up`, `down`, `attach`, `doctor`, `recover`,
`run`, `status`, `approve`, `resume`, `cancel` and help. It has no dedicated skills, setup,
Git workflow or verification subcommand. Skill examples use actual help/status/doctor
observations and existing authorized host capabilities; they do not invent future commands.
`bflow recover` only handles an empty legacy lifecycle lock and does not reconstruct task
receipts. Recording a human approval is never authorized merely because `approve` exists.
P26/P29/P30 owners must integrate setup/init/Runtime composition separately.

## Optional tool prerequisites

The specialized skill requirement IDs `gitnexus`, `rtk`, `claude-mem` and `browser` must
resolve against an operator-approved actual tool inventory. They are catalog requirement
names, not proof that a service is installed or healthy, and not guessed MCP method names.
GitNexus and memory use discovered authorized schemas; RTK remains CLI-only. Browser work
requires the correct scoped resource lease and fence when the instance/profile is exclusive.
No skill starts duplicate workers, mutates global provider settings or installs a tool.

## Catalog

| Category | Skill | Supported roles |
| --- | --- | --- |
| browser | [browser-inspection](browser/browser-inspection/SKILL.md) | tester, qa, reviewer |
| core | [inspect-repository](core/inspect-repository/SKILL.md) | coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security |
| core | [understand-task](core/understand-task/SKILL.md) | conversation, coordinator, specifier, planner, architect |
| core | [using-bflow](core/using-bflow/SKILL.md) | conversation, coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security |
| git | [integrate-changes](git/integrate-changes/SKILL.md) | coordinator |
| git | [use-git-worktree](git/use-git-worktree/SKILL.md) | developer, coordinator, planner |
| implementation | [fix-review-findings](implementation/fix-review-findings/SKILL.md) | developer |
| implementation | [implement-task](implementation/implement-task/SKILL.md) | developer |
| operations | [escalate-blocker](operations/escalate-blocker/SKILL.md) | conversation, coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security |
| operations | [recover-execution](operations/recover-execution/SKILL.md) | coordinator, developer, tester, reviewer, qa, security |
| operations | [report-task-result](operations/report-task-result/SKILL.md) | coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security |
| roles | [agent-delegation](roles/agent-delegation/SKILL.md) | coordinator |
| roles | [escalation-resolution](roles/escalation-resolution/SKILL.md) | coordinator |
| roles | [report-progress](roles/report-progress/SKILL.md) | conversation |
| roles | [request-approval](roles/request-approval/SKILL.md) | conversation |
| roles | [workflow-orchestration](roles/workflow-orchestration/SKILL.md) | coordinator |
| sdlc | [architecture-analysis](sdlc/architecture-analysis/SKILL.md) | architect |
| sdlc | [conditional-tdd](sdlc/conditional-tdd/SKILL.md) | coordinator, planner, developer, tester, qa, reviewer |
| sdlc | [dependency-planning](sdlc/dependency-planning/SKILL.md) | planner, coordinator |
| sdlc | [design-review](sdlc/design-review/SKILL.md) | architect, reviewer, security |
| sdlc | [requirements-analysis](sdlc/requirements-analysis/SKILL.md) | specifier |
| sdlc | [specification-driven-development](sdlc/specification-driven-development/SKILL.md) | specifier, architect, coordinator, planner |
| sdlc | [task-decomposition](sdlc/task-decomposition/SKILL.md) | coordinator, planner |
| tooling | [mcp-tool-discovery](tooling/mcp-tool-discovery/SKILL.md) | conversation, coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security |
| tooling | [use-claude-mem](tooling/use-claude-mem/SKILL.md) | coordinator, planner, architect, specifier, developer, tester, reviewer, qa, security |
| tooling | [use-gitnexus](tooling/use-gitnexus/SKILL.md) | specifier, architect, planner, developer, reviewer, security |
| tooling | [use-rtk](tooling/use-rtk/SKILL.md) | developer, tester, qa, reviewer |
| verification | [analyze-failure](verification/analyze-failure/SKILL.md) | developer, tester, reviewer, qa, security, coordinator |
| verification | [review-code](verification/review-code/SKILL.md) | reviewer, security, architect |
| verification | [run-verification](verification/run-verification/SKILL.md) | coordinator, developer, tester, reviewer, qa, security |
| verification | [security-review](verification/security-review/SKILL.md) | security, reviewer |
| verification | [test-planning](verification/test-planning/SKILL.md) | tester, qa |

## Worked examples

Every skill has a `worked-example.md` bound into its content inventory. A typical flow
loads understand-task for Conversation, specification-driven-development for Specifier,
task-decomposition for Coordinator/Planner, implement-task and conditional-tdd for Developer,
then run-verification and independent review-code/test-planning for Reviewer/QA. Failure
routes to analyze-failure and a Runtime-authorized fix-review-findings assignment within
the existing iteration budget. These are reference instructions, not an executable skill
chain or another workflow engine.

Every specialist routes missing information, permissions and approvals through
Runtime → Herdr → Conversation. Do not open native direct user questions or elicitation.
All examples preserve waiting state until an authenticated current answer arrives.

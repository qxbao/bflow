# @bflow/skills — P28 reusable instruction framework

Implements `SkillManager.list`, `validate`, `install`/`installBundle`, `sync`, `link`,
`verify`, `update` and exact-generation `recover`. The canonical library in `skills/`
contains all 20 requested shared skills plus 12 role skills and worked examples.
Analyst maps to `specifier`; Verifier maps to `qa`/`tester`. No contract changes.

## Boundaries and integration

This leaf depends only on `@bflow/contracts` and Zod. Definitions, pins, role bindings
and manifests are parsed with the P24 exported schemas. Metadata/reference parsing,
setup requests and repository desired config use strict package-local schemas.

- **P26 machine setup:** inject `SkillsSetupSynchronizer` into its structural
  `SkillsSynchronizer` port. Desired/check/dry-run do not create catalog state.
  Apply installs exact reviewed pins and reads back actual state. P26 owns operator
  setup approval, locking, plan receipts and reporting interrupted partial application.
- **P29 repository init:** use `repositoryConfig(previousSkillsConfig, rolePins)` to
  build the owned `.bflow/skills.json` data. Merge the returned skills subtree through
  the existing config writer; preserve unrelated repository/provider settings. The helper
  preserves userSettings and unspecified role pins and performs no filesystem writes.
- **P30 Runtime:** resolve against actual capability/tool inventory and authenticated
  approval callback, persist the returned manifest digest with the session generation,
  supply `rendered.instructionText` alongside the **full original role prompt** to P25.
  Restart calls `recover(exactDigest)`; never resolve a moving version for a live session.
- **P25 launch:** all three providers receive the same metadata/reference representation.
  Their installed launch surface must be verified separately. Claude native slash/skill
  discovery remains disabled unless separately approved; this package changes no provider
  homes, hooks, global settings or native discovery paths.

Root build references, workspace lockfile, CLI parser and Runtime wiring are owned by
integration/P29/P30. This branch intentionally does not edit them. `bflow setup`,
`bflow skills ...` and automatic `bflow init` skill activation are **not runnable claims**
on this baseline. The package API and integration points are ready; final command wiring
and live provider activation remain integration work. No new scheduler or gates exist here.

## Format and verification

Each bundle contains `SKILL.md` with standard single-line `name`/`description` YAML
frontmatter, `skill.json`, and local referenced resources. JSON supplies `version`,
`allowedRoles`, `supportedProviders`, `requiredCapabilityIds`, `requiredToolIds`, and
exact `dependencies`. All requested sections must be present and nonempty. Other
frontmatter fields are rejected, including hooks/model/permission controls. Only the
small standard subset is accepted: quote scalar values containing YAML punctuation;
block/folded YAML, executable interpolation and arbitrary provider-specific YAML are
unsupported. There is no install/postinstall execution.

`validateSkill` inventories all bundled UTF8 files, checks inline/named/angle-bracket
resource references, rejects unfetched remote links/HTML resource tags, and checks
literal Bflow commands against a host-supplied inventory. Option-first/dynamic command
syntax is rejected; the validator is deliberately not a shell interpreter. Command
availability does not authorize execution. Update the inventory only when the host
really implements a command. Existing baseline commands are exported as `BASELINE_COMMANDS`.

The SHA-256 bundle digest covers a sorted path/content-hash inventory, including metadata,
examples and unused bundled resources. Local files are bounded at 128 files, 256KiB per
file, 2MiB per bundle/document, 32 directory levels and 512 total entries. Binary resources,
symlinks (including ancestors), special files and traversal are unsupported/rejected.
Do not place secret bytes in skills. Secret/remote resource references are never fetched.

Resolution rejects duplicate selections/names, conflicting same-ID pins, cycles,
missing dependencies, role/provider mismatch and unavailable required capabilities/tools.
Dependencies precede consumers with stable ID tie-breaking. Optional unavailable trees
are omitted atomically with diagnostics; conflicting pins still fail. Every selected
repository skill needs an approval ID **and** a host callback that authenticates the
exact source/digest/dependencies, role/provider, scope and expiry. A string ID alone proves
nothing. Builtins require a trusted distribution digest allowlist; operator content also
requires the host approval callback. Merely changing `source` inside content grants no trust.

`verify`/`recover`/`link` recheck manifest identity/digest, persisted catalog provenance,
all bundle bytes, role/provider restrictions and current approval. They verify content
and authority, **not current tool/provider readiness**. Capability/tool availability is
checked during resolution and must be reprobed by P25/P30 before launch/dispatch and on
drift. A successfully rendered skill is not evidence that the agent followed it.

Skills retain host/project policy, role prompts, Conditional TDD, accepted specifications,
leases/fencing, bounded verification, independent Reviewer/QA and exact human approval.
Every specialist routes decisions Runtime → Herdr → Conversation. No skill enables
native direct questions, permission bypass or tool installation. Approved instructions
remain subordinate to the host; semantic prose is not a security sandbox.

## Storage and updates

`new SkillFileStore(absoluteRoot)` requires an existing parent and a private owned POSIX
root (created 0700 on apply); stored files use 0600. Use machine-managed data on a local
POSIX filesystem, outside repository/role write roots. Installation takes an exclusive
`catalog.lock` and publishes immutable content/provenance. Concurrent writers fail busy;
reconcile and retry explicitly. A crash may leave the lock or orphan bundle; an operator
must establish that the writer stopped before removing its owned lock. Never auto-delete
an uncertain lock, overwrite corruption or infer completion from a leftover file.

`update` appends a reviewed exact version. It leaves existing manifests and user settings
unchanged. Same name/version with changed bytes is rejected. Immutable manifest/render
JSON is addressed by manifest digest; old generations remain recoverable. There is no
implicit cleanup/garbage collection. Temporary staging directories and unused bundles
may remain after process death; they are not published skill entries. Atomic publication
is not a multi-file or power-loss transaction, and this is not hostile same-UID,
network-filesystem or multi-host isolation. Full provider sandboxing remains P25/P30 work.

## Example: machine catalog to a scoped Developer manifest

```ts
import {
  BASELINE_COMMANDS, SkillFileStore, SkillManager, loadSkillCatalog,
  RoleSkillBindingsSchema, bindRoleSkills, SkillsSetupSynchronizer, readBundle
} from '@bflow/skills';

const catalogRoot = '/opt/bflow/skills'; // Explicit reviewed distribution, never provider-home discovery.
const catalog = await loadSkillCatalog(catalogRoot, {
  source: 'builtin', supportedCommands: BASELINE_COMMANDS
});
// supplied by trusted operator/distribution config; do NOT approve arbitrary repo bytes here
const approvedDigests: string[] = trustedDistribution.skillDigests;
const store = new SkillFileStore('/var/lib/bflow/owned-skills'); // parent already provisioned
const manager = new SkillManager({
  store, supportedCommands: BASELINE_COMMANDS, approvedBuiltinDigests: approvedDigests,
  authorize: check => authenticatedApprovals.verify(check)
});
const setup = new SkillsSetupSynchronizer(manager, store, catalog.map(s => ({
  root: s.directory, source: 'builtin', expectedDigest: s.definition.digest
})));
const preview = await setup.desired({mode: 'dry_run'});
// P26 authenticates approval of the exact setup plan before invoking apply:
await setup.sync({mode: 'apply'});
const recipe = RoleSkillBindingsSchema.parse(JSON.parse(
  (await readBundle(catalogRoot))['roles/bindings.json']!
));
const result = await manager.sync({
  manifestId: 'developer-generation-1', environmentId: 'developer-env-1',
  scope: {kind: 'session', machineId: 'machine-1', repositoryId: 'repo-1',
    workspaceRoot: '/work/project', sessionId: 'session-1'},
  role: 'developer', provider: 'codex',
  selections: bindRoleSkills(recipe.bindings, 'developer', catalog.map(s => s.definition)),
  capabilityIds: [], toolIds: ['gitnexus', 'rtk'] // actual approved and probed host inventory
});
// P30 persists result.manifest.digest, and composes through P25's contract port:
const renderedSkillsContent = result.rendered.instructionText;
// Later, restart verifies this same generation:
await manager.recover(result.manifest.digest);
```

The example leaves trusted configuration, authenticated approvals and facade wiring to
their owners; it never manufactures them. `packages/skills/test/catalog.test.ts` executes
the catalog/install/binding/render sequence for every role and all three providers using
isolated temporary storage. Each skill also has a task-specific worked example.

Native format references: [Claude Code](https://code.claude.com/docs/en/skills),
[Codex](https://developers.openai.com/codex/skills),
[Agy](https://www.agy.dev/docs/skills/). These establish format surfaces, not live Bflow
activation or permission enforcement.

## Validation and integration proposal

From repository root (Node >=22.13 and pinned pnpm):

```sh
pnpm --filter @bflow/skills typecheck
pnpm --filter @bflow/skills test
pnpm check:deps
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Integration owner must add the workspace importer to `pnpm-lock.yaml` and
`{ "path": "./packages/skills" }` to root TypeScript references, then compose the ports
above. Until then the root typecheck does not include this new package; the package's
own build/typecheck is mandatory. Tests cover all requested negative cases, cross-provider
selection equivalence, stale approval, content drift, concurrency, read-only planning,
preserved configuration and immutable restart/update semantics. They are local source
and rendering tests; no live model session, native skill-discovery acceptance or full
SDLC success is claimed.

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  SkillApprovalReceiptSchema,
  SkillApprovalStoreSchema,
  type AgentRole,
  type SkillApprovalReceipt,
  type SkillDefinition,
  type SkillPin
} from "@bflow/contracts";
import type {
  ScannedSkillSources,
  SkillImportConversion,
  SkillImportProposal,
  SkillImportProposalOptions,
  SkillImportSelection
} from "@bflow/skills";
import { SUPPORTED_CLI_COMMANDS } from "./command-reference.js";
import { renderEnvironmentConfigYaml } from "./config-format.js";
import { ENVIRONMENT_CONFIG_PATH, isGovernanceRoleConfig, readEnvironmentConfig, type EnvironmentConfig } from "./environment-config.js";
import type { RepositoryIdentity } from "./repository.js";
import { loadMachineSkillCatalog } from "./skill-catalog.js";

/**
 * Repository/operator custom skills: scan → proposal → validate → human approval → exact pin → role binding.
 * Imports are staged under `.bflow/skills/imports/<skill>/<version>/` (bundle, verbatim originals, report).
 * Only an approved bundle is promoted into the configured catalog (default `.bflow/skills/catalog`), so an
 * unapproved import can never be resolved at startup. Approval receipts live in machine state, never in the repo.
 */
export const DEFAULT_CUSTOM_SKILL_CATALOG = ".bflow/skills/catalog";
export const CUSTOM_SKILL_IMPORTS = ".bflow/skills/imports";
export const SKILL_APPROVALS_FILE = "skill-approvals.json";
const DEFAULT_APPROVAL_DAYS = 90;

type SkillsModule = typeof import("@bflow/skills");
const skillsModule = (): Promise<SkillsModule> => import("@bflow/skills");

export interface CustomSkillPaths {
  readonly catalogDir: string;
  readonly catalogRoot: string;
  readonly importsRoot: string;
  readonly skillsRoot: string;
}

function inside(root: string, path: string, label: string): string {
  const result = resolve(root, path);
  const rel = relative(root, result);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} must stay inside the repository`);
  return result;
}

export function customSkillPaths(repository: RepositoryIdentity, config: EnvironmentConfig): CustomSkillPaths {
  const catalogDir = config.environment.skills?.catalogDir ?? DEFAULT_CUSTOM_SKILL_CATALOG;
  return {
    catalogDir,
    catalogRoot: inside(repository.root, catalogDir, "Custom skill catalog"),
    importsRoot: inside(repository.root, CUSTOM_SKILL_IMPORTS, "Custom skill imports"),
    skillsRoot: inside(repository.root, ".bflow/skills", "Custom skill root")
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error(`Refusing symlinked path: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Loads custom bundles from the catalog without requiring pins; missing or empty catalogs yield none. */
export async function readCustomCatalog(root: string): Promise<{ directory: string; definition: SkillDefinition; files: Record<string, string> }[]> {
  if (!(await exists(root))) return [];
  const skills = await skillsModule();
  const entries = await readdir(root);
  if (!entries.length) return [];
  return skills.loadSkillCatalog(root, { source: "repository", supportedCommands: SUPPORTED_CLI_COMMANDS });
}

function pinOf(definition: SkillDefinition): SkillPin {
  return { skillId: definition.skillId, version: definition.version, digest: definition.digest };
}

export interface SkillImportRequest {
  readonly sources: readonly SkillImportSelection[];
  readonly roles?: readonly AgentRole[] | undefined;
  readonly providers?: readonly ("claude" | "codex" | "agy")[] | undefined;
  readonly version?: string | undefined;
  readonly skillId?: string | undefined;
  readonly dependsOn?: readonly string[] | undefined;
}
export interface SkillImportPlan {
  readonly scanned: ScannedSkillSources;
  readonly proposal: SkillImportProposal;
  readonly conversions: readonly (SkillImportConversion & { readonly target: string; readonly state: "new" | "reused" })[];
  readonly blocked: readonly { itemId: string; origin: string; blockers: readonly string[] }[];
  readonly paths: CustomSkillPaths;
}

/** Builtin and approved custom definitions that may be dependencies or must not be shadowed. */
async function trustedCatalog(repository: RepositoryIdentity, config: EnvironmentConfig) {
  const builtin = await loadMachineSkillCatalog();
  const paths = customSkillPaths(repository, config);
  const pins = config.environment.skills?.pins ?? [];
  const custom = (await readCustomCatalog(paths.catalogRoot)).filter(entry =>
    pins.some(pin => pin.skillId === entry.definition.skillId && pin.digest === entry.definition.digest && pin.version === entry.definition.version));
  return { builtin: builtin.definitions, custom: custom.map(entry => entry.definition), paths };
}

/** Read-only plan; `applySkillImport` performs the only writes. */
export async function planSkillImport(repository: RepositoryIdentity, config: EnvironmentConfig, request: SkillImportRequest,
  proposalOnly = false): Promise<SkillImportPlan> {
  const skills = await skillsModule();
  const { builtin, custom, paths } = await trustedCatalog(repository, config);
  const scanned = await skills.scanSkillSources([...request.sources]);
  if (request.skillId !== undefined && scanned.inventory.items.length !== 1)
    throw new Error("--name can only be used with exactly one selected skill source");
  const options: SkillImportProposalOptions = {
    ...(request.roles?.length ? { roles: [...request.roles] } : {}),
    ...(request.providers?.length ? { providers: [...request.providers] } : {}),
    ...(request.version !== undefined ? { version: request.version } : {}),
    ...(request.skillId !== undefined ? { skillIds: { [scanned.inventory.items[0]!.itemId]: request.skillId } } : {}),
    reservedSkillIds: builtin.map(definition => definition.skillId)
  };
  const proposal = skills.proposeSkillImport(scanned.inventory, options);
  const blocked = proposal.items.filter(item => item.status === "blocked").map(item => ({
    itemId: item.itemId, origin: scanned.inventory.items.find(candidate => candidate.itemId === item.itemId)!.origin.path, blockers: item.blockers }));
  if (proposalOnly) return { scanned, proposal, conversions: [], blocked, paths };
  const dependencies = (request.dependsOn ?? []).map(skillId => {
    const candidates = [...builtin, ...custom].filter(definition => definition.skillId === skillId);
    if (candidates.length !== 1) throw new Error(`Dependency '${skillId}' is not exactly one builtin or approved custom skill`);
    return pinOf(candidates[0]!);
  });
  const conversions = [];
  for (const item of proposal.items.filter(candidate => candidate.status === "proposed")) {
    const conversion = skills.convertSkillImport(scanned, proposal, item.itemId, {
      supportedCommands: [...SUPPORTED_CLI_COMMANDS], source: "repository", dependencies });
    const definition = conversion.definition;
    for (const dependency of dependencies) {
      const target = [...builtin, ...custom].find(candidate => candidate.digest === dependency.digest)!;
      if (definition.allowedRoles.some(role => !target.allowedRoles.includes(role)) ||
          definition.supportedProviders.some(provider => !target.supportedProviders.includes(provider)))
        throw new Error(`Dependency '${dependency.skillId}' does not support every role/provider of '${definition.skillId}'`);
    }
    const catalogEntry = (await readCustomCatalog(paths.catalogRoot)).find(entry => entry.definition.skillId === definition.skillId);
    if (catalogEntry?.definition.version === definition.version && catalogEntry.definition.digest !== definition.digest)
      throw new Error(`Skill '${definition.skillId}' ${definition.version} is already approved with different content; import a new --version`);
    const target = join(paths.importsRoot, definition.skillId, definition.version);
    let state: "new" | "reused" = "new";
    if (await exists(target)) {
      const staged = await skills.readBundle(join(target, "bundle"));
      if (skills.bundleDigest(staged) !== definition.digest)
        throw new Error(`Import ${definition.skillId} ${definition.version} already staged with different content; import a new --version`);
      state = "reused";
    }
    conversions.push({ ...conversion, target, state });
  }
  return { scanned, proposal, conversions, blocked, paths };
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = inside(root, path, "Bundle file");
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, { mode: 0o644, flag: "wx" });
  }
}

async function publishDirectory(staging: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Writes staged imports only; never touches the catalog, machine state, approvals or provider homes. */
export async function applySkillImport(plan: SkillImportPlan): Promise<string[]> {
  if (plan.blocked.length) throw new Error("Blocked sources cannot be imported; deselect them or fix the source");
  const written: string[] = [];
  for (const conversion of plan.conversions.filter(item => item.state === "new")) {
    await mkdir(plan.paths.skillsRoot, { recursive: true });
    const staging = join(plan.paths.skillsRoot, `.staging-${randomUUID()}`);
    try {
      await writeTree(join(staging, "bundle"), conversion.bundle);
      await writeTree(join(staging, "original"), conversion.originals);
      const proposalItem = plan.proposal.items.find(item => item.itemId === conversion.itemId);
      const inventoryItem = plan.scanned.inventory.items.find(item => item.itemId === conversion.itemId);
      await writeTree(staging, {
        "report.json": `${JSON.stringify(conversion.report, null, 2)}\n`,
        "proposal.json": `${JSON.stringify({ proposalDigest: plan.proposal.digest, inventoryDigest: plan.proposal.inventoryDigest, item: proposalItem }, null, 2)}\n`,
        "inventory.json": `${JSON.stringify(inventoryItem, null, 2)}\n`
      });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await publishDirectory(staging, conversion.target);
    written.push(conversion.target);
  }
  return written;
}

export interface SkillApprovalRequestInput {
  readonly skillId: string;
  readonly version?: string | undefined;
  readonly digest: string;
  readonly expiresInDays?: number | undefined;
  readonly now: Date;
}
export interface SkillApprovalPlan {
  readonly definition: SkillDefinition;
  readonly bundleRoot: string;
  readonly files: Record<string, string>;
  readonly receipt: Omit<SkillApprovalReceipt, "approvalReceiptId">;
  readonly boundRoles: readonly { role: AgentRole; provider: string }[];
  readonly paths: CustomSkillPaths;
}

async function stagedVersions(paths: CustomSkillPaths, skillId: string): Promise<string[]> {
  const root = join(paths.importsRoot, skillId);
  return (await exists(root)) ? (await readdir(root)).sort() : [];
}

/** Read-only: validates the exact reviewed digest, dependencies, roles/providers and scope that approval would grant. */
export async function planSkillApproval(repository: RepositoryIdentity, config: EnvironmentConfig, input: SkillApprovalRequestInput): Promise<SkillApprovalPlan> {
  const skills = await skillsModule();
  const { builtin, custom, paths } = await trustedCatalog(repository, config);
  if (builtin.some(definition => definition.skillId === input.skillId))
    throw new Error(`'${input.skillId}' is an approved distribution skill; custom approval cannot replace it`);
  const versions = await stagedVersions(paths, input.skillId);
  const catalogEntry = (await readCustomCatalog(paths.catalogRoot)).find(entry => entry.definition.skillId === input.skillId);
  const version = input.version ?? (versions.length === 1 ? versions[0] : versions.length === 0 ? catalogEntry?.definition.version : undefined);
  if (version === undefined) throw new Error(`Select --version for '${input.skillId}' (staged: ${versions.join(", ") || "none"})`);
  const stagedRoot = join(paths.importsRoot, input.skillId, version, "bundle");
  const bundleRoot = (await exists(stagedRoot)) ? stagedRoot
    : catalogEntry?.definition.version === version ? catalogEntry.directory : undefined;
  if (bundleRoot === undefined) throw new Error(`No staged or catalog bundle for '${input.skillId}' ${version}; run 'skills import' first`);
  const files = await skills.readBundle(bundleRoot);
  const definition = skills.validateSkill(files, { source: "repository", supportedCommands: SUPPORTED_CLI_COMMANDS });
  if (definition.skillId !== input.skillId || definition.version !== version)
    throw new Error("Staged bundle identity does not match the requested skill/version");
  if (definition.digest !== input.digest)
    throw new Error(`Skill bundle digest is ${definition.digest}, not the reviewed ${input.digest}; review the current bytes before approving`);
  const trusted = [...builtin, ...custom];
  for (const dependency of definition.dependencies) {
    const target = trusted.find(candidate => candidate.skillId === dependency.skillId);
    if (!target || target.version !== dependency.version || target.digest !== dependency.digest)
      throw new Error(`Dependency conflict: '${dependency.skillId}' ${dependency.version} is not the approved/installed pin`);
    if (definition.allowedRoles.some(role => !target.allowedRoles.includes(role)) ||
        definition.supportedProviders.some(provider => !target.supportedProviders.includes(provider)))
      throw new Error(`Dependency '${dependency.skillId}' does not support every role/provider of '${definition.skillId}'`);
  }
  const configured = config.environment.roles.filter(isGovernanceRoleConfig).filter(role => definition.allowedRoles.includes(role.role));
  for (const role of configured)
    if (!(definition.supportedProviders as string[]).includes(role.cli))
      throw new Error(`Role '${role.role}' uses provider '${role.cli}', which '${definition.skillId}' does not support; re-import with that provider`);
  const days = input.expiresInDays ?? DEFAULT_APPROVAL_DAYS;
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error("--expires-in-days must be between 1 and 365");
  const receipt = {
    skillId: definition.skillId,
    version: definition.version,
    digest: definition.digest,
    dependencies: definition.dependencies,
    repositoryId: repository.id,
    sessionId: repository.sessionName,
    roles: definition.allowedRoles,
    providers: definition.supportedProviders,
    approvedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + days * 86_400_000).toISOString()
  };
  return { definition, bundleRoot, files, receipt, boundRoles: configured.map(role => ({ role: role.role, provider: role.cli })), paths };
}

/** Machine receipt store mutation under an exclusive lock; the file stays 0600 inside a 0700 directory. */
async function mutateApprovals(stateDirectory: string, mutate: (receipts: SkillApprovalReceipt[]) => SkillApprovalReceipt[]): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const stats = await lstat(stateDirectory);
  if (stats.isSymbolicLink() || !stats.isDirectory() || (stats.mode & 0o077) !== 0)
    throw new Error(`Machine state directory must be a private (0700) directory: ${stateDirectory}`);
  const path = join(stateDirectory, SKILL_APPROVALS_FILE);
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw Object.assign(new Error(`Skill approvals are locked by another writer (${lockPath}); confirm it stopped before removing the lock`), { code: "busy" });
    throw error;
  }
  try {
    let receipts: SkillApprovalReceipt[] = [];
    if (await exists(path)) {
      const file = await lstat(path);
      if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error(`${path} must be a private regular file`);
      const handle = await open(path, "r");
      try {
        receipts = SkillApprovalStoreSchema.parse(JSON.parse(await handle.readFile("utf8"))).receipts;
      } finally {
        await handle.close();
      }
    }
    const next = SkillApprovalStoreSchema.parse({ schemaVersion: 3, receipts: mutate(receipts) });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function writeConfig(repository: RepositoryIdentity, config: EnvironmentConfig): Promise<void> {
  const path = join(repository.root, ENVIRONMENT_CONFIG_PATH);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, renderEnvironmentConfigYaml(config), { flag: "wx", mode: 0o644 });
  await rename(temporary, path);
  await readEnvironmentConfig(repository); // Read back: a written config must still parse.
}

/** Records the exact approval, promotes the reviewed bytes into the catalog and binds the exact pin. */
export async function applySkillApproval(repository: RepositoryIdentity, config: EnvironmentConfig, plan: SkillApprovalPlan,
  stateDirectory: string): Promise<{ approvalReceiptId: string; catalogPath: string }> {
  const skills = await skillsModule();
  const approvalReceiptId = `skill-${plan.definition.skillId}-${plan.definition.digest.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  const receipt = SkillApprovalReceiptSchema.parse({ approvalReceiptId, ...plan.receipt });
  // Re-read immediately before the side effects: bytes replaced after planning are refused.
  if (skills.bundleDigest(await skills.readBundle(plan.bundleRoot)) !== plan.definition.digest)
    throw new Error("Skill bundle changed after approval review");
  await mutateApprovals(stateDirectory, receipts => [...receipts, receipt]);
  const catalogPath = join(plan.paths.catalogRoot, plan.definition.skillId);
  const current = (await exists(catalogPath)) ? skills.bundleDigest(await skills.readBundle(catalogPath)) : undefined;
  if (current !== plan.definition.digest) {
    await mkdir(plan.paths.skillsRoot, { recursive: true });
    const staging = join(plan.paths.skillsRoot, `.staging-${randomUUID()}`);
    await writeTree(staging, plan.files);
    if (skills.bundleDigest(await skills.readBundle(staging)) !== plan.definition.digest) {
      await rm(staging, { recursive: true, force: true });
      throw new Error("Promoted bundle digest mismatch");
    }
    if (current !== undefined) {
      const retired = join(plan.paths.skillsRoot, `.replaced-${randomUUID()}`);
      await rename(catalogPath, retired);
      await publishDirectory(staging, catalogPath);
      await rm(retired, { recursive: true, force: true });
    } else await publishDirectory(staging, catalogPath);
  }
  const skillsConfig = config.environment.skills ?? {};
  const pins = (skillsConfig.pins ?? []).filter(pin => pin.skillId !== plan.definition.skillId);
  const next: EnvironmentConfig = {
    ...config,
    environment: {
      ...config.environment,
      skills: {
        ...skillsConfig,
        catalogDir: plan.paths.catalogDir,
        pins: [...pins, { ...pinOf(plan.definition), approvalReceiptId }],
        requiredSkills: [...new Set([...(skillsConfig.requiredSkills ?? []), plan.definition.skillId])]
      }
    }
  };
  await writeConfig(repository, next);
  return { approvalReceiptId, catalogPath };
}

/** Removes the role binding only; the pin, catalog bytes and receipts stay for running-session recovery. */
export function disabledConfig(config: EnvironmentConfig, skillId: string): { config: EnvironmentConfig; changed: boolean } {
  const skillsConfig = config.environment.skills;
  const required = skillsConfig?.requiredSkills ?? [];
  const roles = config.environment.roles.map(role => role.skills?.includes(skillId)
    ? { ...role, skills: role.skills.filter(item => item !== skillId) } : role);
  const changed = required.includes(skillId) || roles.some((role, index) => role !== config.environment.roles[index]);
  return {
    changed,
    config: {
      ...config,
      environment: {
        ...config.environment,
        roles,
        ...(skillsConfig ? { skills: { ...skillsConfig, requiredSkills: required.filter(item => item !== skillId) } } : {})
      }
    }
  };
}

export async function applySkillDisable(repository: RepositoryIdentity, config: EnvironmentConfig, skillId: string): Promise<boolean> {
  const result = disabledConfig(config, skillId);
  if (result.changed) await writeConfig(repository, result.config);
  return result.changed;
}

export async function listSkillApprovals(stateDirectory: string): Promise<SkillApprovalReceipt[]> {
  const path = join(stateDirectory, SKILL_APPROVALS_FILE);
  if (!(await exists(path))) return [];
  const handle = await open(path, "r");
  try {
    return SkillApprovalStoreSchema.parse(JSON.parse(await handle.readFile("utf8"))).receipts;
  } finally {
    await handle.close();
  }
}

/** Deletes this repository session's receipts for the skill (optionally one version) and unbinds it. */
export async function applySkillRevoke(repository: RepositoryIdentity, config: EnvironmentConfig, stateDirectory: string,
  skillId: string, version?: string): Promise<{ revoked: string[]; unbound: boolean }> {
  const matches = (receipt: SkillApprovalReceipt) => receipt.skillId === skillId && receipt.repositoryId === repository.id &&
    receipt.sessionId === repository.sessionName && (version === undefined || receipt.version === version);
  const revoked: string[] = [];
  await mutateApprovals(stateDirectory, receipts => receipts.filter(receipt => {
    if (!matches(receipt)) return true;
    revoked.push(receipt.approvalReceiptId);
    return false;
  }));
  const unbound = await applySkillDisable(repository, config, skillId);
  return { revoked, unbound };
}

export function revocationPreview(receipts: readonly SkillApprovalReceipt[], repository: RepositoryIdentity, skillId: string, version?: string): string[] {
  return receipts.filter(receipt => receipt.skillId === skillId && receipt.repositoryId === repository.id &&
    receipt.sessionId === repository.sessionName && (version === undefined || receipt.version === version)).map(receipt => receipt.approvalReceiptId);
}

/** Read-only: catalog/pin/receipt/install state of each custom skill and pending staged imports. */
export async function customSkillStatus(repository: RepositoryIdentity, config: EnvironmentConfig, machine: { stateDirectory: string; dataDirectory: string },
  now: Date) {
  const skills = await skillsModule();
  const runtime = await import("@bflow/runtime");
  const paths = customSkillPaths(repository, config);
  const catalog = await readCustomCatalog(paths.catalogRoot);
  const pins = config.environment.skills?.pins ?? [];
  const required = config.environment.skills?.requiredSkills ?? [];
  const approvalPath = join(machine.stateDirectory, SKILL_APPROVALS_FILE);
  const storeRoot = join(machine.dataDirectory, "skills-store");
  const installed = new Set<string>();
  try {
    for (const definition of await new skills.SkillManager({ store: new skills.SkillFileStore(storeRoot), supportedCommands: SUPPORTED_CLI_COMMANDS }).list())
      installed.add(definition.digest);
  } catch { /* An unreadable store reports nothing installed. */ }
  const skillsStatus = [];
  for (const entry of catalog) {
    const definition = entry.definition;
    const pin = pins.find(item => item.skillId === definition.skillId);
    const pinState = !pin ? "missing" : pin.version === definition.version && pin.digest === definition.digest ? "exact" : "mismatch";
    const approvals = [];
    for (const role of config.environment.roles.filter(isGovernanceRoleConfig).filter(item => definition.allowedRoles.includes(item.role))) {
      const valid = pin !== undefined && await runtime.readSkillApproval(approvalPath, { approvalReceiptId: pin.approvalReceiptId,
        skillId: definition.skillId, version: definition.version, digest: definition.digest, dependencies: definition.dependencies,
        role: role.role, provider: role.cli, repositoryId: repository.id, sessionId: repository.sessionName }, () => now);
      approvals.push({ role: role.role, provider: role.cli, approval: valid ? "valid" : "unavailable" });
    }
    const bound = required.includes(definition.skillId) || config.environment.roles.some(role => role.skills?.includes(definition.skillId) === true);
    const usable = pinState === "exact" && installed.has(definition.digest) && approvals.every(item => item.approval === "valid");
    skillsStatus.push({ skillId: definition.skillId, version: definition.version, digest: definition.digest,
      status: !bound ? "disabled" : usable ? "ready" : "not_ready", pin: pinState, bound, installed: installed.has(definition.digest), approvals });
  }
  const pending = [];
  if (await exists(paths.importsRoot))
    for (const skillId of (await readdir(paths.importsRoot)).sort())
      for (const version of await stagedVersions(paths, skillId)) {
        const files = await skills.readBundle(join(paths.importsRoot, skillId, version, "bundle")).catch(() => undefined);
        const digest = files ? skills.bundleDigest(files) : null;
        if (!catalog.some(entry => entry.definition.digest === digest)) pending.push({ skillId, version, digest });
      }
  const privateState = runtime.findPrivateRuntimeStateDirectory(repository.root);
  const platformState = privateState === undefined ? undefined : join(privateState, "platform", repository.sessionName);
  // Same authority as the Runtime host: exact receipt for this repository session, re-read on every check.
  const authorize = async (check: import("@bflow/skills").ApprovalCheck) => check.scope.kind === "session" &&
    check.scope.repositoryId === repository.id && check.scope.sessionId === repository.sessionName &&
    runtime.readSkillApproval(approvalPath, { approvalReceiptId: check.approvalReceiptId, skillId: check.definition.skillId,
      version: check.definition.version, digest: check.definition.digest, dependencies: check.definition.dependencies,
      role: check.role, provider: check.provider, repositoryId: repository.id, sessionId: repository.sessionName }, () => now);
  const manager = new skills.SkillManager({ store: new skills.SkillFileStore(storeRoot), supportedCommands: SUPPORTED_CLI_COMMANDS,
    approvedBuiltinDigests: (await loadMachineSkillCatalog()).approvedBuiltinSkillDigests, authorize });
  const sessions = platformState === undefined
    ? { records: [], reconciliationRequired: false, diagnostics: [] }
    : await runtime.reconcileSkillSessionRecords({ stateDirectory: platformState, verify: manifest => manager.verify(manifest), authorize });
  return { catalogDir: paths.catalogDir, skills: skillsStatus, pendingImports: pending, sessions };
}

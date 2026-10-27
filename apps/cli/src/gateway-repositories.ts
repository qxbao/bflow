import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  IdentifierSchema,
  MCPServiceDefinitionSchema,
  PlatformSchemaVersionSchema,
  ScopedOperationSchema,
  Sha256DigestSchema,
  type MCPServiceDefinition,
  type MCPServiceObservation
} from "@bflow/contracts";
import {
  defaultHostEnvironment,
  detectPlatform,
  digest,
  isolatedPlatformProfile,
  type PlatformProfile
} from "@bflow/machine-setup";
import { GATEWAY_CONTROL_LOCATOR_FILE, registerGatewayRepositoryService, removeGatewayRepositoryService } from "./gateway-control.js";
import { readGatewayReadiness } from "./gateway-readiness.js";
import type { RepositoryIdentity } from "./repository.js";
import { approvedGitNexusExecutable, repositoryHasCommits } from "./setup-gateway.js";
import type { CliContext } from "./types.js";

export const GATEWAY_REPOSITORIES_FILE = "gateway-repositories.json";
export const GITNEXUS_POLYFORM_NOTICE =
  "GitNexus (PolyForm-Noncommercial-1.0.0): non-commercial use only; commercial repositories should pass --no-gitnexus or disable environment.tools.gitnexus in .bflow/config.yml.";

const GITNEXUS_OPERATIONS = ["query", "context", "impact"] as const;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export const RegisteredRepositoryServiceSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  repositoryId: IdentifierSchema,
  workspaceRoot: z.string().min(1).refine(path => isAbsolute(path), "workspaceRoot must be absolute"),
  service: MCPServiceDefinitionSchema,
  registeredAt: z.string().datetime()
}).strict();
export type RegisteredRepositoryService = z.infer<typeof RegisteredRepositoryServiceSchema>;

export const GatewayRepositoriesStateSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  machineId: IdentifierSchema,
  digest: Sha256DigestSchema,
  updatedAt: z.string().datetime(),
  repositories: z.array(RegisteredRepositoryServiceSchema)
}).strict();
export type GatewayRepositoriesState = z.infer<typeof GatewayRepositoriesStateSchema>;

export function gitNexusServiceId(canonicalWorkspaceRoot: string): string {
  return `gitnexus-${sha(canonicalWorkspaceRoot).slice(0, 24)}`;
}

export function gatewayRepositoriesDigest(input: {
  readonly machineId: string;
  readonly repositories: readonly RegisteredRepositoryService[];
}): string {
  return digest({
    schemaVersion: 3,
    machineId: input.machineId,
    repositories: input.repositories
  });
}

async function readRegularJson(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) {
    throw new Error(`Not a bounded regular state file: ${file}`);
  }
  return JSON.parse(await readFile(file, "utf8"));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function ensurePrivateStateDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Gateway repositories state directory is not a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`Gateway repositories state directory is not owned by the current user: ${directory}`);
  }
  if ((info.mode & 0o777) !== 0o700) {
    await chmod(directory, 0o700);
  }
}

async function withGatewayRepositoriesLock<T>(
  stateDirectory: string,
  action: () => Promise<T>,
  timeoutMs = 10_000
): Promise<T> {
  await ensurePrivateStateDir(stateDirectory);
  const lockPath = join(stateDirectory, `${GATEWAY_REPOSITORIES_FILE}.lock`);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
        if (typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 && !processAlive(raw.pid)) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // Concurrent writer may still be initializing or removing the lock file.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock for ${GATEWAY_REPOSITORIES_FILE}`);
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function writeGatewayRepositoriesStateAtomic(
  stateDirectory: string,
  state: GatewayRepositoriesState
): Promise<void> {
  const parsed = GatewayRepositoriesStateSchema.parse(state);
  const expected = gatewayRepositoriesDigest({
    machineId: parsed.machineId,
    repositories: parsed.repositories
  });
  if (parsed.digest !== expected) {
    throw new Error("Gateway repositories state digest mismatch before write");
  }
  const target = join(stateDirectory, GATEWAY_REPOSITORIES_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readGatewayRepositoriesState(
  stateDirectory: string,
  expectedMachineId?: string
): Promise<{
  readonly status: "absent" | "valid" | "invalid";
  readonly state?: GatewayRepositoriesState;
  readonly error?: string;
}> {
  const file = join(stateDirectory, GATEWAY_REPOSITORIES_FILE);
  let raw: unknown;
  try {
    raw = await readRegularJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
  const parsed = GatewayRepositoriesStateSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "invalid", error: `Invalid ${GATEWAY_REPOSITORIES_FILE}: ${parsed.error.issues[0]?.message ?? "schema validation failed"}` };
  }
  const recomputed = gatewayRepositoriesDigest({
    machineId: parsed.data.machineId,
    repositories: parsed.data.repositories
  });
  if (parsed.data.digest !== recomputed) {
    return { status: "invalid", error: `Invalid ${GATEWAY_REPOSITORIES_FILE} checksum` };
  }
  if (expectedMachineId !== undefined && parsed.data.machineId !== expectedMachineId) {
    return { status: "invalid", error: `${GATEWAY_REPOSITORIES_FILE} belongs to machine '${parsed.data.machineId}', expected '${expectedMachineId}'` };
  }
  return { status: "valid", state: parsed.data };
}

export async function upsertRegisteredRepositoryService(
  stateDirectory: string,
  machineId: string,
  entry: RegisteredRepositoryService
): Promise<GatewayRepositoriesState> {
  const validatedEntry = RegisteredRepositoryServiceSchema.parse(entry);
  if (
    validatedEntry.service.scope.kind !== "repository" ||
    validatedEntry.service.scope.machineId !== machineId ||
    validatedEntry.service.scope.repositoryId !== validatedEntry.repositoryId ||
    validatedEntry.service.scope.workspaceRoot !== validatedEntry.workspaceRoot
  ) {
    throw new Error("Repository MCP service scope must match the machine, repository ID and canonical workspaceRoot");
  }
  return withGatewayRepositoriesLock(stateDirectory, async () => {
    const existing = await readGatewayRepositoriesState(stateDirectory, machineId);
    if (existing.status === "invalid") {
      throw new Error(existing.error ?? `Corrupted ${GATEWAY_REPOSITORIES_FILE}`);
    }
    const filtered = (existing.state?.repositories ?? []).filter(
      item =>
        item.repositoryId !== validatedEntry.repositoryId &&
        item.workspaceRoot !== validatedEntry.workspaceRoot &&
        item.service.serviceId !== validatedEntry.service.serviceId
    );
    const repositories = [...filtered, validatedEntry].sort((a, b) => a.workspaceRoot.localeCompare(b.workspaceRoot));
    const next: GatewayRepositoriesState = GatewayRepositoriesStateSchema.parse({
      schemaVersion: 3,
      machineId,
      digest: gatewayRepositoriesDigest({ machineId, repositories }),
      updatedAt: new Date().toISOString(),
      repositories
    });
    await writeGatewayRepositoriesStateAtomic(stateDirectory, next);
    return next;
  });
}

export async function removeRegisteredRepositoryService(
  stateDirectory: string,
  machineId: string,
  match: {
    readonly repositoryId?: string | undefined;
    readonly workspaceRoot?: string | undefined;
    readonly serviceId?: string | undefined;
  }
): Promise<{
  readonly removed: readonly RegisteredRepositoryService[];
  readonly state?: GatewayRepositoriesState;
}> {
  return withGatewayRepositoriesLock(stateDirectory, async () => {
    const existing = await readGatewayRepositoriesState(stateDirectory, machineId);
    if (existing.status === "absent") {
      return { removed: [] };
    }
    if (existing.status === "invalid") {
      throw new Error(existing.error ?? `Corrupted ${GATEWAY_REPOSITORIES_FILE}`);
    }
    const matches = (item: RegisteredRepositoryService) =>
      (match.repositoryId !== undefined && item.repositoryId === match.repositoryId) ||
      (match.workspaceRoot !== undefined && item.workspaceRoot === match.workspaceRoot) ||
      (match.serviceId !== undefined && item.service.serviceId === match.serviceId);
    const removed = existing.state!.repositories.filter(matches);
    if (removed.length === 0) {
      return { removed: [], state: existing.state! };
    }
    const repositories = existing.state!.repositories.filter(item => !matches(item));
    const next: GatewayRepositoriesState = GatewayRepositoriesStateSchema.parse({
      schemaVersion: 3,
      machineId,
      digest: gatewayRepositoriesDigest({ machineId, repositories }),
      updatedAt: new Date().toISOString(),
      repositories
    });
    await writeGatewayRepositoriesStateAtomic(stateDirectory, next);
    return { removed, state: next };
  });
}

/**
 * Strictly validates a repository-scoped GitNexus service definition and its underlying
 * ToolLaunchSpec against the canonical repository path, launcher digest, executable digest,
 * and approved environment/lock boundaries.
 */
export async function validateRepositoryServiceLaunch(
  entry: RegisteredRepositoryService,
  paths: { readonly config: string; readonly state: string; readonly data: string },
  machineId: string,
  approvedExecutable: { readonly executable: string; readonly version: string }
): Promise<MCPServiceDefinition> {
  const parsed = RegisteredRepositoryServiceSchema.parse(entry);
  const definition = parsed.service;
  if (
    definition.scope.kind !== "repository" ||
    definition.scope.machineId !== machineId ||
    definition.scope.repositoryId !== parsed.repositoryId ||
    definition.scope.workspaceRoot !== parsed.workspaceRoot
  ) {
    throw new Error(`Repository service ${definition.serviceId} scope does not match machine or repository identity`);
  }
  const canonicalRoot = await realpath(parsed.workspaceRoot);
  if (canonicalRoot !== parsed.workspaceRoot) {
    throw new Error(`Repository service ${definition.serviceId} workspaceRoot is not canonical`);
  }
  const expectedServiceId = gitNexusServiceId(canonicalRoot);
  if (definition.serviceId !== expectedServiceId || definition.tool.toolId !== "gitnexus") {
    throw new Error(`Repository service ${definition.serviceId} does not match canonical GitNexus service ID ${expectedServiceId}`);
  }
  if (definition.connection.kind !== "stdio_mcp" || definition.connection.argv.length !== 4) {
    throw new Error(`Managed GitNexus service ${definition.serviceId} connection changed since registration`);
  }
  const [launcher, specPath, specDigest, launcherDigest] = definition.connection.argv;
  const tools = await import("@bflow/tool-installer");
  const spec = tools.ToolLaunchSpecSchema.parse(await readRegularJson(specPath!));
  const expectedLauncher = fileURLToPath(new URL("../../../packages/tool-installer/dist/service-launcher.js", import.meta.url));
  const launchesDir = await realpath(join(paths.config, "tool-launches"));
  if (
    await realpath(launcher!) !== await realpath(expectedLauncher) ||
    sha(await readFile(launcher!)) !== launcherDigest ||
    sha(JSON.stringify(spec)) !== specDigest ||
    !isAbsolute(spec.executable) ||
    spec.executable !== approvedExecutable.executable || definition.tool.version !== approvedExecutable.version ||
    sha(await readFile(spec.executable)) !== spec.executableDigest ||
    !specPath!.startsWith(`${launchesDir}${sep}`)
  ) {
    throw new Error(`Managed GitNexus executable or launch specification changed for ${definition.serviceId}`);
  }
  const state = await realpath(join(paths.state, "gitnexus"));
  const expectedSpec = {
    schemaVersion: 3,
    executable: spec.executable,
    executableDigest: spec.executableDigest,
    argv: ["mcp"],
    cwd: canonicalRoot,
    environment: {
      GITNEXUS_HOME: join(state, "gitnexus-home"),
      GITNEXUS_MCP_ALLOWED_REPOS: canonicalRoot,
      GITNEXUS_MCP_READ_ONLY: "1",
      GITNEXUS_SHARED_STORE: "off"
    },
    lockPath: join(state, `gitnexus-storage-${sha(canonicalRoot)}.lock`)
  };
  if (digest(spec) !== digest(expectedSpec)) {
    throw new Error(`Managed GitNexus canonical launch boundaries changed for ${definition.serviceId}`);
  }
  const expectedDefinition = MCPServiceDefinitionSchema.parse({
    schemaVersion: 3,
    serviceId: expectedServiceId,
    revision: definition.revision,
    scope: {
      kind: "repository",
      machineId,
      repositoryId: parsed.repositoryId,
      workspaceRoot: canonicalRoot
    },
    tool: {
      ...tools.createToolCapability("gitnexus", definition.tool.version, parsed.repositoryId),
      kind: "stdio_mcp",
      required: definition.tool.required,
      operations: [...GITNEXUS_OPERATIONS],
      resource: { sharing: "exclusive", resourceKey: expectedServiceId }
    },
    connection: {
      kind: "stdio_mcp",
      executable: process.execPath,
      executableDigest: sha(await readFile(process.execPath)),
      argv: [launcher, specPath, specDigest, launcherDigest],
      environmentBindings: {},
      ownership: "bflow",
      bridgeRequired: true
    },
    authentication: { mode: "none" },
    healthTimeoutMs: 15_000,
    idleTimeoutMs: 60_000,
    restartLimit: 2
  });
  if (digest(definition) !== digest(expectedDefinition)) {
    throw new Error(`Managed GitNexus service policy changed for ${definition.serviceId}`);
  }
  return expectedDefinition;
}

export function resolveSetupPlatform(context?: CliContext): PlatformProfile {
  const host = defaultHostEnvironment();
  let platform: PlatformProfile = context?.setup?.platform ?? detectPlatform(host);
  const isolatedRoot = context?.setup?.isolatedRoot ?? host.env.BFLOW_HOME ?? process.env.BFLOW_HOME;
  if (isolatedRoot) {
    platform = isolatedPlatformProfile(platform, resolve(isolatedRoot));
  }
  return platform;
}

/** Only the executable approved by machine setup may back a repository service. */
export async function resolveApprovedGitNexusBinary(
  platform: PlatformProfile
): Promise<{ readonly executable: string; readonly version: string } | undefined> {
  const approved = approvedGitNexusExecutable(platform.paths.config);
  return approved && existsSync(approved.executable) ? approved : undefined;
}

export interface RepositoryGitNexusReport {
  readonly status: "ready" | "deferred" | "skipped" | "removed" | "missing" | "stale" | "blocked";
  readonly serviceId: string;
  readonly indexed: boolean;
  readonly registered: boolean;
  readonly gatewayReady: boolean;
  readonly diagnostics: readonly string[];
}

/**
 * Checks whether GitNexus is currently indexed, registered in `gateway-repositories.json`,
 * and ready on the running Gateway for the given repository. Read-only (`bflow init --check` / `bflow doctor`).
 */
export async function checkRepositoryGitNexus(input: {
  readonly repository: RepositoryIdentity;
  readonly platform: PlatformProfile;
}): Promise<RepositoryGitNexusReport> {
  const { repository, platform } = input;
  const canonicalRoot = await realpath(repository.root).catch(() => repository.root);
  const serviceId = gitNexusServiceId(canonicalRoot);
  const diagnostics: string[] = [];

  if (!repositoryHasCommits(canonicalRoot)) {
    diagnostics.push("GitNexus indexing deferred: the repository has no commits yet. Create the first commit and run 'bflow init'.");
    return {
      status: "deferred",
      serviceId,
      indexed: false,
      registered: false,
      gatewayReady: false,
      diagnostics
    };
  }

  const binary = await resolveApprovedGitNexusBinary(platform);
  if (!binary) {
    diagnostics.push("Machine setup or the managed GitNexus installation is not ready. Run 'bflow setup' first, then run 'bflow init'.");
    return {
      status: "missing",
      serviceId,
      indexed: false,
      registered: false,
      gatewayReady: false,
      diagnostics
    };
  }

  let indexed = false;
  let indexStale = false;
  try {
    const tools = await import("@bflow/tool-installer");
    const homeDir = join(platform.paths.state, "gitnexus", "gitnexus-home");
    if (existsSync(homeDir)) {
      const result = await tools.systemToolHost.run(binary.executable, ["status", "--json"], {
        cwd: canonicalRoot,
        timeoutMs: 15_000,
        environment: { GITNEXUS_HOME: await realpath(homeDir), GITNEXUS_SHARED_STORE: "off" }
      });
      const text = result.stdout.trim();
      const parsed = text.includes("{") ? JSON.parse(text.slice(text.indexOf("{"))) as { repository?: string; status?: string; error?: string } : null;
      if (result.exitCode === 0 && parsed && typeof parsed.repository === "string" && await realpath(parsed.repository).catch(() => null) === canonicalRoot) {
        if (parsed.status === "up-to-date" || parsed.status === "registered") {
          indexed = true;
        } else if (parsed.status === "stale" || parsed.error === "stale-kuzu-index") {
          indexStale = true;
          diagnostics.push("GitNexus repository index is stale. Run 'bflow init' to refresh the repository index.");
        } else {
          diagnostics.push("Repository is not indexed in GitNexus. Run 'bflow init' to index and register this repository.");
        }
      } else {
        diagnostics.push("GitNexus repository index could not be verified. Run 'bflow init' to index and register this repository.");
      }
    } else {
      diagnostics.push("GitNexus repository index is absent. Run 'bflow init' to index and register this repository.");
    }
  } catch (error) {
    diagnostics.push(`GitNexus index check failed (${error instanceof Error ? error.message : String(error)}). Run 'bflow init'.`);
  }

  const repoState = await readGatewayRepositoriesState(platform.paths.state, platform.machineId);
  let registered = false;
  if (repoState.status === "invalid") {
    diagnostics.push(`${repoState.error}. Run 'bflow init' to repair repository registration.`);
  } else if (repoState.status === "valid" && repoState.state) {
    const found = repoState.state.repositories.find(
      item => item.repositoryId === repository.id && item.workspaceRoot === canonicalRoot && item.service.serviceId === serviceId
    );
    if (found) {
      try {
        await validateRepositoryServiceLaunch(found, platform.paths, platform.machineId, binary);
        registered = true;
      } catch (error) {
        diagnostics.push(`Registered GitNexus launch specification is invalid (${error instanceof Error ? error.message : String(error)}). Run 'bflow init' to update it.`);
      }
    } else {
      diagnostics.push(`Repository '${canonicalRoot}' is not registered in ${GATEWAY_REPOSITORIES_FILE}. Run 'bflow init' to register its GitNexus service.`);
    }
  } else {
    diagnostics.push(`Repository '${canonicalRoot}' is not registered with the Gateway. Run 'bflow init' to register its GitNexus service.`);
  }

  const readiness = await readGatewayReadiness(platform.paths.state, serviceId);
  const gatewayReady =
    readiness.gateway === "running" &&
    readiness.status === "ready" &&
    GITNEXUS_OPERATIONS.every(op => readiness.discoveredTools.includes(op));
  if (!gatewayReady) {
    if (readiness.gateway !== "running") {
      diagnostics.push("The machine MCP Gateway is not running. Run 'bflow setup' to start the Gateway, then run 'bflow init'.");
    } else if (readiness.status === "missing") {
      diagnostics.push(`Gateway is running but service '${serviceId}' is not active on it. Run 'bflow init' to register this repository with the running Gateway.`);
    } else {
      diagnostics.push(`Gateway service '${serviceId}' is ${readiness.status}. Run 'bflow init' to reconcile repository GitNexus readiness.`);
    }
  }

  const status: RepositoryGitNexusReport["status"] =
    indexed && registered && gatewayReady
      ? "ready"
      : indexStale
        ? "stale"
        : !indexed && !registered
          ? "missing"
          : "blocked";

  return {
    status,
    serviceId,
    indexed,
    registered,
    gatewayReady,
    diagnostics
  };
}

/**
 * Prepares GitNexus for a repository during `bflow init`:
 * 1. Checks commits (defers if unborn HEAD).
 * 2. Verifies machine setup & GitNexus binary (emits diagnostic to run `bflow setup` if absent).
 * 3. Runs `ensureGitNexusIndex` for the repository.
 * 4. Creates the repository-scoped `MCPServiceDefinition` (`gitnexus-<sha>`).
 * 5. Persists in `gateway-repositories.json` and dynamically registers with the running Gateway via `gateway-control.json`.
 */
export async function prepareRepositoryGitNexus(input: {
  readonly repository: RepositoryIdentity;
  readonly platform: PlatformProfile;
}): Promise<RepositoryGitNexusReport> {
  try {
    return await indexAndRegisterRepository(input);
  } catch (error) {
    // The repository configuration is already written; report GitNexus as blocked instead of failing init.
    return {
      status: "blocked",
      serviceId: gitNexusServiceId(await realpath(input.repository.root).catch(() => input.repository.root)),
      indexed: false,
      registered: false,
      gatewayReady: false,
      diagnostics: [GITNEXUS_POLYFORM_NOTICE,
        `GitNexus repository preparation failed (${error instanceof Error ? error.message : String(error)}). Fix the cause and rerun 'bflow init'.`]
    };
  }
}

async function indexAndRegisterRepository(input: {
  readonly repository: RepositoryIdentity;
  readonly platform: PlatformProfile;
}): Promise<RepositoryGitNexusReport> {
  const { repository, platform } = input;
  const canonicalRoot = await realpath(repository.root).catch(() => repository.root);
  const serviceId = gitNexusServiceId(canonicalRoot);
  const diagnostics: string[] = [GITNEXUS_POLYFORM_NOTICE];

  if (!repositoryHasCommits(canonicalRoot)) {
    diagnostics.push("GitNexus indexing deferred: the repository has no commits yet. Create the first commit and rerun 'bflow init'.");
    return {
      status: "deferred",
      serviceId,
      indexed: false,
      registered: false,
      gatewayReady: false,
      diagnostics
    };
  }

  const binary = await resolveApprovedGitNexusBinary(platform);
  if (!binary) {
    diagnostics.push("Machine setup is incomplete or GitNexus is not installed. Run 'bflow setup' first, then rerun 'bflow init' in this repository.");
    return {
      status: "missing",
      serviceId,
      indexed: false,
      registered: false,
      gatewayReady: false,
      diagnostics
    };
  }

  const repoOperation = ScopedOperationSchema.parse({
    schemaVersion: 3,
    scope: {
      kind: "repository",
      machineId: platform.machineId,
      repositoryId: repository.id,
      workspaceRoot: canonicalRoot
    },
    idempotencyKey: `init-gitnexus-${repository.id}`
  });

  const locatorPath = join(platform.paths.state, GATEWAY_CONTROL_LOCATOR_FILE);
  const gitnexusStateRoot = join(platform.paths.state, "gitnexus");
  const tools = await import("@bflow/tool-installer");
  let indexed = await tools.ensureGitNexusIndex({
    repositoryRoot: canonicalRoot,
    stateRoot: gitnexusStateRoot,
    executable: binary.executable,
    timeoutMs: 300_000
  });
  if (indexed.status === "busy" && existsSync(locatorPath)) {
    const removedRes = await removeGatewayRepositoryService(locatorPath, {
      serviceId,
      operation: repoOperation
    });
    if (removedRes.ok) {
      const storageLockPath = join(gitnexusStateRoot, `gitnexus-storage-${sha(canonicalRoot)}.lock`);
      const deadline = Date.now() + 3000;
      while (existsSync(storageLockPath) && Date.now() < deadline) {
        await new Promise<void>(r => setTimeout(r, 50));
      }
      indexed = await tools.ensureGitNexusIndex({
        repositoryRoot: canonicalRoot,
        stateRoot: gitnexusStateRoot,
        executable: binary.executable,
        timeoutMs: 300_000
      });
    }
  }
  if (!["fresh", "indexed"].includes(indexed.status)) {
    diagnostics.push(`GitNexus indexing ${indexed.status}: ${indexed.diagnostic}`);
    return {
      status: indexed.status === "stale" ? "stale" : "blocked",
      serviceId,
      indexed: false,
      registered: false,
      gatewayReady: false,
      diagnostics
    };
  }

  const rawDefinition: MCPServiceDefinition = await tools.createGitNexusService({
    executable: binary.executable,
    version: binary.version,
    repositoryRoot: canonicalRoot,
    stateRoot: gitnexusStateRoot,
    configRoot: join(platform.paths.config, "tool-launches"),
    operation: repoOperation
  });
  const definition = MCPServiceDefinitionSchema.parse({
    ...rawDefinition,
    tool: {
      ...rawDefinition.tool,
      required: false,
      operations: [...GITNEXUS_OPERATIONS]
    }
  });

  const entry: RegisteredRepositoryService = RegisteredRepositoryServiceSchema.parse({
    schemaVersion: 3,
    repositoryId: repository.id,
    workspaceRoot: canonicalRoot,
    service: definition,
    registeredAt: new Date().toISOString()
  });

  await validateRepositoryServiceLaunch(entry, platform.paths, platform.machineId, binary);
  await upsertRegisteredRepositoryService(platform.paths.state, platform.machineId, entry);

  if (!existsSync(locatorPath)) {
    diagnostics.push("Repository GitNexus index and registration were saved, but the machine Gateway is not running. Run 'bflow setup' to start the Gateway.");
    return {
      status: "blocked",
      serviceId,
      indexed: true,
      registered: true,
      gatewayReady: false,
      diagnostics
    };
  }

  const dynamicRes = await registerGatewayRepositoryService(locatorPath, {
    entry,
    operation: repoOperation
  });
  if (!dynamicRes.ok) {
    diagnostics.push(`Repository GitNexus index and registration were saved, but dynamic Gateway activation failed (${dynamicRes.error.message}). Run 'bflow setup' to verify the Gateway.`);
    return {
      status: "blocked",
      serviceId,
      indexed: true,
      registered: true,
      gatewayReady: false,
      diagnostics
    };
  }

  const observation: MCPServiceObservation = dynamicRes.value;
  const gatewayReady =
    observation.status === "ready" &&
    GITNEXUS_OPERATIONS.every(op => observation.discoveredTools.includes(op));
  if (!gatewayReady) {
    diagnostics.push(`Gateway registered '${serviceId}', but its status is '${observation.status}'.`);
  }

  return {
    status: gatewayReady ? "ready" : "blocked",
    serviceId,
    indexed: true,
    registered: true,
    gatewayReady,
    diagnostics
  };
}

/** True when this repository already has a registration, so 'bflow init' was approved for it before. */
export async function isRepositoryGitNexusRegistered(input: {
  readonly repository: RepositoryIdentity;
  readonly platform: PlatformProfile;
}): Promise<boolean> {
  const canonicalRoot = await realpath(input.repository.root).catch(() => input.repository.root);
  const state = await readGatewayRepositoriesState(input.platform.paths.state, input.platform.machineId);
  return state.state?.repositories.some(item => item.workspaceRoot === canonicalRoot) ?? false;
}

/**
 * Unregisters a repository's GitNexus service from `gateway-repositories.json` and stops/removes
 * it on the running Gateway (`bflow init --remove`). The workspace may already be deleted from disk.
 */
export async function removeRepositoryGitNexus(input: {
  readonly workspaceRoot: string;
  readonly platform: PlatformProfile;
}): Promise<RepositoryGitNexusReport> {
  const { platform } = input;
  const canonicalRoot = await realpath(input.workspaceRoot).catch(() => resolve(input.workspaceRoot));
  const serviceId = gitNexusServiceId(canonicalRoot);
  const diagnostics: string[] = [];

  const { removed } = await removeRegisteredRepositoryService(platform.paths.state, platform.machineId, {
    workspaceRoot: canonicalRoot,
    serviceId
  });

  const locatorPath = join(platform.paths.state, GATEWAY_CONTROL_LOCATOR_FILE);
  for (const entry of removed) {
    if (!existsSync(locatorPath)) break;
    const removedRes = await removeGatewayRepositoryService(locatorPath, {
      serviceId: entry.service.serviceId,
      operation: ScopedOperationSchema.parse({
        schemaVersion: 3,
        scope: entry.service.scope,
        idempotencyKey: `remove-gitnexus-${entry.repositoryId}-${randomUUID()}`
      })
    });
    if (!removedRes.ok && removedRes.error.code !== "not_found") {
      diagnostics.push(`Removed '${entry.service.serviceId}' from ${GATEWAY_REPOSITORIES_FILE}; running Gateway reported: ${removedRes.error.message}`);
    }
  }

  diagnostics.push(removed.length
    ? `Removed repository GitNexus registration '${serviceId}' for '${canonicalRoot}'.`
    : `No repository GitNexus registration exists for '${canonicalRoot}'.`);
  return {
    status: "removed",
    serviceId,
    indexed: false,
    registered: false,
    gatewayReady: false,
    diagnostics
  };
}

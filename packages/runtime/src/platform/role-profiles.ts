import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { defaultRolePrompt, providerRolePolicyDigest } from "@bflow/agent-providers";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AgentRoleSchema, canonicalReceiptJson, ResolvedRoleProfileSnapshotSchema, RoleProfilePinSchema, ResolvedToolGrantSchema,
  ROLE_PROFILE_FEATURE, sameRoleProfilePin,
  type AgentRole, type ResolvedRoleProfileSnapshot, type RoleProfilePin
} from "@bflow/contracts";
import type { PlatformSessionIdentity, RolePlatformRequirement } from "./ports.js";

const hash = (value: unknown): string => createHash("sha256").update(canonicalReceiptJson(value)).digest("hex");

export function computeRolePolicyDigest(role: AgentRole, policy: { builtinPrompt: string; hostPolicy: string; providerPolicy: string }): string {
  return hash({ feature: ROLE_PROFILE_FEATURE, role: AgentRoleSchema.parse(role), policyVersion: 1, ...policy });
}
function policyBytes(path: URL): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("installed governance policy material is invalid");
    const bytes = readFileSync(fd);
    if (bytes.length > 2 * 1024 * 1024) throw new Error("installed governance policy material exceeds limit");
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}
/** Bind actual installed policy bytes. Source tests must build first, as required by repository policy.
 * Compiled files are read as data only; no sibling package module is loaded by path. */
const policyDigestCache = new Map<AgentRole, string>();
/** Computed once per process: the digest binds the policy this process loaded, and rebuilding dist underneath a
 * running host must not change it (a new process observes the new bytes and its snapshots are re-resolved). */
export function baseRolePolicyDigest(role: AgentRole): string {
  const cached = policyDigestCache.get(role);
  if (cached !== undefined) return cached;
  const computed = computeBaseRolePolicyDigest(role);
  policyDigestCache.set(role, computed);
  return computed;
}
function computeBaseRolePolicyDigest(role: AgentRole): string {
  const assetRole: Partial<Record<AgentRole, string>> = { conversation: "chat", coordinator: "coordinator", developer: "developer", reviewer: "reviewer",
    qa: "verifier", specifier: "analyst", architect: "architect", planner: "planner" };
  const builtinPrompt = assetRole[role] ? policyBytes(new URL(`../../../../agents/${assetRole[role]}/system-prompt.md`, import.meta.url)) : defaultRolePrompt(role);
  const hostPolicy = ["agentic/host.js", "agentic/host-development.js", "agentic/outbox.js", "platform/role-profiles.js"]
    .map(path => policyBytes(new URL(`../../dist/${path}`, import.meta.url))).join("\n\u0000\n");
  const providerPolicy = providerRolePolicyDigest();
  return computeRolePolicyDigest(role, { builtinPrompt, hostPolicy, providerPolicy });
}

export function assertRoleProfilePin(expected: RoleProfilePin | undefined, actual: RoleProfilePin | undefined, label = "role profile"): void {
  if (expected !== undefined) RoleProfilePinSchema.parse(expected);
  if (actual !== undefined) RoleProfilePinSchema.parse(actual);
  if (!sameRoleProfilePin(expected, actual)) throw new Error(`${label} pin mismatch`);
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !/[\\\0*?\[\]{}]/.test(path) &&
    path.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git" && !segment.toLowerCase().startsWith(".bflow"));
}
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** Lexical admission only; filesystem callers must additionally resolve symlink ancestors under their trusted root. */
export function profilePathAllowed(path: string, allowed: readonly string[] | undefined, denied: readonly string[] = []): boolean {
  return safePath(path) && (allowed === undefined || allowed.some(root => safePath(root) && within(path, root))) &&
    !denied.some(root => !safePath(root) || within(path, root));
}

function intersectPaths(left: readonly string[] | undefined, right: readonly string[] | undefined): string[] | undefined {
  if (left === undefined && right === undefined) return undefined;
  for (const value of [...(left ?? []), ...(right ?? [])]) if (!safePath(value)) throw new Error("role profile path scope invalid");
  if (left === undefined) return [...right!].sort();
  if (right === undefined) return [...left].sort();
  return [...new Set(left.flatMap(a => right.flatMap(b => within(a, b) ? [a] : within(b, a) ? [b] : [])))].sort();
}

/** Pure, idempotent policy resolution. Preferences replace defaults, never locks or grants. */
export function resolveRoleProfile(input: ResolvedRoleProfileSnapshot, requirement: RolePlatformRequirement): RolePlatformRequirement {
  const snapshot = ResolvedRoleProfileSnapshotSchema.parse(input);
  const { definition, pin } = snapshot;
  if (definition.baseRole !== requirement.role) throw new Error("role profile base role mismatch");
  if (snapshot.baseRolePolicyDigest !== baseRolePolicyDigest(requirement.role)) throw new Error("role profile builtin policy mismatch");
  if (requirement.roleProfile !== undefined) assertRoleProfilePin(pin, ResolvedRoleProfileSnapshotSchema.parse(requirement.roleProfile).pin);
  const preferences = definition.preferences;
  // Provider-bound native login, grants and host routing still use the configured template.
  // Switching only the adapter would claim support without switching that authority end to end.
  if (preferences?.provider !== undefined && preferences.provider !== requirement.provider)
    throw new Error("role profile provider switch unsupported: native login and host tool bindings require the configured base provider");
  const model = preferences?.model ?? requirement.model;
  const effort = preferences?.effort ?? requirement.effort;
  for (const key of ["model", "effort"] as const) {
    const candidate = key === "model" ? model : effort;
    const constraint = requirement.preferenceConstraints?.[key];
    if (constraint !== undefined && candidate !== constraint)
      throw new Error(`role profile ${key} conflicts with workflow pack lock`);
  }
  if (requirement.provider === "agy" && effort !== undefined)
    throw new Error("Agy effort must be encoded in the configured model name");
  const restrictions = definition.restrictions;
  // Native reads include shell subprocesses, git objects and verification runners. Existing backends do not
  // establish that whole-process restriction; hooks or a narrowed prompt cannot serve as proof.
  if (restrictions.readablePaths !== undefined || (restrictions.deniedPaths?.length ?? 0) > 0 || (requirement.deniedPaths?.length ?? 0) > 0)
    throw new Error("role profile read/deny restrictions unsupported for provider process tree");
  const writablePaths = intersectPaths(requirement.writablePaths, restrictions.writablePaths);
  if (writablePaths !== undefined && writablePaths.length > 0 && requirement.permissionMode !== "restricted" && requirement.provider !== "agy")
    throw new Error("role profile writable subtrees unsupported for unmediated native provider process tree");
  let network = requirement.network ?? { mode: "deny" as const, allowedHosts: [] };
  if (restrictions.networkHosts !== undefined) {
    const allowedHosts = network.mode === "deny" ? [] : network.allowedHosts.filter(host => restrictions.networkHosts!.includes(host)).sort();
    network = allowedHosts.length ? { mode: "allowlist", allowedHosts } : { mode: "deny", allowedHosts: [] };
    if (allowedHosts.length > 0) throw new Error("role profile network host restrictions unsupported for provider process tree");
  }
  const skillSelections = requirement.skillSelections.map(selection => ({ ...selection, skill: { ...selection.skill } }));
  for (const skill of definition.skillPins) {
    const existing = skillSelections.find(selection => selection.skill.skillId === skill.skillId);
    if (existing && (existing.skill.version !== skill.version || existing.skill.digest !== skill.digest))
      throw new Error(`role profile skill pin conflict: ${skill.skillId}`);
    if (!existing) skillSelections.push({ skill, required: true });
    else existing.required = true;
  }
  const allowedTools = restrictions.tools;
  const grants = requirement.toolGrants?.map(grant => ResolvedToolGrantSchema.parse(grant)).flatMap(grant => {
    const allowed = allowedTools?.find(tool => tool.toolId === grant.toolId);
    const operations = allowedTools === undefined ? [...grant.operations] : grant.operations.filter(operation => allowed?.operations.includes(operation));
    if (grant.requiredness === "required" && operations.length !== grant.operations.length)
      throw new Error(`role profile removes required tool operations: ${grant.toolId}`);
    const capabilityIds = grant.capabilityIds === undefined ? undefined : grant.capabilityIds.filter(id =>
      restrictions.capabilityIds === undefined || restrictions.capabilityIds.includes(id));
    if (capabilityIds?.length === 0) {
      if (grant.requiredness === "required") throw new Error(`role profile removes required tool capability: ${grant.toolId}`);
      return [];
    }
    return operations.length === 0 ? [] : [{ ...grant, operations,
      ...(capabilityIds !== undefined ? { capabilityIds } : {}) }];
  });
  const toolIds = requirement.toolIds.filter(id => (allowedTools === undefined || allowedTools.some(tool => tool.toolId === id)) &&
    (grants === undefined || grants.some(grant => grant.toolId === id)));
  for (const needed of definition.toolRequirements) {
    if (!toolIds.includes(needed.toolId)) throw new Error(`role profile required tool unavailable: ${needed.toolId}`);
    if (!grants?.some(grant => grant.toolId === needed.toolId && needed.operations.every(operation => grant.operations.includes(operation))))
      throw new Error(`role profile required tool grant unavailable: ${needed.toolId}`);
  }
  if (allowedTools !== undefined && requirement.mcpServiceIds.length && grants === undefined)
    throw new Error("role profile tool operation restrictions require exact mediated grants");
  const effectiveServices = grants === undefined ? requirement.mcpServiceIds : requirement.mcpServiceIds.filter(id => grants.some(grant => grant.serviceId === id));
  return { ...requirement, roleProfile: snapshot,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(writablePaths !== undefined ? { writablePaths } : {}), network,
    capabilityIds: requirement.capabilityIds.filter(id => restrictions.capabilityIds === undefined || restrictions.capabilityIds.includes(id)),
    toolIds, skillSelections, mcpServiceIds: effectiveServices,
    ...(grants !== undefined ? { toolGrants: grants, mcpOperations: [...new Set(grants.flatMap(grant => grant.operations))].sort() } : {}) };
}

export function appendRoleProfileInstructions(original: string, input: ResolvedRoleProfileSnapshot | undefined): string {
  if (input === undefined) return original;
  const snapshot = ResolvedRoleProfileSnapshotSchema.parse(input);
  return `${original}\n\n# Specialist profile ${snapshot.pin.profileId} (${snapshot.pin.version})\n${snapshot.definition.additionalInstructions}`;
}

export function roleProfilePolicyDigest(requirement: RolePlatformRequirement): string {
  const resolved = requirement.roleProfile === undefined ? requirement : resolveRoleProfile(requirement.roleProfile, requirement);
  return hash(resolved);
}

function snapshotPath(identity: PlatformSessionIdentity, pin: RoleProfilePin): string {
  RoleProfilePinSchema.parse(pin);
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) throw new Error("role profile snapshot generation invalid");
  return join(identity.stateDirectory, `gen-${identity.generation}`, "role-profiles", `${pin.digest}.json`);
}

function identityPath(identity: PlatformSessionIdentity, pin: RoleProfilePin): string {
  return join(dirname(snapshotPath(identity, pin)), `identity-${hash({ profileId: pin.profileId, version: pin.version })}.json`);
}

async function publishImmutableJson(file: string, value: unknown): Promise<boolean> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(`${canonicalReceiptJson(value)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temp, file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return false; }
  } finally { await rm(temp, { force: true }); }
}

async function readPrivateJson(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("snapshot must be a private regular file");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 262144 || (stat.mode & 0o077) !== 0) throw new Error("snapshot file invalid");
    const bytes = Buffer.alloc(262145);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    if (count > 262144) throw new Error("snapshot too large");
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally { await handle.close(); }
}

/** Host-owned immutable snapshot; publication cannot replace an existing snapshot. */
export async function persistRoleProfileSnapshot(identity: PlatformSessionIdentity, input: ResolvedRoleProfileSnapshot): Promise<string> {
  const snapshot = ResolvedRoleProfileSnapshotSchema.parse(input);
  const file = snapshotPath(identity, snapshot.pin), directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error("role profile snapshot directory must not contain symlinks");
  const index = identityPath(identity, snapshot.pin);
  await publishImmutableJson(index, snapshot.pin);
  try { assertRoleProfilePin(snapshot.pin, RoleProfilePinSchema.parse(await readPrivateJson(index)), "snapshot identity"); }
  catch { throw new Error("role profile snapshot ID/version conflict or corrupted identity proof"); }
  // The snapshot file is digest-addressed and never replaced, so publishing is safe whenever the identity proof
  // matches. This repairs an interrupted earlier call that wrote only the identity.
  await publishImmutableJson(file, snapshot);
  const stored = await loadRoleProfileSnapshot(identity, snapshot.pin);
  if (canonicalReceiptJson(stored) !== canonicalReceiptJson(snapshot)) throw new Error("role profile snapshot conflicts with existing immutable proof");
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
  return file;
}

export async function loadRoleProfileSnapshot(identity: PlatformSessionIdentity, pin: RoleProfilePin): Promise<ResolvedRoleProfileSnapshot> {
  const file = snapshotPath(identity, pin);
  try {
    if (await realpath(dirname(file)) !== dirname(file)) throw new Error("symlinked directory");
    assertRoleProfilePin(pin, RoleProfilePinSchema.parse(await readPrivateJson(identityPath(identity, pin))), "snapshot identity");
    const snapshot = ResolvedRoleProfileSnapshotSchema.parse(await readPrivateJson(file));
    assertRoleProfilePin(pin, snapshot.pin, "snapshot");
    return snapshot;
  } catch { throw new Error("role profile snapshot missing or corrupted"); }
}

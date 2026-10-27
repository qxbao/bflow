import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, parse, sep } from "node:path";
import {
  AgentProviderIdSchema,
  canonicalReceiptJson,
  SkillManifestSchema,
  Sha256DigestSchema,
  type AgentRole,
  type OperationResult,
  type SkillManifest
} from "@bflow/contracts";
import type { RenderedSkills, ResolveSkillsRequest } from "@bflow/skills";
import { fail, ok } from "./errors.js";
import { boundedIdentifier, sessionTrustScope, taskIdError } from "./environment.js";
import type {
  PlatformSessionIdentity,
  ResolvedRoleSkills,
  RolePlatformRequirement,
  SkillResolverPort,
  SkillSessionPort
} from "./ports.js";

interface PersistedRoleSkills {
  readonly schemaVersion: 3;
  readonly manifest: SkillManifest;
  readonly rendered: RenderedSkills;
  readonly diagnostics: string[];
}

/** `sync` (not bare resolve) persists the `manifest-<digest>` document that `recover` reads back. */
export type SkillSessionResolver = SkillResolverPort;

export class SkillSessionStore implements SkillSessionPort {
  constructor(private readonly options: { readonly resolver: SkillSessionResolver }) {}

  async resolveForRole(
    identity: PlatformSessionIdentity,
    requirement: RolePlatformRequirement,
    environmentId: string
  ): Promise<OperationResult<ResolvedRoleSkills>> {
    const taskError = taskIdError(requirement.taskId);
    if (taskError) return fail("validation", taskError);
    const file = recordPath(identity, requirement.role, requirement.taskId);
    try {
      const synced = await this.options.resolver.sync(buildRequest(identity, requirement, environmentId));
      const manifest = await this.options.resolver.verify(synced.manifest);
      if (manifest.environmentId !== environmentId || manifest.role !== requirement.role ||
          manifest.provider !== requirement.provider)
        return fail("validation", "resolved skill manifest identity mismatch");
      const rendered = synced.rendered;
      const diagnostics = [...synced.diagnostics];
      const record: PersistedRoleSkills = { schemaVersion: 3, manifest, rendered, diagnostics };
      const persisted = await persistRecord(file, record);
      if (!persisted.ok) return persisted;
      return ok({ manifest, rendered, diagnostics });
    } catch (error) {
      return fail("validation", errorMessage(error));
    }
  }

  async load(
    identity: PlatformSessionIdentity,
    role: AgentRole,
    taskId?: string
  ): Promise<OperationResult<ResolvedRoleSkills | null>> {
    const taskError = taskIdError(taskId);
    if (taskError) return fail("validation", taskError);
    const file = recordPath(identity, role, taskId);
    try {
      const raw = await readRecordFile(file);
      if (!raw.ok) return raw;
      if (raw.value === null) return ok(null);
      const stored = parseRecord(raw.value);
      if (!stored.ok) return stored;
      const { manifest, rendered, diagnostics } = stored.value;
      if (manifest.role !== role) return fail("corruption", "stored skill record role mismatch");
      let recovered: SkillManifest;
      try {
        recovered = await this.options.resolver.recover(manifest.digest);
      } catch (error) {
        return fail("validation", `skill manifest recovery failed: ${errorMessage(error)}`);
      }
      if (canonicalReceiptJson(recovered) !== canonicalReceiptJson(manifest))
        return fail("conflict", "skill manifest drift");
      return ok({ manifest: recovered, rendered, diagnostics });
    } catch (error) {
      return fail("validation", errorMessage(error));
    }
  }
}

function buildRequest(
  identity: PlatformSessionIdentity,
  requirement: RolePlatformRequirement,
  environmentId: string
): ResolveSkillsRequest {
  return {
    manifestId: boundedIdentifier(`manifest-${environmentId}`),
    environmentId,
    scope: sessionTrustScope(identity),
    role: requirement.role,
    provider: requirement.provider,
    capabilityIds: [...requirement.capabilityIds],
    toolIds: [...requirement.toolIds],
    ...(requirement.dependencySkillApprovals ? { dependencyApprovals: [...requirement.dependencySkillApprovals] } : {}),
    selections: requirement.skillSelections.map(selection => ({
      skill: { skillId: selection.skill.skillId, version: selection.skill.version, digest: selection.skill.digest },
      required: selection.required,
      ...(selection.approvalReceiptId !== undefined ? { approvalReceiptId: selection.approvalReceiptId } : {})
    }))
  };
}

function recordPath(identity: PlatformSessionIdentity, role: AgentRole, taskId: string | undefined): string {
  const task = taskId ? `-${taskId}` : "";
  return `${identity.stateDirectory}/gen-${identity.generation}/skills/${role}${task}.json`;
}

/** Writes a record atomically; an existing record with a different manifest digest is never overwritten. */
async function persistRecord(
  file: string,
  record: PersistedRoleSkills
): Promise<OperationResult<void>> {
  await ensurePrivateDirectory(dirname(file));
  const existing = await readRecordFile(file);
  if (!existing.ok) return existing;
  if (existing.value !== null) {
    const stored = parseRecord(existing.value);
    if (!stored.ok) return stored;
    if (stored.value.manifest.digest !== record.manifest.digest)
      return fail("conflict", "skill record exists with a different manifest digest");
    return ok(undefined);
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  const directory = await open(dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return ok(undefined);
}

/** Creates missing directories (0700) from the filesystem root down; any symlink or non-directory in the path is refused. */
async function ensurePrivateDirectory(target: string): Promise<void> {
  const root = parse(target).root;
  let current = root;
  for (const segment of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stats = await lstatOrNull(current);
    if (stats === null) {
      await mkdir(current, { mode: 0o700 });
    } else if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`refusing symlinked or non-directory state path: ${current}`);
    }
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readRecordFile(file: string): Promise<OperationResult<string | null>> {
  const stats = await lstatOrNull(file);
  if (stats === null) return ok(null);
  if (!stats.isFile()) return fail("corruption", "skill record is not a regular file");
  return ok(await readFile(file, "utf8"));
}

function parseRecord(text: string): OperationResult<PersistedRoleSkills> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("corruption", "skill record is malformed JSON");
  }
  const record = recordEnvelope(raw);
  if (!record) return fail("corruption", "skill record failed schema validation");
  return ok(record);
}

/** Envelope checks use the contract schemas directly; the envelope itself is local to this store. */
function recordEnvelope(raw: unknown): PersistedRoleSkills | null {
  if (!isRecord(raw) || raw["schemaVersion"] !== 3 || !Array.isArray(raw["diagnostics"])) return null;
  const diagnostics = raw["diagnostics"];
  if (!diagnostics.every(item => typeof item === "string")) return null;
  const manifest = SkillManifestSchema.safeParse(raw["manifest"]);
  const rendered = renderedSkills(raw["rendered"]);
  if (!manifest.success || !rendered || rendered.manifestDigest !== manifest.data.digest) return null;
  return { schemaVersion: 3, manifest: manifest.data, rendered, diagnostics: diagnostics as string[] };
}

function renderedSkills(raw: unknown): RenderedSkills | null {
  if (!isRecord(raw) || typeof raw["instructionText"] !== "string" || !Array.isArray(raw["references"])) return null;
  const provider = AgentProviderIdSchema.safeParse(raw["provider"]);
  const manifestDigest = Sha256DigestSchema.safeParse(raw["manifestDigest"]);
  if (!provider.success || !manifestDigest.success) return null;
  const references: RenderedSkills["references"][number][] = [];
  for (const item of raw["references"]) {
    if (!isRecord(item) || typeof item["name"] !== "string" || typeof item["description"] !== "string" ||
        typeof item["entrypoint"] !== "string") return null;
    const digest = Sha256DigestSchema.safeParse(item["digest"]);
    if (!digest.success) return null;
    references.push({ name: item["name"], description: item["description"], entrypoint: item["entrypoint"], digest: digest.data });
  }
  return { provider: provider.data, manifestDigest: manifestDigest.data, instructionText: raw["instructionText"], references };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

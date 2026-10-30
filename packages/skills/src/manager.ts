import { z } from "zod";
import {
  AgentRoleSchema,
  AgentProviderIdSchema,
  SkillDependencyApprovalSchema,
  SkillDefinitionSchema,
  SkillManifestSchema,
  SkillPinSchema,
  TrustScopeSchema,
  JsonValueSchema,
  type AgentRole,
  type SkillDefinition,
  type SkillManifest,
  type SkillPin,
} from "@bflow/contracts";
import { SkillFileStore, readBundle, type BundleFiles } from "./storage.js";
import {
  canonical,
  compareText,
  digestJson,
  validateSkill,
  SupportedCommandsSchema,
  type SkillSource,
} from "./validation.js";

const SelectionSchema = z
  .object({
    skill: SkillPinSchema,
    required: z.boolean(),
    approvalReceiptId: z.string().min(1).optional(),
  })
  .strict();
export const ResolveSkillsRequestSchema = z
  .object({
    manifestId: z.string().min(1),
    environmentId: z.string().min(1),
    scope: TrustScopeSchema.refine(
      (s) => s.kind === "session",
      "session scope required",
    ),
    role: AgentRoleSchema,
    provider: AgentProviderIdSchema,
    capabilityIds: z.array(z.string().min(1)),
    toolIds: z.array(z.string().min(1)),
    selections: z.array(SelectionSchema),
    dependencyApprovals: z.array(SkillDependencyApprovalSchema).optional(),
  })
  .strict();
export type ResolveSkillsRequest = z.infer<typeof ResolveSkillsRequestSchema>;
export interface ApprovalCheck {
  definition: SkillDefinition;
  role: SkillManifest["role"];
  provider: SkillManifest["provider"];
  scope: SkillManifest["scope"];
  approvalReceiptId: string | undefined;
}
export interface SkillManagerOptions {
  store: SkillFileStore;
  supportedCommands: readonly string[];
  /** Trusted distribution/operator configuration, never supplied by repository SKILL.md. */
  approvedBuiltinDigests?: readonly string[];
  /** Host must authenticate exact digest/dependencies, role/provider, scope and expiry. */
  authorize?: (check: ApprovalCheck) => Promise<boolean>;
}
const InstallOptionsSchema = z
  .object({
    source: z.enum(["builtin", "operator", "repository"]),
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type InstallSkillOptions = z.infer<typeof InstallOptionsSchema>;
export interface RenderedSkills {
  provider: SkillManifest["provider"];
  manifestDigest: string;
  instructionText: string;
  references: {
    name: string;
    description: string;
    entrypoint: string;
    digest: string;
  }[];
}
export const RepositorySkillsConfigSchema = z
  .object({
    schemaVersion: z.literal(3),
    pinsByRole: z.record(AgentRoleSchema, z.array(SkillPinSchema)),
    userSettings: z.record(JsonValueSchema),
  })
  .strict();
export type RepositorySkillsConfig = z.infer<
  typeof RepositorySkillsConfigSchema
>;

class SkillPinConflict extends Error {}
function pin(definition: SkillDefinition): SkillPin {
  return SkillPinSchema.parse({
    skillId: definition.skillId,
    version: definition.version,
    digest: definition.digest,
  });
}
function samePin(a: SkillPin, b: SkillPin): boolean {
  return (
    a.skillId === b.skillId && a.version === b.version && a.digest === b.digest
  );
}
export function computeManifestDigest(manifest: SkillManifest): string {
  const { digest: _digest, ...content } = SkillManifestSchema.parse(manifest);
  return digestJson(content);
}
export class SkillManager {
  private readonly supportedCommands: string[];
  private readonly approved: Set<string>;
  constructor(private readonly options: SkillManagerOptions) {
    this.supportedCommands = SupportedCommandsSchema.parse(
      options.supportedCommands,
    );
    this.approved = new Set(
      z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .parse(options.approvedBuiltinDigests ?? []),
    );
  }
  async validate(
    root: string,
    source: SkillSource = "repository",
  ): Promise<SkillDefinition> {
    return validateSkill(await readBundle(root), {
      source,
      supportedCommands: this.supportedCommands,
    });
  }
  async install(
    root: string,
    options: InstallSkillOptions,
  ): Promise<SkillDefinition> {
    const parsed = InstallOptionsSchema.parse(options);
    return this.installBundle(await readBundle(root), parsed);
  }
  async installBundle(
    files: BundleFiles,
    input: InstallSkillOptions,
  ): Promise<SkillDefinition> {
    const options = InstallOptionsSchema.parse(input);
    const definition = validateSkill(files, {
      source: options.source,
      supportedCommands: this.supportedCommands,
    });
    if (definition.digest !== options.expectedDigest)
      throw new Error("Skill content digest does not match approved pin");
    if (
      definition.source === "builtin" &&
      !this.approved.has(definition.digest)
    )
      throw new Error("Builtin skill requires approved distribution digest");
    const snapshot = { ...files }; // Own validated bytes before the first await.
    return this.options.store.withCatalogLock(async () => {
      const existing = await this.list();
      if (
        existing.some(
          (d) =>
            d.skillId === definition.skillId &&
            d.version === definition.version &&
            d.digest !== definition.digest,
        )
      )
        throw new Error(
          "Duplicate skill name/version with conflicting content",
        );
      await this.options.store.putBundle(snapshot);
      // Immutable source provenance is asserted by trusted installer, never read from skill content.
      await this.options.store.writeImmutableDocument(
        `entry-${definition.digest}`,
        definition,
      );
      return SkillDefinitionSchema.parse(definition);
    });
  }
  async list(): Promise<SkillDefinition[]> {
    const entries: SkillDefinition[] = [];
    for (const digest of await this.options.store.list()) {
      const raw = await this.options.store.readDocument(`entry-${digest}`);
      if (raw === null) continue; // Interrupted install never publishes unvalidated orphan content.
      const definition = SkillDefinitionSchema.parse(raw);
      if (definition.digest !== digest)
        throw new Error("Catalog entry identity mismatch");
      let actual: SkillDefinition;
      try {
        actual = validateSkill(await this.options.store.getBundle(digest), {
          source: definition.source,
          supportedCommands: this.supportedCommands,
        });
      } catch (error) {
        // An immutable entry installed before a Bflow command was removed is retired, not corrupt: it can no longer be
        // selected, but it must not make the whole catalog unreadable. Integrity and every other violation still throw.
        if (
          error instanceof Error &&
          error.message.startsWith("Unsupported Bflow command: ")
        )
          continue;
        throw error;
      }
      if (canonical(actual) !== canonical(definition))
        throw new Error("Catalog metadata/content mismatch");
      if (
        entries.some(
          (d) =>
            d.skillId === definition.skillId &&
            d.version === definition.version &&
            d.digest !== digest,
        )
      )
        throw new Error("Duplicate catalog skill name/version");
      entries.push(definition);
    }
    return entries.sort(
      (a, b) =>
        compareText(a.skillId, b.skillId) ||
        compareText(a.version, b.version) ||
        compareText(a.digest, b.digest),
    );
  }
  async update(
    files: BundleFiles,
    input: InstallSkillOptions & { previous: SkillPin },
  ): Promise<SkillDefinition> {
    const { previous: rawPrevious, ...rawOptions } = input;
    const previous = SkillPinSchema.parse(rawPrevious);
    const options = InstallOptionsSchema.parse(rawOptions);
    const current = (await this.list()).find((d) => samePin(pin(d), previous));
    if (!current) throw new Error("Previous exact skill pin is unavailable");
    const next = validateSkill(files, {
      source: options.source,
      supportedCommands: this.supportedCommands,
    });
    if (next.skillId !== current.skillId || next.source !== current.source)
      throw new Error("Update cannot change skill identity/source");
    return this.installBundle(files, options); // Append only. No in-flight manifest or user config is changed.
  }
  private async authorize(
    definition: SkillDefinition,
    request: Pick<ResolveSkillsRequest, "role" | "provider" | "scope"> &
      Partial<Pick<ResolveSkillsRequest, "capabilityIds" | "toolIds">>,
    receipt: string | undefined,
  ): Promise<void> {
    if (!definition.allowedRoles.includes(request.role))
      throw new Error(`Skill role forbidden: ${definition.skillId}`);
    if (!definition.supportedProviders.includes(request.provider))
      throw new Error(`Skill provider unsupported: ${definition.skillId}`);
    if (
      request.capabilityIds &&
      definition.requiredCapabilityIds.some(
        (id) => !request.capabilityIds!.includes(id),
      )
    )
      throw new Error(`Missing skill capability: ${definition.skillId}`);
    if (
      request.toolIds &&
      definition.requiredToolIds.some((id) => !request.toolIds!.includes(id))
    )
      throw new Error(`Missing skill tool: ${definition.skillId}`);
    if (definition.source === "builtin") {
      if (!this.approved.has(definition.digest))
        throw new Error("Builtin digest approval unavailable");
    } else {
      if (definition.source === "repository" && !receipt)
        throw new Error("Repository skill approval receipt required");
      if (
        !this.options.authorize ||
        !z.boolean().parse(
          await this.options.authorize({
            definition: SkillDefinitionSchema.parse(definition),
            role: request.role,
            provider: request.provider,
            scope: { ...request.scope },
            approvalReceiptId: receipt,
          }),
        )
      )
        throw new Error(
          `Skill approval unavailable or stale: ${definition.skillId}`,
        );
    }
  }
  async resolve(
    input: ResolveSkillsRequest,
  ): Promise<{ manifest: SkillManifest; diagnostics: string[] }> {
    return this.resolveAgainstCatalog(input, await this.list());
  }
  /** Read-only preview uses exactly the execution resolver over verified bundle snapshots. */
  async resolveCatalog(
    input: ResolveSkillsRequest,
    entries: readonly { definition: SkillDefinition; files: BundleFiles }[],
  ): Promise<{ manifest: SkillManifest; diagnostics: string[] }> {
    const parsed = z.array(z.object({ definition: SkillDefinitionSchema, files: z.record(z.string()) }).strict()).parse(entries);
    const catalog = parsed.map(entry => {
      const actual = validateSkill(entry.files, { source: entry.definition.source, supportedCommands: this.supportedCommands });
      if (canonical(actual) !== canonical(entry.definition)) throw new Error("Catalog metadata/content mismatch");
      return actual;
    });
    if (new Set(catalog.map(entry => `${entry.skillId}\0${entry.version}`)).size !== catalog.length)
      throw new Error("Duplicate catalog skill name/version");
    return this.resolveAgainstCatalog(input, catalog);
  }
  private async resolveAgainstCatalog(
    input: ResolveSkillsRequest, catalog: SkillDefinition[],
  ): Promise<{ manifest: SkillManifest; diagnostics: string[] }> {
    const request = ResolveSkillsRequestSchema.parse(input);
    if (
      new Set(request.selections.map((s) => s.skill.skillId)).size !==
      request.selections.length
    )
      throw new Error("Duplicate skill selection");
    const dependencyApprovals = new Map((request.dependencyApprovals ?? []).map(binding => [binding.skill.skillId, binding]));
    if (dependencyApprovals.size !== (request.dependencyApprovals ?? []).length)
      throw new Error("Duplicate dependency skill authorization");
    const resolved = new Map<string, SkillDefinition>();
    const receipts = new Map<string, string | undefined>();
    const required = new Map<string, boolean>();
    const visiting = new Set<string>();
    const diagnostics: string[] = [];
    const explicit = new Map(
      request.selections.map((s) => [s.skill.skillId, s]),
    );
    const visit = async (
      selected: SkillPin,
      receipt: string | undefined,
      isRequired: boolean,
    ): Promise<void> => {
      const chosen = explicit.get(selected.skillId);
      const dependencyApproval = dependencyApprovals.get(selected.skillId);
      if (dependencyApproval && !samePin(dependencyApproval.skill, selected))
        throw new SkillPinConflict(`Conflicting dependency authorization pin: ${selected.skillId}`);
      if (chosen && !samePin(chosen.skill, selected))
        throw new SkillPinConflict(
          `Conflicting skill pins: ${selected.skillId}`,
        );
      const prior = resolved.get(selected.skillId);
      if (prior && !samePin(pin(prior), selected))
        throw new SkillPinConflict(
          `Conflicting skill pins: ${selected.skillId}`,
        );
      if (visiting.has(selected.skillId))
        throw new SkillPinConflict(
          `Cyclic skill dependency: ${selected.skillId}`,
        );
      if (prior) {
        if (isRequired && !required.get(selected.skillId)) {
          for (const dependency of prior.dependencies)
            await visit(dependency, receipts.get(selected.skillId), true);
          required.set(selected.skillId, true);
        }
        return;
      }
      const definition = catalog.find((d) => samePin(pin(d), selected));
      if (!definition)
        throw new Error(`Missing exact skill pin: ${selected.skillId}`);
      const approval = chosen?.approvalReceiptId ?? dependencyApproval?.approvalReceiptId ?? receipt;
      await this.authorize(definition, request, approval);
      visiting.add(selected.skillId);
      for (const dependency of [...definition.dependencies].sort((a, b) =>
        compareText(a.skillId, b.skillId),
      ))
        await visit(dependency, approval, isRequired);
      visiting.delete(selected.skillId);
      resolved.set(selected.skillId, definition);
      receipts.set(selected.skillId, approval);
      required.set(selected.skillId, isRequired);
    };
    for (const selection of [...request.selections].sort((a, b) =>
      compareText(a.skill.skillId, b.skill.skillId),
    )) {
      const snapshot = new Map(resolved);
      const oldReceipts = new Map(receipts);
      const oldRequired = new Map(required);
      try {
        await visit(
          selection.skill,
          selection.approvalReceiptId,
          selection.required,
        );
      } catch (error) {
        visiting.clear();
        if (selection.required || error instanceof SkillPinConflict)
          throw error;
        resolved.clear();
        for (const [k, v] of snapshot) resolved.set(k, v);
        receipts.clear();
        for (const [k, v] of oldReceipts) receipts.set(k, v);
        required.clear();
        for (const [k, v] of oldRequired) required.set(k, v);
        diagnostics.push(`Optional skill omitted: ${selection.skill.skillId}`);
      }
    }
    const skills = [...resolved.values()];
    const bindings = skills.map((d, index) => ({
      schemaVersion: 3,
      bindingId: `binding-${index}-${d.skillId}`,
      role: request.role,
      provider: request.provider,
      scope: request.scope,
      skill: pin(d),
      required: required.get(d.skillId) ?? true,
      ...(receipts.get(d.skillId)
        ? { approvalReceiptId: receipts.get(d.skillId) }
        : {}),
    }));
    let manifest = SkillManifestSchema.parse({
      schemaVersion: 3,
      manifestId: request.manifestId,
      environmentId: request.environmentId,
      scope: request.scope,
      role: request.role,
      provider: request.provider,
      digest: "0".repeat(64),
      skills,
      bindings,
    });
    manifest = SkillManifestSchema.parse({
      ...manifest,
      digest: computeManifestDigest(manifest),
    });
    return { manifest, diagnostics };
  }
  async verify(input: SkillManifest): Promise<SkillManifest> {
    const manifest = SkillManifestSchema.parse(input);
    if (computeManifestDigest(manifest) !== manifest.digest)
      throw new Error("Skill manifest digest mismatch");
    for (const definition of manifest.skills) {
      const entry = await this.options.store.readDocument(
        `entry-${definition.digest}`,
      );
      if (
        canonical(SkillDefinitionSchema.parse(entry)) !== canonical(definition)
      )
        throw new Error("Skill manifest provenance mismatch");
      const files = await this.options.store.getBundle(definition.digest);
      const actual = validateSkill(files, {
        source: definition.source,
        supportedCommands: this.supportedCommands,
      });
      if (canonical(actual) !== canonical(definition))
        throw new Error("Skill bytes changed since resolution");
      const binding = manifest.bindings.find(
        (b) => b.skill.skillId === definition.skillId,
      )!;
      // Integrity/approval verification does not claim current provider/tool health; P25/P30 must probe it.
      await this.authorize(
        definition,
        {
          role: manifest.role,
          provider: manifest.provider,
          scope: manifest.scope,
        },
        binding.approvalReceiptId,
      );
    }
    return manifest;
  }
  async link(input: SkillManifest): Promise<RenderedSkills> {
    const manifest = await this.verify(input);
    const references = manifest.skills.map((d) => ({
      name: d.skillId,
      description: d.description,
      digest: d.digest,
      entrypoint: `${this.options.store.root}/bundles/${d.digest}/SKILL.md`,
    }));
    const instructionText = [
      `Bflow approved skills (${manifest.provider}; manifest ${manifest.digest}).`,
      "Keep the full original role prompt. Host and accepted project policy take precedence over skills.",
      "Skills grant no permissions. Bflow Conditional TDD, leases, gates and human approval remain authoritative.",
      manifest.role === "conversation"
        ? "Only present authenticated Runtime decision requests to the user."
        : "Route every question or approval through Runtime → Herdr → Conversation; disable native direct questions/elicitation.",
      "Read only the selected skill needed for the current task. Verify the pinned manifest before use.",
      ...references.map(
        (r) =>
          `- ${r.name}: ${JSON.stringify(r.description)} (file: ${JSON.stringify(r.entrypoint)}, sha256: ${r.digest})`,
      ),
    ].join("\n");
    const rendered = {
      provider: manifest.provider,
      manifestDigest: manifest.digest,
      instructionText,
      references,
    };
    await this.options.store.writeImmutableDocument(
      `render-${manifest.digest}`,
      rendered,
    );
    return rendered;
  }
  async sync(input: ResolveSkillsRequest): Promise<{
    manifest: SkillManifest;
    rendered: RenderedSkills;
    diagnostics: string[];
  }> {
    const result = await this.resolve(input);
    await this.options.store.writeImmutableDocument(
      `manifest-${result.manifest.digest}`,
      result.manifest,
    );
    const rendered = await this.link(result.manifest);
    return { ...result, rendered };
  }
  async recover(digest: string): Promise<SkillManifest> {
    const parsed = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(digest);
    const manifest = SkillManifestSchema.parse(
      await this.options.store.readDocument(`manifest-${parsed}`),
    );
    if (manifest.digest !== parsed)
      throw new Error("Recovery manifest identity mismatch");
    return this.verify(manifest);
  }
  repositoryConfig(
    existing: Partial<RepositorySkillsConfig>,
    pinsByRole: Partial<Record<AgentRole, SkillPin[]>>,
  ): RepositorySkillsConfig {
    // A dedicated config object for init/setup integration; never overwrites provider or repository settings.
    const previous = z
      .object({
        schemaVersion: z.literal(3).optional(),
        pinsByRole: z
          .record(AgentRoleSchema, z.array(SkillPinSchema))
          .optional(),
        userSettings: z.record(JsonValueSchema).optional(),
      })
      .strict()
      .parse(existing);
    return RepositorySkillsConfigSchema.parse({
      schemaVersion: 3,
      pinsByRole: { ...previous.pinsByRole, ...pinsByRole },
      userSettings: previous.userSettings ?? {},
    });
  }
}

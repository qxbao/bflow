import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MCPServiceDefinitionSchema, type MCPServiceDefinition } from "@bflow/contracts";
import { z } from "zod";
import { canonicalJson, digest } from "./canonical.js";
import type { SetupStateStore } from "./state-store.js";
import type {
  ComponentDesiredState,
  ComponentObservation,
  PlatformProfile,
  SetupComponent,
  SetupContext
} from "./types.js";

export const McpConfigFileSchema = z
  .object({
    schemaVersion: z.literal(3),
    services: z.record(MCPServiceDefinitionSchema),
    /** Ids owned by bflow; entries carry no ownership marker themselves. */
    managedIds: z.array(z.string()),
    external: z.unknown().optional()
  })
  .strict();
export type McpConfigFile = z.infer<typeof McpConfigFileSchema>;

export interface McpConfigComponentOptions {
  platform: PlatformProfile;
  store: SetupStateStore;
  services: readonly MCPServiceDefinition[];
}

type Loaded =
  | { state: "absent"; bytes: null }
  | { state: "valid"; bytes: string; file: McpConfigFile }
  | { state: "invalid"; bytes: string | null; reason: string; salvage: Pick<McpConfigFile, "services" | "external"> };

/** Stable pretty JSON: keys sorted recursively, two-space indent, trailing newline. */
function render(file: McpConfigFile): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(file)), null, 2)}\n`;
}

export class McpConfigComponent implements SetupComponent {
  readonly componentId = "mcp-config";
  readonly action = "register_mcp" as const;
  readonly rollback = "restore_owned_config" as const;

  private readonly platform: PlatformProfile;
  private readonly store: SetupStateStore;
  private readonly services: readonly MCPServiceDefinition[];

  constructor(options: McpConfigComponentOptions) {
    this.platform = options.platform;
    this.store = options.store;
    this.services = options.services;
  }

  get filePath(): string {
    return path.join(this.platform.paths.config, "mcp.json");
  }

  private inputErrors(): string[] {
    const errs: string[] = [];
    const seen = new Set<string>();
    for (const s of this.services) {
      if (seen.has(s.serviceId)) errs.push(`duplicate MCP service id: ${s.serviceId}`);
      seen.add(s.serviceId);
      if (s.scope.kind !== "machine")
        errs.push(`MCP service ${s.serviceId} must have machine scope (got ${s.scope.kind})`);
      else if (s.scope.machineId !== this.platform.machineId)
        errs.push(`MCP service ${s.serviceId} scope machineId ${s.scope.machineId} does not match this machine`);
    }
    return errs;
  }

  private desiredMap(): Record<string, MCPServiceDefinition> {
    const out: Record<string, MCPServiceDefinition> = {};
    for (const s of this.services) out[s.serviceId] = s;
    return out;
  }

  private async load(): Promise<Loaded> {
    let bytes: string;
    try {
      if (!(await stat(this.filePath)).isFile()) {
        return { state: "invalid", bytes: null, reason: `${this.filePath} is not a regular file`, salvage: { services: {} } };
      }
      bytes = await readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", bytes: null };
      return { state: "invalid", bytes: null, reason: `cannot read ${this.filePath}`, salvage: { services: {} } };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes);
    } catch {
      return { state: "invalid", bytes, reason: "mcp.json is not valid JSON", salvage: { services: {} } };
    }
    const parsed = McpConfigFileSchema.safeParse(raw);
    if (parsed.success) return { state: "valid", bytes, file: parsed.data };
    const obj = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const version = obj["schemaVersion"];
    const reason =
      typeof version === "number" && version !== 3
        ? `mcp.json has unsupported schemaVersion ${version}`
        : "mcp.json does not match the v3 schema";
    const services: Record<string, MCPServiceDefinition> = {};
    const rawServices = obj["services"];
    if (rawServices !== null && typeof rawServices === "object" && !Array.isArray(rawServices)) {
      for (const [id, v] of Object.entries(rawServices)) {
        const p = MCPServiceDefinitionSchema.safeParse(v);
        if (p.success) services[id] = p.data;
      }
    }
    return { state: "invalid", bytes, reason, salvage: { services, external: obj["external"] } };
  }

  private next(base: Pick<McpConfigFile, "services" | "external">): McpConfigFile {
    const desired = this.desiredMap();
    const file: McpConfigFile = {
      schemaVersion: 3,
      services: { ...base.services, ...desired },
      managedIds: Object.keys(desired).sort()
    };
    if (base.external !== undefined) file.external = base.external;
    return file;
  }

  async observe(_ctx: SetupContext): Promise<ComponentObservation> {
    const diagnostics = this.inputErrors();
    const loaded = await this.load();
    if (loaded.state === "invalid") {
      return { stateDigest: null, valid: false, diagnostics: [...diagnostics, loaded.reason] };
    }
    const valid = diagnostics.length === 0;
    if (loaded.state === "absent") {
      return { stateDigest: this.services.length === 0 ? digest({}) : null, valid, diagnostics };
    }
    const owned: Record<string, MCPServiceDefinition> = {};
    for (const id of loaded.file.managedIds) {
      const s = loaded.file.services[id];
      if (s !== undefined) owned[id] = s;
    }
    return { stateDigest: digest(owned), valid, diagnostics };
  }

  async desired(_ctx: SetupContext): Promise<ComponentDesiredState> {
    const errs = this.inputErrors();
    const loaded = await this.load();
    return {
      digest: digest(this.desiredMap()),
      summary:
        errs.length > 0
          ? `Invalid MCP service definitions: ${errs.join("; ")}`
          : `Register ${this.services.length} shared MCP service(s) in ${this.filePath}`,
      targets: [this.filePath],
      machineWide: false,
      repairNeeded: loaded.state === "invalid"
    };
  }

  async apply(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    if (ctx.mode === "check" || ctx.mode === "dry_run") {
      return { ownedPaths: [], diagnostics: [`MCP apply skipped in ${ctx.mode} mode; nothing written`] };
    }
    const errs = this.inputErrors();
    if (errs.length > 0) return { ownedPaths: [], diagnostics: errs };
    const loaded = await this.load();
    if (loaded.state === "invalid" && ctx.mode !== "repair") {
      return { ownedPaths: [], diagnostics: [`${loaded.reason}; run setup --repair`] };
    }
    const base =
      loaded.state === "valid" ? loaded.file : loaded.state === "invalid" ? loaded.salvage : { services: {} };
    const bytes = render(this.next(base));
    if (loaded.state !== "absent" && bytes === loaded.bytes) return { ownedPaths: [this.filePath], diagnostics: [] };
    if (loaded.state !== "absent") {
      const b = await this.store.backupFile(this.filePath);
      if (!b.ok) return { ownedPaths: [], diagnostics: [`backup failed: ${b.error.message}`] };
    }
    const w = await this.store.writeFileAtomic(this.filePath, bytes, 0o600);
    if (!w.ok) return { ownedPaths: [], diagnostics: [`mcp.json write failed: ${w.error.message}`] };
    return { ownedPaths: [this.filePath], diagnostics: [] };
  }
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentProviderIdSchema,
  MCPServiceDefinitionSchema,
  PlatformSchemaVersionSchema,
  SecretReferenceSchema,
  type ContractError
} from "@bflow/contracts";
import { z } from "zod";
import { unsupportedVersion, validationError } from "./errors.js";
import { ToolInstallDescriptorSchema } from "./installer-registry.js";

const CREDENTIAL_VALUE = /(sk-|ghp_|xox[bp]-|AKIA)[A-Za-z0-9]/;
const CREDENTIAL_KEY = /(token|secret|password|api[_-]?key)/i;

const EnvValueSchema = z.string().refine((v) => !CREDENTIAL_VALUE.test(v), "credential-looking value");

export const ServiceDefinitionSchema = z
  .object({
    serviceId: z.string().regex(/^[a-z0-9-]+$/),
    program: z.string().refine((p) => path.posix.isAbsolute(p) || path.win32.isAbsolute(p), "absolute path required"),
    args: z.array(z.string()),
    env: z.record(z.union([SecretReferenceSchema, EnvValueSchema])),
    keepAlive: z.boolean()
  })
  .strict();
export type ServiceDefinition = z.infer<typeof ServiceDefinitionSchema>;

export const MachineConfigSchema = z
  .object({
    schemaVersion: PlatformSchemaVersionSchema,
    providers: z.array(AgentProviderIdSchema),
    toolPins: z.array(ToolInstallDescriptorSchema),
    mcpServices: z.array(MCPServiceDefinitionSchema),
    services: z.array(ServiceDefinitionSchema),
    skills: z.object({ catalogRef: z.string().nullable() }).strict(),
    secrets: z.record(SecretReferenceSchema)
  })
  .strict();
export type MachineConfig = z.infer<typeof MachineConfigSchema>;

export interface MachineConfigLoadResult {
  status: "absent" | "valid" | "invalid" | "unsupported_version";
  config?: MachineConfig;
  error?: ContractError;
}

export function defaultMachineConfig(): MachineConfig {
  return {
    schemaVersion: 3,
    providers: [],
    toolPins: [],
    mcpServices: [],
    services: [],
    skills: { catalogRef: null },
    secrets: {}
  };
}

function findCredential(value: unknown, keyPath: string): string | null {
  if (typeof value === "string") {
    return CREDENTIAL_VALUE.test(value) ? keyPath : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findCredential(value[i], `${keyPath}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const p = keyPath === "" ? k : `${keyPath}.${k}`;
      if (typeof v === "string" && CREDENTIAL_KEY.test(k) && !v.startsWith("secret://")) return p;
      const hit = findCredential(v, p);
      if (hit) return hit;
    }
  }
  return null;
}

/** Read-only: never creates files or directories. */
export async function loadMachineConfig(file: string): Promise<MachineConfigLoadResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent", config: defaultMachineConfig() };
    return { status: "invalid", error: validationError(`cannot read machine config: ${(e as Error).message}`) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "invalid", error: validationError("machine config is not valid JSON") };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "invalid", error: validationError("machine config must be a JSON object") };
  }
  const version = (raw as Record<string, unknown>).schemaVersion;
  if (typeof version === "number" && version !== 3) {
    return {
      status: "unsupported_version",
      error: unsupportedVersion(`unsupported machine config schemaVersion ${version}`, version, [3])
    };
  }
  const leak = findCredential(raw, "");
  if (leak !== null) {
    return {
      status: "invalid",
      error: validationError("machine config contains a credential-looking value; use secret:// references", {
        path: leak
      })
    };
  }
  const parsed = MachineConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "invalid", error: validationError(`invalid machine config: ${parsed.error.message}`) };
  }
  return { status: "valid", config: parsed.data };
}

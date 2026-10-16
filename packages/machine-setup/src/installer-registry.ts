import {
  PlatformSchemaVersionSchema,
  Sha256DigestSchema,
  ToolInstallRequestSchema,
  type OperationResult,
  type ToolInstaller,
  type ToolInstallRequest
} from "@bflow/contracts";
import { z } from "zod";
import { conflictError, validationError } from "./errors.js";
import type { PlatformProfile } from "./types.js";

const IdSchema = z.string().trim().min(1).max(200);

export const ToolInstallDescriptorSchema = z
  .object({
    schemaVersion: PlatformSchemaVersionSchema,
    toolId: IdSchema,
    installerId: IdSchema,
    method: z.enum(["npm", "pnpm", "homebrew", "winget", "verified_archive"]),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "exact semver required (no range/latest)"),
    source: z.string().refine((s) => {
      try {
        const u = new URL(s);
        return u.protocol === "https:" && u.username === "" && u.password === "";
      } catch {
        return false;
      }
    }, "https source required"),
    integrity: Sha256DigestSchema,
    platforms: z.array(z.enum(["linux", "darwin", "win32"])).min(1),
    requiresElevation: z.boolean()
  })
  .strict();
export type ToolInstallDescriptor = z.infer<typeof ToolInstallDescriptorSchema>;

const PREFERENCE: Record<"linux" | "darwin" | "win32", readonly ToolInstallDescriptor["method"][]> = {
  darwin: ["homebrew", "npm", "pnpm", "verified_archive"],
  linux: ["npm", "pnpm", "verified_archive", "homebrew"],
  win32: ["winget", "npm", "pnpm", "verified_archive"]
};

export class ToolInstallerRegistry {
  private readonly installers = new Map<string, ToolInstaller>();

  register(installer: ToolInstaller): OperationResult<void> {
    if (this.installers.has(installer.installerId)) {
      return { ok: false, error: conflictError(`installer already registered: ${installer.installerId}`) };
    }
    this.installers.set(installer.installerId, installer);
    return { ok: true, value: undefined };
  }

  /** Installer registered under `installerId`, or null. */
  get(installerId: string): ToolInstaller | null {
    return this.installers.get(installerId) ?? null;
  }

  resolve(
    toolId: string,
    platform: "linux" | "darwin" | "win32",
    descriptors: readonly unknown[]
  ): { descriptor: ToolInstallDescriptor; installer: ToolInstaller } | null {
    const prefs = PREFERENCE[platform];
    const candidates: { descriptor: ToolInstallDescriptor; installer: ToolInstaller; rank: number; idx: number }[] = [];
    descriptors.forEach((raw, idx) => {
      const parsed = ToolInstallDescriptorSchema.safeParse(raw);
      if (!parsed.success) return;
      const d = parsed.data;
      if (d.toolId !== toolId || !d.platforms.includes(platform)) return;
      const installer = this.installers.get(d.installerId);
      if (!installer) return;
      const rank = prefs.indexOf(d.method);
      if (rank < 0) return;
      candidates.push({ descriptor: d, installer, rank, idx });
    });
    candidates.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
    const first = candidates[0];
    return first ? { descriptor: first.descriptor, installer: first.installer } : null;
  }
}

export function buildInstallRequest(
  descriptor: ToolInstallDescriptor,
  platform: PlatformProfile
): OperationResult<ToolInstallRequest> {
  const d = ToolInstallDescriptorSchema.safeParse(descriptor);
  if (!d.success) return { ok: false, error: validationError(`invalid install descriptor: ${d.error.message}`) };
  const v = d.data;
  const req = ToolInstallRequestSchema.safeParse({
    schemaVersion: 3,
    toolId: v.toolId,
    installerId: v.installerId,
    version: v.version,
    source: v.source,
    integrity: v.integrity,
    scope: { kind: "machine", machineId: platform.machineId },
    destination: v.method === "verified_archive" ? platform.paths.managedBin : v.method,
    idempotencyKey: `install:${platform.machineId}:${v.toolId}:${v.version}:${v.integrity}`
  });
  if (!req.success) return { ok: false, error: validationError(`invalid install request: ${req.error.message}`) };
  return { ok: true, value: req.data };
}

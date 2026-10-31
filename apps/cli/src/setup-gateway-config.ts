import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MCPServiceDefinitionSchema, ScopedOperationSchema } from "@bflow/contracts";
import { digest, ToolInstallDescriptorSchema } from "@bflow/machine-setup";
import { gitSafeDirectoryFlags, sanitizedGitEnv } from "./git-safe-directory.js";

/** GitNexus indexes a commit; an unborn HEAD (no commits yet) has nothing to index. */
export function repositoryHasCommits(repositoryRoot: string): boolean {
  try {
    execFileSync(
      "git",
      [...gitSafeDirectoryFlags(repositoryRoot), "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      {
        cwd: repositoryRoot,
        env: sanitizedGitEnv(),
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 15_000
      }
    );
    return true;
  } catch {
    return false;
  }
}

export const ApprovalSchema = z
  .object({
    policyVersion: z.literal(2),
    repositorySelected: z.boolean(),
    browserExecutable: z.string().nullable(),
    // A Gateway approved by an earlier release names the retired Context7 service. It is still readable so setup can recognise
    // it as stale and replace it; it is never launched, and its key fingerprint is never used.
    remoteServices: z
      .array(
        z.union([
          z.object({ toolId: z.literal("deepwiki") }).strict(),
          z
            .object({
              toolId: z.literal("context7"),
              authenticated: z.boolean(),
              keyFingerprint: z.string().nullable()
            })
            .strict()
        ])
      )
      .default([]),
    requirements: z.array(
      z
        .object({
          toolId: z.enum(["gitnexus", "chrome-devtools-mcp", "mempalace"]),
          executable: z.string(),
          args: z.array(z.string()),
          requirements: z.array(z.string()),
          version: z.string().min(1),
          pin: ToolInstallDescriptorSchema
        })
        .strict()
    )
  })
  .strict();

export const GatewayConfigSchema = z
  .object({
    schemaVersion: z.literal(3),
    desiredDigest: z.string().regex(/^[a-f0-9]{64}$/),
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    operation: ScopedOperationSchema,
    services: z.array(MCPServiceDefinitionSchema),
    generatedIds: z.array(z.string()),
    receiptPath: z.string().min(1),
    paths: z
      .object({
        config: z.string(),
        data: z.string(),
        state: z.string(),
        managedBin: z.string()
      })
      .strict(),
    approval: ApprovalSchema.optional()
  })
  .strict();

export type SavedGatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function ownedConfiguration(file: string): SavedGatewayConfig | undefined {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) {
      throw new Error("Invalid owned Gateway configuration file");
    }
    const saved = GatewayConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (saved.definitionDigest !== digest(saved.services)) {
      throw new Error("Invalid owned Gateway configuration checksum");
    }
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function configurationDigest(saved: SavedGatewayConfig): string {
  if (!saved.approval) {
    throw new Error("Gateway configuration needs a canonical approved launch specification; rerun setup");
  }
  return digest({
    setupPolicyVersion: saved.approval.policyVersion,
    machineId: saved.operation.scope.machineId,
    repositoryRoot: saved.operation.scope.kind === "machine" ? "" : saved.operation.scope.workspaceRoot,
    paths: saved.paths,
    repositorySelected: saved.approval.repositorySelected,
    browserExecutable: saved.approval.browserExecutable,
    requirements: saved.approval.requirements,
    // Omitted when empty so a Gateway installed before remote services existed keeps the digest it was approved with.
    ...(saved.approval.remoteServices.length > 0 ? { remoteServices: saved.approval.remoteServices } : {}),
    services: saved.services.filter((item) => !saved.generatedIds.includes(item.serviceId))
  });
}

/** The GitNexus executable machine setup approved; 'bflow init' and the Gateway trust no other binary for repository services. */
export function approvedGitNexusExecutable(
  configDirectory: string
): { readonly executable: string; readonly version: string } | undefined {
  try {
    const saved = ownedConfiguration(join(configDirectory, "setup-gateway.json"));
    if (
      !saved?.approval ||
      saved.operation.scope.kind !== "machine" ||
      configurationDigest(saved) !== saved.desiredDigest
    ) {
      return undefined;
    }
    const item = saved.approval.requirements.find((candidate) => candidate.toolId === "gitnexus");
    return item ? { executable: item.executable, version: item.version } : undefined;
  } catch {
    return undefined;
  }
}

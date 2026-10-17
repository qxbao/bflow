import { IdentifierSchema, IsoDateTimeSchema, PlatformSchemaVersionSchema } from "@bflow/contracts";
import { z } from "zod";
import { PathComponent } from "./path-manager.js";
import type { MachineConfigLoadResult } from "./machine-config.js";
import type { ToolObservation } from "./tools.js";
import type { SetupComponent, SetupContext } from "./types.js";

export const DoctorCheckSchema = z
  .object({
    checkId: IdentifierSchema,
    status: z.enum(["passed", "warning", "failed", "skipped"]),
    summary: z.string().min(1),
    remediation: z.string().min(1).optional()
  })
  .strict();
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const MachineDoctorReportSchema = z
  .object({
    schemaVersion: PlatformSchemaVersionSchema,
    machineId: IdentifierSchema,
    healthy: z.boolean(),
    checkedAt: IsoDateTimeSchema,
    checks: z.array(DoctorCheckSchema)
  })
  .strict();
export type MachineDoctorReport = z.infer<typeof MachineDoctorReportSchema>;

export interface DoctorInput {
  machineId: string;
  observations: readonly ToolObservation[];
  configStatus: MachineConfigLoadResult["status"];
  components: readonly SetupComponent[];
  componentFailures?: readonly { componentId: string; message: string }[];
}

export interface SetupDoctor {
  run(ctx: SetupContext, input: DoctorInput): Promise<MachineDoctorReport>;
}

const PROVIDER_TOOLS = ["claude", "codex", "agy"];
const COMPONENT_CHECKS: readonly { componentId: string; checkId: string; label: string; fix: string }[] = [
  { componentId: "path", checkId: "path-block", label: "managed PATH block", fix: "Run `bflow setup --repair`." },
  { componentId: "mcp-config", checkId: "mcp-config", label: "mcp.json", fix: "Run `bflow setup --repair`; the invalid file is backed up first." },
  { componentId: "services", checkId: "services", label: "OS services", fix: "Run `bflow setup` to install or restart the services." },
  { componentId: "role-skills", checkId: "role-skills", label: "role skills", fix: "Run `bflow setup` to resynchronize skills." }
];

export class BuiltinSetupDoctor implements SetupDoctor {
  /** Read-only: components are only observed, never applied. */
  async run(ctx: SetupContext, input: DoctorInput): Promise<MachineDoctorReport> {
    const checks: DoctorCheck[] = (input.componentFailures ?? []).map((failure) => ({
      checkId: `planning-${failure.componentId}`, status: "failed", summary: failure.message
    }));

    const pathComponent = input.components.find((c): c is PathComponent => c instanceof PathComponent);
    let ownedPathDirs: readonly string[] = [];
    if (pathComponent) {
      try {
        const observed = await pathComponent.observe(ctx);
        const desired = await pathComponent.desired(ctx);
        if (observed.valid && observed.stateDigest === desired.digest) ownedPathDirs = await pathComponent.desiredDirs();
      } catch { /* The component check below reports the observation failure. */ }
    }
    for (const o of input.observations) {
      const managedPath = o.status === "path_missing" && o.pathMissingDir !== null && ownedPathDirs.includes(o.pathMissingDir);
      const ok = o.status === "present" || managedPath;
      const status: DoctorCheck["status"] = managedPath ? "warning" : ok ? "passed" : o.required ? "failed" : "warning";
      checks.push({
        checkId: `tool-${o.toolId}`,
        status,
        summary: ok
          ? `${o.toolId} ${o.version ?? "present"}${managedPath ? "; managed PATH configured; reload your shell" : ""}`
          : `${o.toolId} ${o.status.replace(/_/g, " ")}${o.diagnostics.length > 0 ? `: ${o.diagnostics.join("; ")}` : ""}`,
        ...(ok ? {} : { remediation: `Install or fix ${o.toolId} manually, then rerun setup.` })
      });
      if (PROVIDER_TOOLS.includes(o.toolId) && ok) {
        checks.push({
          checkId: `provider-auth-${o.toolId}`,
          status: "warning",
          summary: `login not verified by setup; run \`${o.toolId}\` interactively`,
          remediation: `Run \`${o.toolId}\` interactively and complete its own login flow.`
        });
      }
    }

    const cfg: Record<MachineConfigLoadResult["status"], DoctorCheck> = {
      valid: { checkId: "machine-config", status: "passed", summary: "machine config is valid" },
      absent: {
        checkId: "machine-config",
        status: "warning",
        summary: "machine config is absent; defaults apply",
        remediation: "Create the machine config to declare providers, tool pins, services and MCP services."
      },
      invalid: {
        checkId: "machine-config",
        status: "failed",
        summary: "machine config is invalid",
        remediation: "Fix the machine config; setup never rewrites it."
      },
      unsupported_version: {
        checkId: "machine-config",
        status: "failed",
        summary: "machine config has an unsupported schemaVersion",
        remediation: "Migrate the machine config to schemaVersion 3."
      }
    };
    checks.push(cfg[input.configStatus]);

    for (const spec of COMPONENT_CHECKS) {
      const comp = input.components.find((c) => c.componentId === spec.componentId);
      if (comp === undefined) {
        checks.push({ checkId: spec.checkId, status: "skipped", summary: `${spec.label} not configured` });
        continue;
      }
      try {
        const obs = await comp.observe(ctx);
        if (!obs.valid) {
          checks.push({
            checkId: spec.checkId,
            status: "failed",
            summary: `${spec.label} invalid${obs.diagnostics.length > 0 ? `: ${obs.diagnostics.join("; ")}` : ""}`,
            remediation: spec.fix
          });
        } else if (obs.diagnostics.length > 0) {
          checks.push({
            checkId: spec.checkId,
            status: "warning",
            summary: `${spec.label}: ${obs.diagnostics.join("; ")}`,
            remediation: spec.fix
          });
        } else {
          checks.push({ checkId: spec.checkId, status: "passed", summary: `${spec.label} ok` });
        }
      } catch (e) {
        checks.push({
          checkId: spec.checkId,
          status: "failed",
          summary: `${spec.label} could not be observed: ${e instanceof Error ? e.message : String(e)}`,
          remediation: spec.fix
        });
      }
    }

    return MachineDoctorReportSchema.parse({
      schemaVersion: 3,
      machineId: input.machineId,
      healthy: !checks.some((c) => c.status === "failed"),
      checkedAt: ctx.now().toISOString(),
      checks
    });
  }
}

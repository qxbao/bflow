import { probeTools, TOOL_CATALOG } from "@bflow/machine-setup";
import type { JsonValue } from "@bflow/contracts";
import type { CommandSpec } from "../args.js";
import { HIGH_LEVEL_EXIT_CODES, HighLevelError, notFoundError } from "../envelope.js";
import { guarded, StepLog, type HighLevelHandler } from "../context.js";

export const TOOL_STATUS_SPEC: CommandSpec = {
  name: "tool.status",
  behavior: { summary: "Check path, version and digest of each catalog tool", mutates: "none", retry: "read_only", permissionFlags: [], outcomes: ["ready", "not_ready", "failed"] },
  words: ["tool", "status"],
  positionals: [],
  flags: { "--tool": { type: "string", multiple: true } }
};

/** Read-only probe of the P26 tool catalog; never installs or upgrades anything. */
export const toolStatus: HighLevelHandler = async (args, ctx) => {
  const log = new StepLog();
  return guarded("tool.status", log, {}, async () => {
    const selected = args.lists.get("--tool");
    const known = TOOL_CATALOG.map(entry => entry.toolId);
    const unknown = (selected ?? []).filter(id => !known.includes(id));
    if (unknown.length > 0)
      throw new HighLevelError(notFoundError(`Unknown tool(s): ${unknown.join(", ")}. Known tools: ${known.join(", ")}`,
        { reason: "tool_not_found", known }));
    const platform = await log.check("detect-platform", () => ctx.services.machine.platform(),
      value => ({ os: value.os, arch: value.arch, supportStatus: value.supportStatus, machineId: value.machineId }));
    const required = new Set(selected ?? TOOL_CATALOG.filter(entry => entry.defaultRequired).map(entry => entry.toolId));
    const observations = await log.check("probe-tools", () => probeTools(platform, ctx.services.machine.runner(), { required }),
      value => ({ probed: value.length }));
    const tools = observations
      .filter(o => selected === undefined || selected.includes(o.toolId))
      .map(o => {
        const entry = TOOL_CATALOG.find(e => e.toolId === o.toolId)!;
        const healthy = o.status === "present";
        return {
          toolId: o.toolId, kind: entry.kind, status: o.status, healthy, required: o.required, version: o.version,
          requirement: entry.requirement.type === "present" ? "present" : `${entry.requirement.type === "min" ? ">=" : "="}${entry.requirement.version}`,
          path: o.resolvedPath, binaryDigest: o.binaryDigest, pathMissingDir: o.pathMissingDir, diagnostics: o.diagnostics,
          ...(healthy ? {} : { remediation: entry.manualGuidance[platform.os === "other" ? "linux" : platform.os] })
        };
      });
    const blocking = tools.filter(t => t.required && !t.healthy).map(t => t.toolId);
    const data: JsonValue = { platform: { os: platform.os, arch: platform.arch, machineId: platform.machineId }, tools, blocking };
    return {
      command: "tool.status", outcome: blocking.length === 0 ? "ready" : "not_ready", status: "succeeded",
      exitCode: blocking.length === 0 ? HIGH_LEVEL_EXIT_CODES.SUCCESS : HIGH_LEVEL_EXIT_CODES.NOT_READY,
      steps: log.steps, data
    };
  });
};

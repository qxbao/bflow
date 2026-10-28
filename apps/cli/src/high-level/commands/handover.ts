import { resolve } from "node:path";
import type { JsonValue } from "@bflow/contracts";
import type { CommandSpec } from "../args.js";
import { isSafeIdentifier } from "../args.js";
import { requireRepository, type HighLevelHandler } from "../context.js";
import { conflictError, HIGH_LEVEL_EXIT_CODES, HighLevelError, notFoundError, usageError, validationError } from "../envelope.js";

export const HANDOVER_INSPECT_SPEC: CommandSpec = { name: "handover.inspect", words: ["handover", "inspect"], positionals: [],
  flags: { "--run": { type: "string", required: true } },
  behavior: { summary: "Show a run's snapshot identity, integrated revision and handover eligibility (read-only)", mutates: "none",
    retry: "read_only", permissionFlags: [], outcomes: ["inspected", "failed"] } };
export const HANDOVER_EXPORT_SPEC: CommandSpec = { name: "handover.export", words: ["handover", "export"], positionals: [],
  flags: { "--run": { type: "string", required: true }, "--revision": { type: "string" }, "--snapshot": { type: "string" },
    "--out": { type: "string", required: true }, "--format": { type: "string", multiple: true, choices: ["html", "md"] },
    "--include-evidence": { type: "boolean" }, "--replace": { type: "boolean" } },
  behavior: { summary: "Export an offline HTML/Markdown handover package with a checksum manifest from one run snapshot",
    mutates: "repository", retry: "retry_safe", permissionFlags: [], outcomes: ["ready", "not_ready", "failed"] } };
export const HANDOVER_VERIFY_SPEC: CommandSpec = { name: "handover.verify", words: ["handover", "verify"],
  positionals: [], flags: { "--package": { type: "string", required: true } },
  behavior: { summary: "Verify an offline handover package's manifest, hashes, links and eligibility", mutates: "none",
    retry: "read_only", permissionFlags: [], outcomes: ["passed", "not_passed", "failed"] } };

const runtime = () => import("@bflow/runtime");

/** Runtime handover errors carry `code`; map them without exposing internal messages beyond their own text. */
function mapError(error: unknown): never {
  if (error instanceof HighLevelError) throw error;
  const code = (error as { code?: unknown } | null)?.code, message = error instanceof Error ? error.message : "Handover failed";
  if (code === "not_found") throw new HighLevelError(notFoundError(message));
  if (code === "conflict") throw new HighLevelError(conflictError(message, { reason: "handover_identity_or_output" }));
  throw new HighLevelError(validationError(message));
}
function runId(value: string | undefined): string {
  if (!value || !isSafeIdentifier(value)) throw new HighLevelError(usageError("--run requires a valid run identifier"));
  return value;
}

export const handoverInspect: HighLevelHandler = async (args, ctx) => {
  const id = runId(args.strings.get("--run"));
  const { inspectHandoverRun, openRepositoryHandoverSources } = await runtime();
  try {
    const sources = await openRepositoryHandoverSources((await requireRepository(ctx.cwd)).root);
    try {
      const inspection = await inspectHandoverRun(sources, id);
      return { command: "handover.inspect", outcome: "inspected", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS, runId: id,
        steps: [{ id: "snapshot", status: "succeeded" }], data: inspection as unknown as JsonValue };
    } finally { sources.close(); }
  } catch (error) { mapError(error); }
};

export const handoverExport: HighLevelHandler = async (args, ctx) => {
  const id = runId(args.strings.get("--run"));
  const revision = args.strings.get("--revision"), snapshot = args.strings.get("--snapshot");
  if (!revision && !snapshot) throw new HighLevelError(usageError("handover export requires --revision <integrated-commit> or --snapshot <id>"));
  const { exportHandoverPackage, openRepositoryHandoverSources, HandoverExportResultSchema } = await runtime();
  try {
    const sources = await openRepositoryHandoverSources((await requireRepository(ctx.cwd)).root);
    try {
      const formats = args.lists.get("--format") as ("html" | "md")[] | undefined;
      const result = HandoverExportResultSchema.parse(await exportHandoverPackage(sources, { runId: id, revision, snapshot,
        outputDirectory: resolve(ctx.cwd, args.strings.get("--out")!), ...(formats?.length ? { formats } : {}), clock: ctx.clock,
        includeEvidence: args.booleans.has("--include-evidence"), replace: args.booleans.has("--replace") }));
      const eligible = result.status === "eligible";
      return { command: "handover.export", outcome: eligible ? "ready" : "not_ready", status: "succeeded", runId: id,
        exitCode: eligible ? HIGH_LEVEL_EXIT_CODES.SUCCESS : HIGH_LEVEL_EXIT_CODES.NOT_READY,
        steps: [{ id: "snapshot", status: "succeeded" }, { id: result.outcome === "replaced" ? "replace" : "publish", status: result.outcome === "reused" ? "reused" : "succeeded",
          message: eligible ? "Package is eligible for handover" : `Package is ${result.status}; it is not eligible for handover` }],
        data: result as unknown as JsonValue };
    } finally { sources.close(); }
  } catch (error) { mapError(error); }
};

export const handoverVerify: HighLevelHandler = async (args, ctx) => {
  const { verifyHandoverPackage } = await runtime();
  try {
    const verification = await verifyHandoverPackage(resolve(ctx.cwd, args.strings.get("--package")!));
    const passed = verification.valid && verification.status === "eligible";
    return { command: "handover.verify", outcome: passed ? "passed" : "not_passed", status: "succeeded",
      exitCode: passed ? HIGH_LEVEL_EXIT_CODES.SUCCESS : HIGH_LEVEL_EXIT_CODES.NOT_READY,
      ...(verification.runId ? { runId: verification.runId } : {}), steps: [{ id: "verify", status: verification.valid ? "succeeded" : "failed" }],
      data: verification as unknown as JsonValue };
  } catch (error) { mapError(error); }
};

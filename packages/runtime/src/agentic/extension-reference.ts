import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readResolutionFile } from "./execution-binding.js";

/** Instructions for a model's structured output, read from the exact shipped Runtime validator. Never a permission grant. */
export async function readExtensionReference(input: unknown) {
  const family = z.enum(["analysis", "qa"]).parse(input);
  const suffix = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const path = fileURLToPath(new URL(`../${family}/model.${suffix}`, import.meta.url));
  const bytes = await readResolutionFile(path, 64 * 1024);
  return { kind: "runtime_schema_reference", family, digest: createHash("sha256").update(bytes).digest("hex"),
    intakeSchema: family === "analysis" ? "AnalysisIntakeSchema" : "QaIntakeSchema",
    outputSchemas: family === "analysis" ? "RoleOutputSchemas" : "QaRoleOutputSchemas", source: bytes.toString("utf8"),
    note: "Use the intake/output schemas for this exact family and task. These instructions grant no commands, writes, network access or human approval. Preserve undecided business facts." };
}

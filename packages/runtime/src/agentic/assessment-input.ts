import { SpecificationSchema } from "@bflow/contracts";
import { z } from "zod";

const guidance = 'P15 assess requires an explicit impact object; read planning_reference(section="specification") and supply metadata.sdd.assessment. Do not infer missing impact flags.';
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Package-local assess precondition, in addition to the unchanged public Specification contract.
 * P15's exported classifyChange remains the sole validator of the assessment's fields. */
export const AssessmentSpecificationSchema = SpecificationSchema.superRefine((spec, ctx) => {
  let value: unknown = spec;
  const path: string[] = [];
  for (const key of ["metadata", "sdd", "assessment"]) {
    value = isObject(value) ? value[key] : undefined;
    path.push(key);
    if (!isObject(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: guidance });
      return;
    }
  }
});

/** Preserve the authoritative policy's issues while locating them in the actual tool document. */
export function assessmentErrorAt(error: unknown, path: readonly string[]): never {
  if (error instanceof z.ZodError) throw new z.ZodError(error.issues.map(issue => ({ ...issue, path: [...path, ...issue.path] })));
  throw error;
}

/** The activity journal records a known schema location, never received values or arbitrary metadata keys. */
export function assessmentFailureSummary(error: unknown): string {
  if (!(error instanceof z.ZodError)) return "P15 assess failed; inspect tool error";
  const path: string[] = [];
  for (const key of ["specification", "metadata", "sdd", "assessment"]) {
    if (error.issues[0]?.path[path.length] !== key) break;
    path.push(key);
  }
  return `${path.join(".") || "assess"}: invalid input; read planning_reference`;
}

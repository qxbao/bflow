import { SkillPinSchema, WorkflowPackSchema, type SkillPin, type WorkflowPack } from "@bflow/contracts";
import { z } from "zod";
import { resolveWorkflowPack, workflowPackDigest } from "../planning/index.js";
import { ANALYSIS_SECTIONS, CORE_ANALYSIS_SECTIONS, type AnalysisSection } from "./model.js";

/**
 * An analysis pack is an ordinary pinned `WorkflowPack` (schemaVersion 3): it selects the analysis workflow,
 * its capabilities, the output policy and skill pins. It is configuration only; execution stays in Runtime/Core.
 *
 * - `workflow.id` must be {@link ANALYSIS_WORKFLOW_ID}; `workflow.version` selects the planner version.
 * - `capabilities.required` must contain {@link ANALYSIS_ONLY_CAPABILITY}; `analysis.output.<section>` entries are the
 *   output policy (sections a handoff may contain; the six core sections are always required).
 * - `skills.<role>` may pin skills only for specifier/architect/reviewer/coordinator; a Developer/QA/tester binding,
 *   any provider/tool requirement or an unknown capability is refused instead of being ignored.
 */
export const ANALYSIS_WORKFLOW_ID = "bflow.analysis-only";
export const ANALYSIS_WORKFLOW_VERSIONS = ["1"] as const;
export const ANALYSIS_ONLY_CAPABILITY = "workflow.analysis_only";
export const ANALYSIS_OUTPUT_PREFIX = "analysis.output.";
export const ANALYSIS_ROLES = ["specifier", "architect", "reviewer"] as const;
export type AnalysisRole = (typeof ANALYSIS_ROLES)[number];
const SKILL_ROLES = new Set<string>([...ANALYSIS_ROLES, "coordinator"]);

export interface AnalysisPackPolicy {
  readonly pack: { readonly id: string; readonly version: string; readonly digest: string };
  readonly workflowVersion: string;
  readonly outputSections: readonly AnalysisSection[];
  readonly skillPins: Readonly<Record<string, readonly SkillPin[]>>;
}

export interface AnalysisPackPin { readonly id: string; readonly version: string; readonly digest: string }

export class AnalysisPackRejected extends Error {
  constructor(readonly code: "pack_pin_mismatch" | "not_analysis_pack" | "forbidden_pack_field" | "invalid_output_policy", message: string) {
    super(message);
    this.name = "AnalysisPackRejected";
  }
}

const strings = (value: unknown): string[] => z.array(z.string()).parse(value ?? []);

export function resolveAnalysisPack(input: unknown, pin: AnalysisPackPin): AnalysisPackPolicy {
  const parsed = WorkflowPackSchema.safeParse(input);
  if (!parsed.success) throw new AnalysisPackRejected("not_analysis_pack", "Analysis pack is not a valid workflow pack");
  const pack: WorkflowPack = parsed.data;
  // The pin is the exact reviewed identity: content digest, then id/version/digest equality.
  if (workflowPackDigest(pack) !== pack.digest || pack.id !== pin.id || pack.version !== pin.version || pack.digest !== pin.digest)
    throw new AnalysisPackRejected("pack_pin_mismatch", "Analysis pack does not match its exact pin");
  const resolution = resolveWorkflowPack({ pack });
  if (resolution.blockers.length) throw new AnalysisPackRejected("forbidden_pack_field", `Analysis pack has blockers: ${resolution.blockers.map(item => item.code).join(", ")}`);
  const defaults = pack.defaults;
  for (const field of Object.keys(defaults)) {
    const [kind, role] = field.split(".");
    if (kind === "roles" || field === "tools.required" && strings(defaults[field]).length > 0 || kind === "skills" && !SKILL_ROLES.has(role!))
      throw new AnalysisPackRejected("forbidden_pack_field", `Analysis pack cannot set '${field}': analysis work binds no implementation role, provider or tool`);
  }
  if (defaults["workflow.id"] !== ANALYSIS_WORKFLOW_ID) throw new AnalysisPackRejected("not_analysis_pack", `workflow.id must be ${ANALYSIS_WORKFLOW_ID}`);
  const workflowVersion = String(defaults["workflow.version"] ?? "");
  if (!(ANALYSIS_WORKFLOW_VERSIONS as readonly string[]).includes(workflowVersion))
    throw new AnalysisPackRejected("not_analysis_pack", `Unsupported analysis workflow version '${workflowVersion}'`);
  const capabilities = strings(defaults["capabilities.required"]);
  if (!capabilities.includes(ANALYSIS_ONLY_CAPABILITY)) throw new AnalysisPackRejected("not_analysis_pack", `capabilities.required must contain ${ANALYSIS_ONLY_CAPABILITY}`);
  const sections: AnalysisSection[] = [];
  for (const capability of capabilities) {
    if (capability === ANALYSIS_ONLY_CAPABILITY) continue;
    const section = capability.startsWith(ANALYSIS_OUTPUT_PREFIX) ? capability.slice(ANALYSIS_OUTPUT_PREFIX.length) : undefined;
    if (section === undefined || !(ANALYSIS_SECTIONS as readonly string[]).includes(section))
      throw new AnalysisPackRejected("invalid_output_policy", `Unsupported analysis pack capability '${capability}'`);
    sections.push(section as AnalysisSection);
  }
  const missing = CORE_ANALYSIS_SECTIONS.filter(section => !sections.includes(section));
  if (missing.length) throw new AnalysisPackRejected("invalid_output_policy", `Output policy must include core sections: ${missing.join(", ")}`);
  // Workflow identity and the output policy cannot be overridden by repository or session layers.
  for (const field of ["workflow.id", "capabilities.required"])
    if (!pack.lockedFields.includes(field)) throw new AnalysisPackRejected("invalid_output_policy", `Analysis pack must lock '${field}'`);
  const skillPins: Record<string, SkillPin[]> = {};
  for (const [field, value] of Object.entries(defaults))
    if (field.startsWith("skills.")) skillPins[field.slice("skills.".length)] = z.array(SkillPinSchema).parse(value);
  return { pack: { id: pack.id, version: pack.version, digest: pack.digest }, workflowVersion,
    outputSections: ANALYSIS_SECTIONS.filter(section => sections.includes(section)), skillPins };
}

/** Builds a pack with its digest; used by fixtures/examples and by operators preparing a reviewed pack. */
export function buildAnalysisPack(input: { id: string; version: string; outputSections?: readonly AnalysisSection[];
  skills?: Readonly<Record<string, readonly SkillPin[]>> }): WorkflowPack {
  const sections = input.outputSections ?? ANALYSIS_SECTIONS;
  const defaults: Record<string, unknown> = {
    "workflow.id": ANALYSIS_WORKFLOW_ID,
    "workflow.version": "1",
    "capabilities.required": [ANALYSIS_ONLY_CAPABILITY, ...sections.map(section => `${ANALYSIS_OUTPUT_PREFIX}${section}`)]
  };
  for (const [role, pins] of Object.entries(input.skills ?? {})) defaults[`skills.${role}`] = pins;
  const body = { schemaVersion: 3 as const, id: input.id, version: input.version, digest: "0".repeat(64), defaults,
    lockedFields: ["capabilities.required", "workflow.id"] };
  return WorkflowPackSchema.parse({ ...body, digest: workflowPackDigest(body) });
}

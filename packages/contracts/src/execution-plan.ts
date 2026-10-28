import { z } from 'zod';
import { AGENT_ROLES, AgentRoleSchema } from './session.js';
import { RoleProfilePinSchema } from "./role-profile.js";
import { SkillPinSchema } from './skills.js';
import { JsonValueSchema } from './common.js';
import { ProviderFailoverPolicySchema } from './provider-failover.js';
const CredentialPattern = /(?:^sk-|^gh[pousr]_|^github_pat_|^glpat-|^xox[baprs]-|^AKIA[A-Z0-9]{16}$|bearer\s|:\/\/[^/]*@)/i;
const Name = z.string().min(1).max(256).refine(value => !CredentialPattern.test(value), 'Unsafe public identity');
const PublicSelection = Name.refine(value => !/:\/\/|\s/.test(value) && !value.startsWith('/') && !CredentialPattern.test(value), 'Unsafe declarative selection');
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PlanUnknownCodeSchema = z.enum([
  'specification_unresolved', 'accepted_workflow_unresolved', 'task_dag_unresolved',
  'provider_readiness_not_checked', 'cost_and_dynamic_allocations_unresolved',
  'legacy_resolution_baseline_unavailable'
]);
export const PlanBlockerCodeSchema = z.enum([
  'specialist_profile_policy_unavailable',
  'workflow_pack_unavailable', 'unsupported_plan_field', 'invalid_plan_value',
  'native_profile_unavailable', 'custom_skill_approval_unavailable', 'skill_pin_unavailable',
  'required_tool_pin_missing', 'required_tool_readiness_stale', 'required_tool_readiness_unavailable',
  'pack_tool_requirement_unknown', 'stale_readiness', 'skill_capability_unavailable'
]);
export const PlanReasonCodeSchema = z.enum([
  'sandbox_unavailable', 'live_preflight_not_performed', 'executable_not_inspected',
  'tool_pin_missing', 'gateway_observation_stale', 'service_definition_missing', 'gateway_snapshot_only'
]);
export const PlanLocatorSchema = z.union([
  z.enum(['builtin', 'pack', 'project', 'override', 'policy', 'runtime', 'health', 'preflight',
    'workflow-pack-allowlist', 'provider-preflight', 'accepted-workflow', 'execution-source',
    'environment.specialistProfiles', 'environment.skills.pins', 'environment.toolPolicy', 'skills/roles/bindings.json', 'skills/dependencies',
    'host-check-policy', 'conditional-tdd-policy', 'environment.sdd.approvalRequired', '.bflow/verification.json',
    'machine.state/skill-approvals.json', 'machine.state/setup-gateway-ready.json',
    'machine.toolPins.executable_not_inspected', 'machine.toolPins.missing']),
  z.string().refine(value => {
    const parts = value.split('.');
    if (CredentialPattern.test(value)) {
      return false;
    }
    if (parts[0] === 'environment' && parts[1] === 'roles') {
      return AGENT_ROLES.includes(parts[2] as typeof AGENT_ROLES[number]) && parts.length === 4 && ['cli', 'model', 'effort', 'profile-name', 'specialistProfile', 'skills', 'failover'].includes(parts[3]!);
    }
    if (parts[0] === 'environment' && parts[1] === 'defaults') {
      return ['claude', 'codex', 'agy', 'claude-code'].includes(parts[2]!) && parts.length === 4 && parts[3] === 'profile-name';
    }
    if (parts[0] === 'environment' && parts[1] === 'toolPolicy' && parts[2] === 'requirements') {
      return parts.length === 4 && PublicSelection.safeParse(parts[3]).success;
    }
    return /^(workflow\.(id|version|digest)|tools\.required|capabilities\.required)$/.test(value);
  }, 'Unsupported public source locator')
]);
export const PlanSourceSchema = z.object({
  kind: z.enum(['builtin', 'pack', 'project', 'override', 'policy', 'runtime']),
  locator: PlanLocatorSchema
}).strict();
export const PlanFieldSchema = z.string().regex(/^(workflow\.(id|version|digest)|roles\.[a-z][a-z_-]*\.(provider|model|effort|profile|specialistProfile|failover)|skills\.[a-z][a-z_-]*|tools\.required|capabilities\.required)$/).refine(field => !field.startsWith('roles.') && !field.startsWith('skills.') || AGENT_ROLES.includes(field.split('.')[1] as typeof AGENT_ROLES[number]), 'Unknown governance role');
export function isPlanFieldValue(field: string, value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (field.endsWith('.specialistProfile')) return !['conversation', 'coordinator'].includes(field.split('.')[1]!) && RoleProfilePinSchema.safeParse(value).success;
  if (field.startsWith('skills.')) {
    return z.array(SkillPinSchema).safeParse(value).success && (value as {
      skillId: string;
      version: string;
    }[]).every(pin => PublicSelection.safeParse(pin.skillId).success && PublicSelection.safeParse(pin.version).success);
  }
  if (field.endsWith('.failover')) {
    return ProviderFailoverPolicySchema.safeParse(value).success;
  }
  if (field === 'tools.required' || field === 'capabilities.required') {
    return z.array(PublicSelection).safeParse(value).success;
  }
  return PublicSelection.safeParse(value).success;
}
export const WorkflowPackSchema = z.object({
  schemaVersion: z.literal(3),
  id: PublicSelection,
  version: PublicSelection,
  digest: Digest,
  defaults: z.record(JsonValueSchema).refine(v => Object.keys(v).every(k => PlanFieldSchema.safeParse(k).success && isPlanFieldValue(k, v[k])), 'Unsupported pack field'),
  lockedFields: z.array(PlanFieldSchema).default([])
}).strict().superRefine((v, c) => {
  for (const k of v.lockedFields) {
    if (!(k in v.defaults)) {
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Locked field requires a default'
      });
    }
  }
});
export const PlanDecisionSchema = z.object({
  id: Name,
  field: PlanFieldSchema,
  candidates: z.array(z.object({
    source: PlanSourceSchema,
    value: JsonValueSchema,
    status: z.enum(['accepted', 'rejected']),
    reason: z.enum(['precedence', 'pack_locked', 'tool_policy_filter', 'skill_dependencies'])
  }).strict()),
  effective: JsonValueSchema,
  source: PlanSourceSchema,
  rule: PlanSourceSchema.optional()
}).strict().superRefine((v, c) => {
  if (!isPlanFieldValue(v.field, v.effective) || v.candidates.some(candidate => !isPlanFieldValue(v.field, candidate.value))) {
    c.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid plan field value'
    });
  }
});
export const PlanObservationSchema = z.object({
  id: Name,
  status: z.enum(['observed', 'stale', 'not_checked']),
  outcome: z.enum(['ready', 'blocked', 'missing', 'unknown']).optional(),
  reasonCode: PlanReasonCodeSchema.optional(),
  grantState: z.enum(['granted', 'not_granted', 'unknown']).optional(),
  source: PlanSourceSchema,
  checkedAt: z.string().datetime({
    offset: true
  }).optional(),
  expiresAt: z.string().datetime({
    offset: true
  }).optional(),
  revision: Name.optional()
}).strict();
const PackSelection = z.object({
  status: z.enum(['not_selected', 'selected', 'unavailable']),
  id: Name.optional(),
  version: Name.optional(),
  digest: Digest.optional()
}).strict().superRefine((v, c) => {
  if (v.status === 'selected' && (!v.id || !v.version || !v.digest)) {
    c.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Selected pack requires exact identity'
    });
  }
});
const Blocker = z.object({
  code: PlanBlockerCodeSchema,
  decisionIds: z.array(Name).default([]),
  source: PlanSourceSchema
}).strict();
export const PlanPolicyExplanationSchema = z.object({
  field: z.enum(['gates', 'tdd', 'alternativeVerification', 'approvalPoints']),
  source: PlanSourceSchema,
  reasonCode: z.enum(['mandatory_host_checks', 'owner_verification_configuration', 'awaiting_accepted_specification',
    'accepted_conditional_tdd_policy', 'accepted_alternative_verification_policy', 'project_governance_policy', 'accepted_task_approval',
    'accepted_workflow_gates']),
  decisionId: Name.optional(),
  classification: Name.optional(),
  requiresFailingTestFirst: z.boolean().optional(),
  required: z.boolean().optional()
}).strict();
const Policy = z.object({
  gates: z.array(Name).default([]),
  tdd: z.enum(['required', 'recommended', 'not_applicable', 'unresolved']).default('unresolved'),
  alternativeVerification: z.array(Name).default([]),
  requiredTools: z.array(Name).default([]),
  requiredCapabilities: z.array(Name).default([]),
  explanations: z.array(PlanPolicyExplanationSchema).default([])
}).strict();
const Accepted = z.object({
  runId: Name,
  specificationId: Name,
  specificationVersion: Name,
  workflowId: Name,
  workflowVersion: Name,
  revision: Name,
  approvalIds: z.array(Name).default([]),
  tasks: z.array(z.object({
    id: Name,
    role: AgentRoleSchema,
    requiresApproval: z.boolean().default(false),
    dependsOn: z.array(Name),
    gates: z.array(Name).default([])
  }).strict()).min(1)
}).strict().superRefine((v, c) => {
  const ids = new Set(v.tasks.map(t => t.id));
  if (ids.size !== v.tasks.length || v.tasks.some(t => t.dependsOn.some(id => !ids.has(id) || id === t.id))) {
    c.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid accepted task graph'
    });
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      return false;
    }
    if (done.has(id)) {
      return true;
    }
    visiting.add(id);
    if (!v.tasks.find(t => t.id === id)?.dependsOn.every(visit)) {
      return false;
    }
    visiting.delete(id);
    done.add(id);
    return true;
  };
  if (!v.tasks.every(t => visit(t.id))) {
    c.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Cyclic accepted task graph'
    });
  }
});
const PlanShape = {
  schemaVersion: z.literal(3),
  resolverVersion: Name,
  policyVersion: Name,
  repository: z.object({
    revision: Name,
    dirtyDigests: z.record(Digest).default({})
  }).strict(),
  components: z.record(Digest).default({}),
  decisions: z.array(PlanDecisionSchema).default([]),
  observations: z.array(PlanObservationSchema).default([]),
  mode: z.enum(['intake', 'accepted']),
  accepted: Accepted.optional(),
  pack: PackSelection.default({
    status: 'not_selected'
  }),
  policy: Policy.default({}),
  blockers: z.array(Blocker).default([]),
  unknowns: z.array(PlanUnknownCodeSchema).default([]),
  approvalPoints: z.array(z.enum(['specification_design_approval_if_required', 'governed_scope_or_policy_change', 'git_integration_if_required'])).default([])
};
function modeCheck(v: {
  mode: string;
  decisions: {
    id: string;
    field: string;
  }[];
  accepted?: {
    revision: string;
  } | undefined;
  repository: {
    revision: string;
  };
}, c: z.RefinementCtx) {
  if (new Set(v.decisions.map(d => d.id)).size !== v.decisions.length || new Set(v.decisions.map(d => d.field)).size !== v.decisions.length) {
    c.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Duplicate plan decisions'
    });
  }
  if ((v.mode === 'accepted') !== Boolean(v.accepted)) {
    c.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Accepted mode requires authoritative accepted binding; intake forbids it'
    });
  }
  if (v.accepted && v.accepted.revision !== v.repository.revision) {
    c.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Accepted revision mismatch'
    });
  }
}
export const ExecutionPlanInputSchema = z.object(PlanShape).strict().superRefine(modeCheck);
export const ExecutionPlanSchema = z.object({
  ...PlanShape,
  fingerprint: Digest
}).strict().superRefine(modeCheck);
// Expectation snapshots contain only public stable plan data, never observations or launch material.
export const ExecutionPlanExpectationSchema = z.object({
  schemaVersion: z.literal(3),
  fingerprint: Digest,
  components: z.record(Digest),
  snapshot: ExecutionPlanInputSchema
}).strict();
export const PlanDiffSchema = z.object({
  schemaVersion: z.literal(3),
  beforeFingerprint: Digest,
  afterFingerprint: Digest,
  changed: z.boolean(),
  changes: z.array(z.object({
    field: Name,
    before: JsonValueSchema.optional(),
    after: JsonValueSchema.optional(),
    beforeSource: PlanSourceSchema.optional(),
    afterSource: PlanSourceSchema.optional(),
    reason: z.enum(['stable_input_changed', 'source_or_rule_changed', 'effective_value_changed', 'current_prerequisite_blocked', 'private_source_changed', 'source_changed_re_resolution_required'])
  }).strict())
}).strict();
export type PlanSource = z.infer<typeof PlanSourceSchema>;
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;
export type PlanObservation = z.infer<typeof PlanObservationSchema>;
export type WorkflowPack = z.infer<typeof WorkflowPackSchema>;
export type ExecutionPlanInput = z.infer<typeof ExecutionPlanInputSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
export type ExecutionPlanExpectation = z.infer<typeof ExecutionPlanExpectationSchema>;
export type PlanDiff = z.infer<typeof PlanDiffSchema>;
/** Private host input declarations. Files are read-only sources, never launch arguments. */
export const ExecutionResolutionSourcesSchema = z.object({
  schemaVersion: z.literal(3),
  plan: ExecutionPlanInputSchema,
  /** Private repository locator for live revision/index/source revalidation; never public output. */
  repositoryRoot: z.string().refine(path => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path), 'Absolute repository path required').optional(),
  files: z.array(z.object({
    component: Name,
    path: z.string().refine(p => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'Absolute source path required'),
    format: z.enum(['json', 'bytes']),
    expectedDigest: Digest.optional(),
    optional: z.boolean().default(false)
  }).strict())
}).strict().superRefine((value, context) => {
  if (new Set(value.files.map(file => file.component)).size !== value.files.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate resolution source component' });
  }
  if (value.repositoryRoot && value.files.some(file => file.component === 'repository-snapshot')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Repository snapshot component is reserved' });
  }
  const paths = new Map<string, string>();
  for (const file of value.files) {
    const existing = paths.get(file.path);
    if (existing && existing !== file.format) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Conflicting resolution source format' });
    }
    paths.set(file.path, file.format);
  }
});
export type ExecutionResolutionSources = z.infer<typeof ExecutionResolutionSourcesSchema>;

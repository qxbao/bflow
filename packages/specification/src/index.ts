export {
  ChangeAssessmentSchema,
  ClassificationSchema,
  RequiredSpecSectionsSchema,
  classifyChange,
  classifyChangeSafe,
  getRequiredSpecSections,
  hasDataSchemaPathHint,
  hasPublicApiPathHint,
  hasSecurityPathHint
} from "./classification.js";
export type {
  ChangeAssessment,
  Classification,
  RequiredSpecSections
} from "./classification.js";

export {
  PolicyDetailsSchema,
  SpecApprovedPayloadSchema,
  SpecDraftPayloadSchema,
  SpecificationDocumentSchema,
  parseSpecification,
  policyDetails,
  validateSpecificationDocument
} from "./schema.js";
export type {
  PolicyDetails,
  SpecApprovedPayload,
  SpecDraftPayload
} from "./schema.js";

export {
  buildSpecRoleMessage,
  canonicalJson,
  contentBytes,
  createSpecificationArtifactProposal,
  digest
} from "./content.js";

export { renderSpecification } from "./render.js";

export {
  addCriterionToDraft,
  assertNoCriteriaWeakeningOnFailure,
  evaluateCriteriaFromVerification,
  removeCriterionFromDraft,
  updateCriterionInDraft
} from "./criteria.js";
export type {
  CriteriaEvaluationSummary,
  CriterionEvaluation,
  CriterionUpdatePatch
} from "./criteria.js";

export {
  buildTraceabilityMatrix,
  detectSpecChanges,
  validateChangedFilesScope,
  validateTraceability
} from "./traceability.js";
export type { TraceabilityMatrix } from "./traceability.js";

export { SpecificationEngine } from "./engine.js";
export type { SpecificationEngineOptions } from "./engine.js";

export {
  ANALYST_ROLE_PROFILE,
  ANALYST_SYSTEM_PROMPT,
  ARCHITECT_ROLE_PROFILE,
  ARCHITECT_SYSTEM_PROMPT,
  renderSpecialistSpecificationPrompt
} from "./prompts.js";
export type { SpecialistSpecificationPromptOptions } from "./prompts.js";

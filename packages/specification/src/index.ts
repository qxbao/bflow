export { ChangeAssessmentSchema, ClassificationSchema, classifyChange } from "./classification.js";
export { PolicyDetailsSchema, SpecificationDocumentSchema, parseSpecification, policyDetails } from "./schema.js";
export { SpecificationEngine } from "./engine.js";
export type { SpecificationEngineOptions } from "./engine.js";
export { validateTraceability, detectSpecChanges } from "./traceability.js";
export { renderSpecification } from "./render.js";

export {
  ProjectContextService,
  ArchitecturalDecisionStore,
  SpecArtifactVersionManager,
  scrubSecrets,
  extractImports,
  atomicWriteJson,
  canonicalJson
} from "./project-context-service.js";

export type {
  ProjectContextServiceOptions,
  WorkspacePackageSummary,
  AgentProfileSummary,
  RepositoryFileCategory,
  RepositoryFileEntry,
  RepositoryStructureAnalysis,
  LoadedDocument,
  AgentRoleInstructions,
  ProjectDocumentationBundle,
  ArchitecturalDecisionRecord,
  RecordDecisionInput,
  FindDecisionsQuery,
  SelectTaskFilesQuery,
  SelectedFileContent,
  SelectedTaskFilesResult,
  SpecificationVersionRecord,
  PrepareRoleContextRequest,
  RoleTaskContextBundle,
  ContextDriftReport
} from "./project-context-service.js";

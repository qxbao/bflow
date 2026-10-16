import { parseContractOrP15Specification, policyDetails } from "./schema.js";

export function renderSpecification(input: unknown): string {
  const spec = parseContractOrP15Specification(input);
  const details = policyDetails(spec);
  const lines = [`# ${spec.title}`, "", `Spec: ${spec.specId} · Version: ${spec.version} · ${spec.complexity} · Risk: ${spec.riskLevel} · ${spec.status}`, "", spec.summary];
  const section = (title: string, content: string | readonly string[] | undefined) => {
    if (!content || !content.length) return;
    lines.push("", `## ${title}`, "", ...(typeof content === "string" ? [content] : content.map(text => `- ${text}`)));
  };
  section("Problem statement", spec.problemStatement);
  section("In scope", spec.scope.inScope);
  section("Out of scope", spec.scope.outOfScope);
  section("Acceptance criteria", spec.acceptanceCriteria.map(criterion => `[${criterion.id}] ${criterion.description} (${criterion.required ? "required" : "optional"}; ${criterion.verificationMethod}; ${criterion.status})`));
  section("Functional requirements", details.functionalRequirements);
  section("Proposed test strategy", details.proposedTestStrategy);
  section("Design proposal", details.designProposal);
  section("Architecture", spec.architectureNotes);
  section("Technical constraints", details.technicalConstraints);
  section("API / data contracts", details.apiDataContracts);
  section("Security considerations", spec.securityConsiderations);
  section("Risks and tradeoffs", details.risksAndTradeoffs);
  section("Data model changes", spec.dataModelChanges);
  section("Migration strategy", details.migrationStrategy);
  section("Rollback", spec.rollbackPlan);
  section("Affected paths", spec.affectedPaths);
  section("Traceability", details.traceability.map(mapping => `${mapping.criterionId}: ${mapping.taskIds.join(", ")}`));
  section("Unresolved questions", details.assessment.unresolvedQuestions);
  section("Revision reason", details.revisionReason);
  section("Artifact", spec.artifactRef ? `${spec.artifactRef.uri} (${spec.artifactRef.checksum.algorithm}:${spec.artifactRef.checksum.value})` : undefined);
  return `${lines.join("\n")}\n`;
}

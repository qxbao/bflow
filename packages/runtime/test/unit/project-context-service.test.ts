import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  ProjectContextService,
  ArchitecturalDecisionStore,
  SpecArtifactVersionManager,
  scrubSecrets,
  extractImports,
  atomicWriteJson
} from "../../src/context/index.js";
import { StructuredLogger } from "../../src/resilience/index.js";
import { ObservabilityTracker } from "../../src/observability/index.js";
import type {
  Specification,
  ArtifactReference,
  AgentRoleProfile
} from "@bflow/contracts";

describe("ProjectContextService and Context Management", () => {
  let tmpRepoRoot: string;
  let service: ProjectContextService;

  beforeEach(async () => {
    tmpRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bflow-ctx-test-"));
    service = new ProjectContextService(tmpRepoRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpRepoRoot, { recursive: true, force: true });
  });

  // Helper to create directory and file
  async function writeFile(relPath: string, content: string): Promise<string> {
    const fullPath = path.join(tmpRepoRoot, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
    return fullPath;
  }

  describe("1. Repository Structure Analysis", () => {
    it("discovers workspace packages, entrypoints, and dependencies", async () => {
      // Root package.json
      await writeFile(
        "package.json",
        JSON.stringify({
          name: "@test/root",
          dependencies: { zod: "^3.22.0" },
          devDependencies: { vitest: "^2.0.0" }
        })
      );
      // Workspace package in packages/core
      await writeFile(
        "packages/core/package.json",
        JSON.stringify({
          name: "@test/core",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
          dependencies: { "@test/contracts": "workspace:*" },
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              import: "./dist/index.js"
            }
          }
        })
      );
      await writeFile("packages/core/src/index.ts", "export const version = '1.0.0';");

      const analysis = await service.analyzeRepositoryStructure();
      expect(analysis.repositoryRoot).toBe(path.resolve(tmpRepoRoot));
      expect(analysis.packages.length).toBe(2);

      const corePkg = analysis.packages.find((p) => p.name === "@test/core");
      expect(corePkg).toBeDefined();
      expect(corePkg?.dependencies).toContain("@test/contracts");
      expect(corePkg?.entrypoints).toContain("./dist/index.js");
      expect(corePkg?.entrypoints).toContain("./dist/index.d.ts");
    });

    it("respects .gitignore patterns including wildcards, comments, and negation", async () => {
      await writeFile(
        ".gitignore",
        `# Ignore temp files
*.log
temp/
!temp/keep.txt
build/
`
      );
      await writeFile("app.log", "some logs");
      await writeFile("temp/discard.txt", "discard me");
      await writeFile("temp/keep.txt", "keep me");
      await writeFile("src/main.ts", "console.log('hello');");

      const analysis = await service.analyzeRepositoryStructure();
      const relativePaths = analysis.files.map((f) => f.relativePath);

      expect(relativePaths).toContain("src/main.ts");
      expect(relativePaths).toContain("temp/keep.txt");
      expect(relativePaths).not.toContain("app.log");
      expect(relativePaths).not.toContain("temp/discard.txt");
    });

    it("excludes hardcoded directories like node_modules, dist, .git, .bflow", async () => {
      await writeFile("node_modules/fake-lib/index.js", "module.exports = {};");
      await writeFile("dist/bundle.js", "bundle");
      await writeFile(".git/config", "repo config");
      await writeFile(".bflow/state/run.json", "{}");
      await writeFile(".agents/worktrees/test.txt", "worktree");
      await writeFile("src/index.ts", "export const ok = true;");

      const analysis = await service.analyzeRepositoryStructure();
      const relativePaths = analysis.files.map((f) => f.relativePath);

      expect(relativePaths).toEqual(["src/index.ts"]);
    });

    it("rejects symlinks escaping the repository root", async () => {
      // Create external directory and file
      const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "bflow-external-"));
      await fs.writeFile(path.join(externalDir, "secret.txt"), "secret data", "utf8");

      try {
        // Create escaping symlink inside repo pointing outside
        const symlinkPath = path.join(tmpRepoRoot, "symlink-to-outside");
        await fs.symlink(externalDir, symlinkPath, "dir");

        await writeFile("src/normal.ts", "const x = 1;");

        const analysis = await service.analyzeRepositoryStructure();
        const paths = analysis.files.map((f) => f.relativePath);

        expect(paths).toContain("src/normal.ts");
        expect(paths.some((p) => p.includes("symlink-to-outside"))).toBe(false);
      } finally {
        await fs.rm(externalDir, { recursive: true, force: true });
      }
    });

    it("handles symlink cycle without infinite recursion", async () => {
      const loopDir = path.join(tmpRepoRoot, "loop");
      await fs.mkdir(loopDir, { recursive: true });
      await writeFile("loop/file.ts", "const x = 1;");
      // Create a recursive directory symlink pointing to an ancestor/parent
      await fs.symlink(loopDir, path.join(loopDir, "recursive-link"), "dir");

      const analysis = await service.analyzeRepositoryStructure();
      expect(analysis.files.some((f) => f.relativePath === "loop/file.ts")).toBe(true);
    });

    it("extracts static imports deterministically from TS and JS files", async () => {
      await writeFile(
        "src/app.ts",
        `import { foo } from "./utils.js";
import * as path from "node:path";
import "./polyfill.js";
export { bar } from "./bar.js";
const dynamic = await import("./dynamic.js");
const required = require("./legacy.js");
`
      );

      const analysis = await service.analyzeRepositoryStructure();
      const appFile = analysis.files.find((f) => f.relativePath === "src/app.ts");

      expect(appFile).toBeDefined();
      expect(appFile?.imports).toEqual([
        "./bar.js",
        "./dynamic.js",
        "./legacy.js",
        "./polyfill.js",
        "./utils.js",
        "node:path"
      ]);
    });

    it("generates a deterministic structure fingerprint", async () => {
      await writeFile("src/a.ts", "const a = 1;");
      await writeFile("src/b.ts", "const b = 2;");

      const analysis1 = await service.analyzeRepositoryStructure({ forceReanalysis: true });
      const analysis2 = await service.analyzeRepositoryStructure({ forceReanalysis: true });

      expect(analysis1.structureFingerprint).toBe(analysis2.structureFingerprint);
      expect(analysis1.structureFingerprint.length).toBe(64);
    });
  });

  describe("2. Project Documentation & Agent Instructions Reader", () => {
    it("loads docs and agent instructions with role mapping and profile validation", async () => {
      await writeFile("README.md", "# Project Root");
      await writeFile("AGENTS.md", "# Multi-agent Rules");
      await writeFile("packages/core/README.md", "# Core Package");

      // Chat agent -> conversation role
      const chatProfile: AgentRoleProfile = {
        role: "conversation",
        title: "Bflow Chat Agent",
        description: "Sole user-facing conversational gateway",
        defaultCapabilities: ["conversation.dialogue"],
        allowedRecipients: ["user", "coordinator"],
        canDelegateToSpecialist: false,
        userFacing: true,
        readOnlyWorkspace: true,
        requiresDedicatedPane: true,
        requiresIndependentVerification: false
      };
      await writeFile("agents/chat/role-profile.json", JSON.stringify(chatProfile));
      await writeFile("agents/chat/system-prompt.md", "You are the conversational interface.");

      // Analyst agent -> specifier role
      const analystProfile: AgentRoleProfile = {
        role: "specifier",
        title: "Bflow Analyst",
        description: "Specialist agent responsible for requirement analysis",
        defaultCapabilities: ["specification.drafting"],
        allowedRecipients: ["coordinator"],
        canDelegateToSpecialist: false,
        userFacing: false,
        readOnlyWorkspace: true,
        requiresDedicatedPane: true,
        requiresIndependentVerification: true
      };
      await writeFile("agents/analyst/role-profile.json", JSON.stringify(analystProfile));
      await writeFile("agents/analyst/prompt.md", "Analyze requirements and formulate criteria.");

      // Verifier agent -> QA / reviewer / tester roles
      await writeFile("agents/verifier/prompt.md", "Verify test suites and criteria satisfaction.");

      const bundle = await service.loadProjectDocumentation();
      expect(bundle.documents.length).toBeGreaterThanOrEqual(4);

      // Verify conversation role lookup
      const convInstructions = await service.getAgentRoleInstructions("conversation");
      expect(convInstructions).toBeDefined();
      expect(convInstructions?.roleProfile?.role).toBe("conversation");
      expect(convInstructions?.combinedInstructions).toContain("conversational interface");

      // Verify specifier role lookup
      const specInstructions = await service.getAgentRoleInstructions("specifier");
      expect(specInstructions).toBeDefined();
      expect(specInstructions?.roleProfile?.role).toBe("specifier");
      expect(specInstructions?.combinedInstructions).toContain("Analyze requirements");

      // Verify tester role maps to agents/verifier
      const testerInstructions = await service.getAgentRoleInstructions("tester");
      expect(testerInstructions).toBeDefined();
      expect(testerInstructions?.directory).toBe("agents/verifier");
      expect(testerInstructions?.combinedInstructions).toContain("Verify test suites");
    });
  });

  describe("3. Architectural Decisions Store", () => {
    it("parses ADR markdown files and extracts metadata and affected paths", async () => {
      const adrContent = `# ADR 0001: Harden P00 contracts before implementation

- Status: Accepted on \`fix/p00-contract-hardening\`
- Baseline: \`8d960d02\`

## Context

The independent P00 audit found contract gaps in transport observation and checkpointing.

## Decision

1. Public asynchronous ports use OperationResult.
2. Submission receipt and observation are separated.

## Consequences

Primary files affected: \`packages/contracts/src/agent.ts\`, \`packages/contracts/src/ports.ts\`.
`;
      await writeFile("docs/adr/0001-p00-contract-hardening.md", adrContent);

      const store = new ArchitecturalDecisionStore(tmpRepoRoot);
      const decisions = await store.listDecisions();

      expect(decisions.length).toBe(1);
      const adr = decisions[0];
      expect(adr).toBeDefined();
      expect(adr?.decisionId).toBe("ADR-0001");
      expect(adr?.title).toBe("Harden P00 contracts before implementation");
      expect(adr?.status).toBe("accepted");
      expect(adr?.summary).toContain("independent P00 audit found contract gaps");
      expect(adr?.rationale).toContain("OperationResult");
      expect(adr?.affectedPaths).toContain("packages/contracts/src/agent.ts");
      expect(adr?.sha256).toBe(crypto.createHash("sha256").update(adrContent).digest("hex"));
    });

    it("records runtime decisions with atomic file persistence and allows querying by task", async () => {
      const store = new ArchitecturalDecisionStore(tmpRepoRoot);

      // Record a new architectural decision
      const recorded = await store.recordDecision({
        decisionId: "ADR-0010",
        title: "Deterministic Context Selection Engine",
        status: "accepted",
        summary: "Context selection must use a 6-tier deterministic ranking without external vector DBs.",
        rationale: "Vector databases introduce non-deterministic embedding drift and extra runtime bloat.",
        consequences: "All file rankings are fully reproducible across platforms.",
        affectedPaths: ["packages/runtime/src/context/project-context-service.ts"]
      });

      expect(recorded.decisionId).toBe("ADR-0010");
      expect(recorded.sha256.length).toBe(64);

      // Verify persisted file exists
      const persistedFile = path.join(tmpRepoRoot, ".bflow", "state", "context", "decisions.json");
      const exists = await fs.stat(persistedFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // Reload in fresh store instance
      const freshStore = new ArchitecturalDecisionStore(tmpRepoRoot);
      const list = await freshStore.listDecisions();
      expect(list.some((d) => d.decisionId === "ADR-0010")).toBe(true);

      // Query decisions for task
      const matched = await freshStore.findDecisionsForTask({
        ownedPaths: ["packages/runtime/src/context/project-context-service.ts"]
      });
      expect(matched.length).toBe(1);
      expect(matched[0]?.decisionId).toBe("ADR-0010");

      // Query by keyword
      const keywordMatches = await freshStore.findDecisionsForTask({
        keywords: ["deterministic", "selection"]
      });
      expect(keywordMatches.length).toBe(1);
    });
  });

  describe("4. Deterministic Task-Relevant File Selection (NO Vector DB)", () => {
    beforeEach(async () => {
      // Build a multi-file project structure
      await writeFile("packages/runtime/package.json", JSON.stringify({ name: "@test/runtime" }));
      await writeFile("packages/runtime/README.md", "# Runtime Package Documentation");
      await writeFile(
        "packages/runtime/src/service.ts",
        `import { helper } from "./helper.js";
export class RuntimeService {
  run() { return helper(); }
}`
      );
      await writeFile(
        "packages/runtime/src/helper.ts",
        `export function helper() { return "helped"; }`
      );
      await writeFile(
        "packages/runtime/test/unit/service.test.ts",
        `import { RuntimeService } from "../../src/service.js";`
      );
      await writeFile(
        "packages/runtime/src/unrelated.ts",
        `export const unrelatedCode = "totally different";`
      );
      await writeFile(
        "packages/persistence/src/store.ts",
        `export class UnrelatedStore {}`
      );
    });

    it("ranks files by 6 deterministic tiers and excludes unrelated files (score === 0)", async () => {
      const result = await service.selectFilesForTask({
        taskId: "task-01",
        title: "Implement service helper integration",
        description: "Connect runtime service with helper utilities",
        ownedPaths: ["packages/runtime/src/service.ts"],
        affectedPaths: ["packages/runtime/src/helper.ts"],
        acceptanceCriteria: ["Ensure helper executes properly"]
      });

      const paths = result.includedFiles.map((f) => f.relativePath);

      // Tier 1 (Owned: score 100)
      expect(paths).toContain("packages/runtime/src/service.ts");
      const serviceFile = result.includedFiles.find((f) => f.relativePath === "packages/runtime/src/service.ts");
      expect(serviceFile?.score).toBe(100);

      // Tier 2 (Affected: score 80)
      expect(paths).toContain("packages/runtime/src/helper.ts");
      const helperFile = result.includedFiles.find((f) => f.relativePath === "packages/runtime/src/helper.ts");
      expect(helperFile?.score).toBe(80);

      // Tier 4 (Corresponding test: score 50)
      expect(paths).toContain("packages/runtime/test/unit/service.test.ts");

      // Tier 5 (Package manifest: score 40)
      expect(paths).toContain("packages/runtime/package.json");
      expect(paths).toContain("packages/runtime/README.md");

      // Unrelated files MUST NOT be included (score 0)
      expect(paths).not.toContain("packages/runtime/src/unrelated.ts");
      expect(paths).not.toContain("packages/persistence/src/store.ts");
    });

    it("enforces strict budget limits (maxFiles and maxBytesPerFile truncation)", async () => {
      // Create a large file
      const largeContent = "console.log('long text line');\n".repeat(500); // ~15KB
      await writeFile("packages/runtime/src/service.ts", largeContent);

      const result = await service.selectFilesForTask({
        taskId: "task-budget",
        title: "Budget test",
        description: "Checking budget constraints",
        ownedPaths: ["packages/runtime/src/service.ts"],
        affectedPaths: [],
        maxBytesPerFile: 500, // Very small max bytes per file
        maxFiles: 1
      });

      expect(result.includedFiles.length).toBe(1);
      const file = result.includedFiles[0];
      expect(file).toBeDefined();
      expect(file?.truncated).toBe(true);
      expect(file?.content).toContain("[TRUNCATED: original");
      expect(file?.sizeBytes).toBe(Buffer.byteLength(largeContent, "utf8"));
    });

    it("records matched files omitted due to maxFiles in excludedMatchingFiles", async () => {
      const result = await service.selectFilesForTask({
        taskId: "task-limit",
        title: "File limit test",
        description: "Checking maxFiles limit",
        ownedPaths: ["packages/runtime/src/service.ts", "packages/runtime/src/helper.ts"],
        affectedPaths: [],
        maxFiles: 1 // Only 1 allowed
      });

      expect(result.includedFiles.length).toBe(1);
      expect(result.includedFiles[0]?.relativePath).toBe("packages/runtime/src/helper.ts");
      expect(result.excludedMatchingFiles.length).toBeGreaterThan(0);
      expect(result.excludedMatchingFiles).toContain("packages/runtime/src/service.ts");
    });

    it("ensures truncated files strictly satisfy Buffer.byteLength <= maxBytesPerFile including truncation suffix", async () => {
      const largeContent = "Xin chào thế giới! 🚀 Bflow SDLC resilient context management.\n".repeat(50);
      await writeFile("packages/runtime/src/multibyte.ts", largeContent);

      const maxBytesPerFile = 300;
      const result = await service.selectFilesForTask({
        taskId: "task-byte-budget",
        title: "Byte budget test",
        description: "Checking strict Buffer.byteLength capping",
        ownedPaths: ["packages/runtime/src/multibyte.ts"],
        affectedPaths: [],
        maxBytesPerFile,
        maxFiles: 1
      });

      expect(result.includedFiles.length).toBe(1);
      const file = result.includedFiles[0]!;
      expect(file.truncated).toBe(true);
      expect(Buffer.byteLength(file.content, "utf8")).toBeLessThanOrEqual(maxBytesPerFile);
      expect(file.content).toContain("[TRUNCATED: original");
    });
  });

  describe("5. Specification & Artifact Version Management", () => {
    const validSpec: Specification = {
      schemaVersion: 2,
      specId: "spec-ctx-001",
      sessionId: "session-123",
      level: "lightweight",
      title: "Context Management Engine",
      summary: "Provides deterministic project context to SDLC agents",
      problemStatement: "Agents need structured, role-specific context without overflowing prompt budgets.",
      scope: {
        inScope: ["Context selection", "Secret scrubbing", "Drift detection"],
        outOfScope: ["External vector database hosting"]
      },
      acceptanceCriteria: [
        {
          id: "crit-1",
          description: "Deterministically select task files",
          category: "functional",
          verificationMethod: "unit_test",
          required: true,
          status: "pending",
          evidenceArtifactIds: []
        }
      ],
      affectedPaths: ["packages/runtime/src/context/project-context-service.ts"],
      status: "approved",
      approvedBy: "coordinator",
      artifactRef: {
        trust: "stored",
        artifactId: "art-spec-01",
        runId: "run-001",
        kind: "document",
        uri: "artifact://run-001/art-spec-01",
        mediaType: "text/markdown",
        checksum: {
          algorithm: "sha256",
          value: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        },
        sizeBytes: 100,
        createdAt: new Date().toISOString()
      },
      version: 1,
      createdBy: "coordinator",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    it("registers and retrieves specifications with schema validation", async () => {
      const mgr = new SpecArtifactVersionManager(tmpRepoRoot);
      const record = await mgr.registerSpecification(validSpec);

      expect(record.specId).toBe("spec-ctx-001");
      expect(record.version).toBe(1);
      expect(record.specFingerprint.length).toBe(64);

      const latest = await mgr.getLatestSpecification("spec-ctx-001");
      expect(latest).toBeDefined();
      expect(latest?.title).toBe("Context Management Engine");
    });

    it("allows idempotent re-registration of identical specifications", async () => {
      const mgr = new SpecArtifactVersionManager(tmpRepoRoot);
      const r1 = await mgr.registerSpecification(validSpec);
      const r2 = await mgr.registerSpecification(validSpec);

      expect(r1.specFingerprint).toBe(r2.specFingerprint);
    });

    it("rejects conflicting specification content for the same version", async () => {
      const mgr = new SpecArtifactVersionManager(tmpRepoRoot);
      await mgr.registerSpecification(validSpec);

      const conflicting: Specification = {
        ...validSpec,
        summary: "Altered conflicting summary"
      };

      await expect(mgr.registerSpecification(conflicting)).rejects.toThrow(
        /Conflicting specification content/
      );
    });

    it("tracks specification version upgrades and rejects version regression", async () => {
      const mgr = new SpecArtifactVersionManager(tmpRepoRoot);
      await mgr.registerSpecification(validSpec);

      const v2Spec: Specification = {
        ...validSpec,
        version: 2,
        summary: "Upgraded v2 summary"
      };
      const r2 = await mgr.registerSpecification(v2Spec);
      expect(r2.version).toBe(2);
      expect(r2.previousVersion).toBe(1);

      // Attempt version regression: registering v1 after v2
      const regressingSpec: Specification = {
        ...validSpec,
        version: 1,
        title: "Regressing spec"
      };
      await expect(mgr.registerSpecification(regressingSpec)).rejects.toThrow(
        /Version regression/
      );
    });

    it("tracks task ArtifactReferences with ArtifactReferenceSchema validation", async () => {
      const mgr = new SpecArtifactVersionManager(tmpRepoRoot);
      const artifact: ArtifactReference = {
        trust: "stored",
        artifactId: "art-test-01",
        runId: "run-001",
        kind: "test-result",
        uri: "artifact://run-001/art-test-01",
        mediaType: "application/json",
        checksum: {
          algorithm: "sha256",
          value: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        },
        sizeBytes: 120,
        createdAt: new Date().toISOString()
      };

      await mgr.registerArtifact("task-100", artifact);
      const list = await mgr.getArtifactsForTask("task-100");

      expect(list.length).toBe(1);
      expect(list[0]?.artifactId).toBe("art-test-01");
    });
  });

  describe("6. Role-Specific Task Context Preparation & Secret Scrubbing", () => {
    it("scrubs Bearer tokens, OpenAI keys, GitHub tokens, and private keys", () => {
      const raw = `
Authorization: Bearer secret-bearer-token-12345
OPENAI_KEY = "sk-1234567890abcdef12345678"
GITHUB_PAT=ghp_123456789012345678901234567890123456
PASSWORD="super-secret-password"
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0...
-----END RSA PRIVATE KEY-----
`;
      const scrubbed = scrubSecrets(raw);

      expect(scrubbed).not.toContain("secret-bearer-token-12345");
      expect(scrubbed).toContain("Bearer [REDACTED]");
      expect(scrubbed).not.toContain("sk-1234567890abcdef12345678");
      expect(scrubbed).toContain('OPENAI_KEY = "[REDACTED]"');
      expect(scrubbed).not.toContain("ghp_123456789012345678901234567890123456");
      expect(scrubbed).toContain("GITHUB_PAT=[REDACTED]");
      expect(scrubbed).not.toContain("MIIEowIBAAKCAQEA0");
      expect(scrubbed).not.toContain("super-secret-password");
      expect(scrubbed).toContain('PASSWORD="[REDACTED]"');
    });

    it("prepares role-tailored context for conversation without raw source dumps", async () => {
      await writeFile("src/code.ts", "export const dangerousCode = true;");

      const bundle = await service.prepareRoleTaskContext({
        role: "conversation",
        title: "User chat request",
        description: "User asking about project progress",
        ownedPaths: ["src/code.ts"],
        affectedPaths: []
      });

      expect(bundle.role).toBe("conversation");
      expect(bundle.includedFiles).toEqual([]);
      expect(bundle.formattedPromptContext).toContain("User chat request");
      expect(bundle.formattedPromptContext).not.toContain("dangerousCode");
    });

    it("prepares full code and criteria context for developer role", async () => {
      await writeFile(
        "src/feature.ts",
        "export function add(a: number, b: number) { return a + b; }"
      );

      const bundle = await service.prepareRoleTaskContext({
        role: "developer",
        taskId: "task-dev-01",
        title: "Implement add feature",
        description: "Implement addition logic",
        ownedPaths: ["src/feature.ts"],
        affectedPaths: [],
        acceptanceCriteria: ["Must add two numbers correctly"]
      });

      expect(bundle.role).toBe("developer");
      expect(bundle.includedFiles).toContain("src/feature.ts");
      expect(bundle.formattedPromptContext).toContain("add(a: number, b: number)");
      expect(bundle.formattedPromptContext).toContain("Must add two numbers correctly");
      expect(bundle.contextHash.length).toBe(64);
    });
  });

  describe("7. Context Drift Detection ('Context bị thay đổi')", () => {
    it("reports no drift when repository files and spec remain unchanged", async () => {
      await writeFile("src/stable.ts", "const stable = true;");

      const bundle = await service.prepareRoleTaskContext({
        role: "developer",
        title: "Stable task",
        description: "Check no drift",
        ownedPaths: ["src/stable.ts"],
        affectedPaths: []
      });

      const report = await service.detectContextDrift(bundle);
      expect(report.drifted).toBe(false);
      expect(report.modifiedFiles).toEqual([]);
      expect(report.deletedFiles).toEqual([]);
      expect(report.addedOwnedFiles).toEqual([]);
    });

    it("detects when a source file is modified after context preparation", async () => {
      const filePath = await writeFile("src/mod.ts", "const initial = 1;");

      const bundle = await service.prepareRoleTaskContext({
        role: "developer",
        title: "Modification task",
        description: "Check modified drift",
        ownedPaths: ["src/mod.ts"],
        affectedPaths: []
      });

      // Modify the file on disk
      await fs.writeFile(filePath, "const modified = 2;", "utf8");

      const report = await service.detectContextDrift(bundle);
      expect(report.drifted).toBe(true);
      expect(report.modifiedFiles).toContain("src/mod.ts");
      expect(report.reasons.some((r) => r.includes("modified"))).toBe(true);
    });

    it("detects when a file is deleted after context preparation", async () => {
      const filePath = await writeFile("src/del.ts", "const toDelete = true;");

      const bundle = await service.prepareRoleTaskContext({
        role: "developer",
        title: "Deletion task",
        description: "Check deleted drift",
        ownedPaths: ["src/del.ts"],
        affectedPaths: []
      });

      // Delete the file from disk
      await fs.unlink(filePath);

      const report = await service.detectContextDrift(bundle);
      expect(report.drifted).toBe(true);
      expect(report.deletedFiles).toContain("src/del.ts");
      expect(report.reasons.some((r) => r.includes("deleted"))).toBe(true);
    });

    it("detects when a new file is added under an owned directory", async () => {
      await writeFile("src/existing.ts", "const existing = true;");

      const bundle = await service.prepareRoleTaskContext({
        role: "developer",
        title: "Addition task",
        description: "Check added drift",
        ownedPaths: ["src/existing.ts"],
        affectedPaths: []
      });

      // Add a new file under the same directory
      await writeFile("src/new-addition.ts", "const brandNew = true;");

      const report = await service.detectContextDrift(bundle);
      expect(report.drifted).toBe(true);
      expect(report.addedOwnedFiles).toContain("src/new-addition.ts");
    });

    it("detects when specification version is upgraded after context preparation", async () => {
      const spec: Specification = {
        schemaVersion: 2,
        specId: "spec-drift-01",
        sessionId: "session-1",
        level: "lightweight",
        title: "Drift Spec",
        summary: "Testing spec drift",
        problemStatement: "Problem statement",
        scope: { inScope: ["test"], outOfScope: [] },
        acceptanceCriteria: [
          {
            id: "c1",
            description: "Crit 1",
            category: "functional",
            verificationMethod: "unit_test",
            required: true,
            status: "pending",
            evidenceArtifactIds: []
          }
        ],
        affectedPaths: ["src/app.ts"],
        status: "draft",
        version: 1,
        createdBy: "coordinator",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await service.versionManager.registerSpecification(spec);
      await writeFile("src/app.ts", "export const app = 1;");

      const bundle = await service.prepareRoleTaskContext({
        role: "developer",
        title: "Spec drift task",
        description: "Check spec version drift",
        ownedPaths: ["src/app.ts"],
        affectedPaths: [],
        specId: "spec-drift-01"
      });

      expect(bundle.specVersion).toBe(1);

      // Now register v2 of the specification
      const v2Spec: Specification = {
        ...spec,
        version: 2,
        summary: "Updated v2 specification summary"
      };
      await service.versionManager.registerSpecification(v2Spec);

      const report = await service.detectContextDrift(bundle);
      expect(report.drifted).toBe(true);
      expect(report.specVersionDrifted).toBe(true);
      expect(report.reasons.some((r) => r.includes("Specification version changed"))).toBe(true);
    });

    it("detects when an architectural decision status changes", async () => {
      await writeFile("src/adr-target.ts", "export const target = true;");

      await service.adrStore.recordDecision({
        decisionId: "ADR-0099",
        title: "Temporary Experimental Engine",
        status: "proposed",
        summary: "Evaluating temporary experimental engine",
        affectedPaths: ["src/adr-target.ts"]
      });

      const bundle = await service.prepareRoleTaskContext({
        role: "developer",
        title: "ADR drift test",
        description: "Check ADR status drift",
        ownedPaths: ["src/adr-target.ts"],
        affectedPaths: []
      });

      expect(bundle.adrSummaries[0]?.status).toBe("proposed");

      // Now update the decision status to superseded
      await service.adrStore.recordDecision({
        decisionId: "ADR-0099",
        title: "Temporary Experimental Engine",
        status: "superseded",
        summary: "Evaluating temporary experimental engine",
        affectedPaths: ["src/adr-target.ts"]
      });

      const report = await service.detectContextDrift(bundle);
      expect(report.drifted).toBe(true);
      expect(report.reasons.some((r) => r.includes("status changed"))).toBe(true);
    });

    it("detects when an ADR markdown content or fingerprint changes", async () => {
      const adrPath = await writeFile(
        "docs/adr/0001-test.md",
        "# ADR 0001: Test Decision\n\n- Status: Accepted\n\n## Context\nContext initial.\nAffected: `src/dummy.ts`\n"
      );

      const bundle = await service.prepareRoleTaskContext({
        role: "developer",
        title: "ADR content drift test",
        description: "Check ADR content modification drift",
        ownedPaths: ["src/dummy.ts"],
        affectedPaths: []
      });

      expect(bundle.adrFingerprints["ADR-0001"]).toBeDefined();

      // Modify the ADR markdown file on disk
      await fs.writeFile(
        adrPath,
        "# ADR 0001: Test Decision\n\n- Status: Accepted\n\n## Context\nContext MODIFIED.\nAffected: `src/dummy.ts`\n",
        "utf8"
      );

      const report = await service.detectContextDrift(bundle);
      expect(report.drifted).toBe(true);
      expect(report.reasons.some((r) => r.includes("was modified (hash mismatch)"))).toBe(true);
    });

    it("detects drift when registered specification is deleted or missing", async () => {
      const spec: Specification = {
        schemaVersion: 2,
        specId: "spec-del-01",
        sessionId: "session-1",
        level: "lightweight",
        title: "Delete Spec",
        summary: "Testing deleted spec drift",
        problemStatement: "Problem statement",
        scope: { inScope: ["test"], outOfScope: [] },
        acceptanceCriteria: [
          {
            id: "crit-del-01",
            description: "Criterion for spec deletion test",
            category: "functional",
            verificationMethod: "unit_test",
            required: true,
            status: "pending",
            evidenceArtifactIds: []
          }
        ],
        affectedPaths: ["src/app.ts"],
        status: "draft",
        version: 1,
        createdBy: "coordinator",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await service.versionManager.registerSpecification(spec);
      await writeFile("src/app.ts", "export const app = 1;");

      const bundle = await service.prepareRoleTaskContext({
        role: "developer",
        title: "Spec deletion task",
        description: "Check spec deletion drift",
        ownedPaths: ["src/app.ts"],
        affectedPaths: [],
        specId: "spec-del-01"
      });

      expect(bundle.specVersion).toBe(1);

      // Delete the specification versions file from disk
      const specPath = path.join(tmpRepoRoot, ".bflow", "state", "context", "spec-versions.json");
      await fs.unlink(specPath);

      const report = await service.detectContextDrift(bundle);
      expect(report.drifted).toBe(true);
      expect(report.specVersionDrifted).toBe(true);
      expect(report.reasons.some((r) => r.includes("was not found or was deleted"))).toBe(true);
    });

    it("detects drift when an included file is replaced by a symlink escaping repo root", async () => {
      const filePath = await writeFile("src/escape.ts", "export const normal = 1;");

      const bundle = await service.prepareRoleTaskContext({
        role: "developer",
        title: "Escape symlink drift",
        description: "Check escaping symlink drift",
        ownedPaths: ["src/escape.ts"],
        affectedPaths: []
      });

      const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "bflow-drift-escape-"));
      const outsideFile = path.join(externalDir, "outside.ts");
      await fs.writeFile(outsideFile, "export const outside = 2;", "utf8");

      try {
        await fs.unlink(filePath);
        await fs.symlink(outsideFile, filePath);

        const report = await service.detectContextDrift(bundle);
        expect(report.drifted).toBe(true);
        expect(report.reasons.some((r) => r.includes("escapes repository root"))).toBe(true);
      } finally {
        await fs.rm(externalDir, { recursive: true, force: true });
      }
    });
  });

  describe("8. Observability and Structured Logging Integration", () => {
    it("records ContextBundleMetric and logs context.prepared and context.drift_detected", async () => {
      const logger = new StructuredLogger();
      const observability = new ObservabilityTracker();
      const instrumentedService = new ProjectContextService({
        repositoryRoot: tmpRepoRoot,
        logger,
        observability
      });

      await writeFile("src/monitored.ts", "const x = 100;");

      const bundle = await instrumentedService.prepareRoleTaskContext({
        role: "developer",
        runId: "run-mon-01",
        taskId: "task-mon-01",
        title: "Monitored task",
        description: "Task with observability",
        ownedPaths: ["src/monitored.ts"],
        affectedPaths: []
      });

      // Check ObservabilityTracker
      const runMetrics = observability.getRunReport("run-mon-01");
      expect(runMetrics).not.toBeNull();
      expect(runMetrics?.contextMetrics.bundles.length).toBe(1);
      const recordedMetric = runMetrics!.contextMetrics.bundles[0]!;
      expect(recordedMetric.runId).toBe("run-mon-01");
      expect(recordedMetric.taskId).toBe("task-mon-01");
      expect(recordedMetric.role).toBe("developer");
      expect(recordedMetric.contextHash).toBe(bundle.contextHash);

      // Check StructuredLogger
      const logEntries = logger.getEntries();
      const prepLog = logEntries.find((e) => e.event === "context.prepared");
      expect(prepLog).toBeDefined();
      expect(prepLog?.runId).toBe("run-mon-01");
      expect(prepLog?.taskId).toBe("task-mon-01");

      // Trigger drift
      await writeFile("src/monitored.ts", "const x = 200;");
      const drift = await instrumentedService.detectContextDrift(bundle);
      expect(drift.drifted).toBe(true);

      const driftLog = logger.getEntries().find((e) => e.event === "context.drift_detected");
      expect(driftLog).toBeDefined();
      expect(driftLog?.level).toBe("warn");
    });
  });
});

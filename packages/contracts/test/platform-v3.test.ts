import { describe, expect, it } from "vitest";
import {
  AGENT_HEALTH_CHECKS, AgentCapabilitySchema, AgentEnvironmentSchema, AgentHealthRequestSchema,
  AgentHealthResultSchema, AgentLaunchProfileSchema, BflowCommandSchema, CommandExecutionResultSchema,
  isTrustScopeWithin, MachineSetupPlanSchema, MCPEndpointSchema, MCPClientRegistrationSchema,
  MCPResourceLeaseSchema, MCPServiceDefinitionSchema, MCPServiceObservationSchema, MCPToolCallSchema,
  OperationResultSchema, PermissionProfileSchema, SetupApplyRequestSchema, SetupReceiptSchema,
  SetupStepSchema, SkillManifestSchema, ToolCapabilitySchema
} from "../src/index.js";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const now = "2026-10-16T00:00:00Z";
const later = "2026-10-16T00:01:00Z";
const machine = { kind: "machine", machineId: "machine-1" } as const;
const repo = { kind: "repository", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo" } as const;
const scope = { ...repo, kind: "session", sessionId: "session-1" } as const;
const permission = {
  schemaVersion: 3, profileId: "developer-workspace", mode: "workspace_auto", scope,
  filesystem: "workspace_write", readableRoots: ["/repo"], writableRoots: ["/repo/task"],
  deniedRoots: ["/repo/.bflow"], isolation: "provider_policy", network: { mode: "deny", allowedHosts: [] },
  allowedTools: ["edit"], deniedAction: "request_via_conversation", allowGlobalPermissionBypass: false
};
const environment = {
  schemaVersion: 3, environmentId: "env-1", provider: "codex", role: "developer", scope,
  cwd: "/repo/task", stateDirectory: "/private/session-1", configFingerprint: digest,
  permissionProfile: permission, environmentVariables: { LANG: "C.UTF-8" }, secretBindings: {},
  requiredCapabilityIds: ["implementation"], requiredMcpServiceIds: ["docs"], skillManifestDigest: digest
};
const launch = {
  schemaVersion: 3, launchId: "launch-1", environment, providerVersion: "0.162.0", executable: "/managed/codex",
  executableDigest: digest, argv: ["--sandbox", "workspace-write", "--ask-for-approval", "never"],
  configFiles: [{ path: "/private/role.toml", digest }], launchFingerprint: digest,
  interaction: "no_direct_user_input", expiresAt: later
};
const attestation = {
  schemaVersion: 3, receiptId: "receipt-1", issuerId: "trusted-host", launchId: "launch-1",
  launchFingerprint: digest, sessionId: "session-1", paneId: "pane-1",
  nativeSession: { source: "codex", kind: "id", value: "native-1" }, observedAt: now,
  signature: { algorithm: "ed25519", value: "A".repeat(86) + "==" }
};
const health = {
  schemaVersion: 3, environmentId: "env-1", provider: "codex", role: "developer", configFingerprint: digest,
  stage: "preflight", status: "ready", checkedAt: now, validUntil: later,
  checks: AGENT_HEALTH_CHECKS.filter(check => check !== "native_binding")
    .map(check => ({ check, status: "passed", code: "verified", message: "Observed by trusted probe" }))
};
const tool = {
  schemaVersion: 3, toolId: "docs", kind: "native_remote_mcp", version: "1.0.0", operations: ["search"],
  resource: { sharing: "concurrent", maxConcurrency: 4 }, required: true
};
const service = {
  schemaVersion: 3, serviceId: "docs", revision: 1, scope: machine, tool,
  connection: { kind: "native_remote_mcp", endpoint: "https://docs.example.test/mcp", ownership: "external" },
  authentication: { mode: "bearer", credential: "secret://mcp/docs" },
  healthTimeoutMs: 1000, idleTimeoutMs: 60_000, restartLimit: 3
};
const step = {
  schemaVersion: 3, stepId: "configure", action: "configure", componentId: "codex", level: "machine", scope: machine,
  dependsOn: [], desiredStateDigest: digest, expectedStateDigest: null, requiresApproval: true,
  rollback: "restore_owned_config", idempotencyKey: "setup-configure"
};
const plan = {
  schemaVersion: 3, planId: "plan-1", machineId: "machine-1", revision: 1, planDigest: digest,
  createdAt: now, steps: [step], idempotencyKey: "plan-1"
};
const skill = {
  schemaVersion: 3, skillId: "tdd", version: "1.0.0", digest, source: "builtin", entrypoint: "tdd/SKILL.md",
  description: "Apply existing conditional TDD policy", allowedRoles: ["developer"], supportedProviders: ["codex"],
  requiredCapabilityIds: ["implementation"], requiredToolIds: [], dependencies: [], instructionOnly: true
};
const binding = {
  schemaVersion: 3, bindingId: "developer-tdd", role: "developer", provider: "codex", scope,
  skill: { skillId: "tdd", version: "1.0.0", digest }, required: true
};
const manifest = {
  schemaVersion: 3, manifestId: "skills-1", environmentId: "env-1", scope, role: "developer", provider: "codex",
  digest, skills: [skill], bindings: [binding]
};
const command = {
  schemaVersion: 3, commandId: "command-1", correlationId: "correlation-1", scope, requestedAt: now,
  idempotencyKey: "command-1", operation: { name: "workflow.request", intent: "bugfix", objective: "Repair sorting", entrypoint: "conversation" }
};

describe("platform version and compatible capabilities", () => {
  it("retains the existing unversioned AgentCapability document", () => {
    expect(AgentCapabilitySchema.parse({ id: "implementation", name: "Developer", category: "implementation",
      description: "Scoped implementation", readOnly: false }).id).toBe("implementation");
  });
  it.each([undefined, 1, 2, 4])("rejects platform version %s without an implicit upcast", schemaVersion => {
    expect(AgentEnvironmentSchema.safeParse({ ...environment, schemaVersion }).success).toBe(false);
  });
  it("rejects undeclared permission fields and validates port result envelopes", () => {
    expect(PermissionProfileSchema.safeParse({ ...permission, bypass: true }).success).toBe(false);
    expect(OperationResultSchema(AgentHealthResultSchema).safeParse({ ok: true, value: health }).success).toBe(true);
  });
});

describe("permission scope and launch isolation", () => {
  it("accepts workspace policy and OS-isolated unattended sessions", () => {
    expect(AgentLaunchProfileSchema.safeParse(launch).success).toBe(true);
    expect(PermissionProfileSchema.safeParse({ ...permission, mode: "unattended_isolated", isolation: "container" }).success).toBe(true);
  });
  it.each([
    { scope: machine }, { allowGlobalPermissionBypass: true },
    { mode: "restricted" }, { filesystem: "read_only" },
    { mode: "unattended_isolated" }, { mode: "unattended_isolated", scope: repo, isolation: "os_sandbox" },
    { network: { mode: "deny", allowedHosts: ["example.test"] } }
  ])("rejects widening/inconsistent profile %j", patch => {
    expect(PermissionProfileSchema.safeParse({ ...permission, ...patch }).success).toBe(false);
  });
  it("rejects cross-repository environment permissions and direct specialist user input", () => {
    expect(AgentEnvironmentSchema.safeParse({ ...environment, permissionProfile: { ...permission, scope: { ...scope, repositoryId: "other" } } }).success).toBe(false);
    expect(AgentLaunchProfileSchema.safeParse({ ...launch, interaction: "conversation" }).success).toBe(false);
    expect(AgentLaunchProfileSchema.safeParse({ ...launch, argv: ["arg\0injection"] }).success).toBe(false);
  });
  it("checks containment across machine, repo and session boundaries", () => {
    expect(isTrustScopeWithin(scope, machine)).toBe(true);
    expect(isTrustScopeWithin(scope, repo)).toBe(true);
    expect(isTrustScopeWithin(machine, scope)).toBe(false);
    expect(isTrustScopeWithin({ ...scope, sessionId: "other" }, scope)).toBe(false);
    expect(isTrustScopeWithin({ ...scope, machineId: "other" }, machine)).toBe(false);
  });
});

describe("strict readiness", () => {
  it("does not require a fabricated task receipt before launch", () => {
    expect(AgentHealthResultSchema.safeParse(health).success).toBe(true);
  });
  it.each(AGENT_HEALTH_CHECKS.filter(check => check !== "native_binding"))("requires positive %s evidence", check => {
    expect(AgentHealthResultSchema.safeParse({ ...health, checks: health.checks.filter(item => item.check !== check) }).success).toBe(false);
    expect(AgentHealthResultSchema.safeParse({ ...health, checks: health.checks.map(item => item.check === check ? { ...item, status: "unknown" } : item) }).success).toBe(false);
  });
  it("requires activated proof and native-binding check; a parsed signature is not authentication", () => {
    expect(AgentHealthResultSchema.safeParse({ ...health, stage: "activated" }).success).toBe(false);
    expect(AgentHealthResultSchema.safeParse({ ...health, stage: "activated", launchAttestation: attestation,
      checks: [...health.checks, { check: "native_binding", status: "passed", code: "verified", message: "Signature checked by host" }] }).success).toBe(true);
  });
  it.each([now, "2026-10-16T00:05:01Z"])("rejects stale or excessively long readiness TTL %s", validUntil => {
    expect(AgentHealthResultSchema.safeParse({ ...health, validUntil }).success).toBe(false);
  });
  it("rejects duplicate health checks and mismatched startup identities", () => {
    expect(AgentHealthResultSchema.safeParse({ ...health, checks: [...health.checks, health.checks[0]] }).success).toBe(false);
    const request = { schemaVersion: 3, environment, stage: "activated", launchProfile: launch, launchAttestation: attestation, requestedAt: now };
    expect(AgentHealthRequestSchema.safeParse(request).success).toBe(true);
    expect(AgentHealthRequestSchema.safeParse({ ...request, launchAttestation: { ...attestation, launchFingerprint: otherDigest } }).success).toBe(false);
    expect(AgentHealthRequestSchema.safeParse({ ...request, launchAttestation: { ...attestation, sessionId: "other" } }).success).toBe(false);
  });
});

describe("setup boundaries and recovery receipts", () => {
  it("requires machine approval, matching level/scope and validated install request", () => {
    expect(SetupStepSchema.safeParse(step).success).toBe(true);
    expect(SetupStepSchema.safeParse({ ...step, requiresApproval: false }).success).toBe(false);
    expect(SetupStepSchema.safeParse({ ...step, level: "repository" }).success).toBe(false);
    expect(SetupStepSchema.safeParse({ ...step, action: "install_tool" }).success).toBe(false);
    expect(SetupApplyRequestSchema.safeParse({ schemaVersion: 3, planId: "plan-1", planDigest: digest, step }).success).toBe(false);
  });
  it.each([
    [step, step], [{ ...step, dependsOn: ["missing"] }],
    [{ ...step, dependsOn: ["later"] }, { ...step, stepId: "later", dependsOn: ["configure"] }],
    [{ ...step, scope: { ...machine, machineId: "other" } }]
  ])("rejects duplicate, missing, cyclic or cross-machine setup DAG %j", steps => {
    expect(MachineSetupPlanSchema.safeParse({ ...plan, steps }).success).toBe(false);
  });
  it("requires read-back success and preserves an unknown partial setup", () => {
    const receipt = { schemaVersion: 3, receiptId: "receipt-1", planId: "plan-1", planDigest: digest, stepId: "configure",
      scope: machine, status: "applied", desiredStateDigest: digest, observedStateDigest: otherDigest,
      ownedPaths: [], observedAt: now, diagnostics: [], idempotencyKey: "configure" };
    expect(SetupReceiptSchema.safeParse(receipt).success).toBe(false);
    expect(SetupReceiptSchema.safeParse({ ...receipt, status: "unknown", observedStateDigest: null }).success).toBe(true);
  });
});

describe("MCP categories, registrations and resource leases", () => {
  it("accepts inventory CLI tools but rejects representing them as MCP services", () => {
    expect(ToolCapabilitySchema.safeParse({ ...tool, kind: "cli_only" }).success).toBe(true);
    expect(MCPServiceDefinitionSchema.safeParse(service).success).toBe(true);
    expect(MCPServiceDefinitionSchema.safeParse({ ...service, tool: { ...tool, kind: "cli_only" } }).success).toBe(false);
    expect(MCPServiceDefinitionSchema.safeParse({ ...service, connection: { kind: "existing_shared_worker", workerId: "worker-1", endpoint: "http://127.0.0.1:9000/mcp", ownership: "external" } }).success).toBe(false);
  });
  it("distinguishes adopted workers and owned stdio bridges", () => {
    expect(MCPServiceDefinitionSchema.safeParse({ ...service, tool: { ...tool, kind: "existing_shared_worker" },
      connection: { kind: "existing_shared_worker", workerId: "worker-1", endpoint: "http://127.0.0.1:9000/mcp", ownership: "external" } }).success).toBe(true);
    const stdio = { ...service, tool: { ...tool, kind: "stdio_mcp" }, connection: { kind: "stdio_mcp",
      executable: "/managed/mcp", executableDigest: digest, argv: [], environmentBindings: {}, ownership: "bflow", bridgeRequired: true } };
    expect(MCPServiceDefinitionSchema.safeParse(stdio).success).toBe(true);
    expect(MCPServiceDefinitionSchema.safeParse({ ...stdio, connection: { ...stdio.connection, bridgeRequired: false } }).success).toBe(false);
  });
  it.each(["bad-url", "http://remote.test/mcp", "https://user:password@remote.test/mcp", "https://remote.test/mcp?token=x", "https://remote.test/mcp#token"])("rejects unsafe/malformed endpoint %s without throwing", endpoint => {
    expect(MCPEndpointSchema.safeParse(endpoint).success).toBe(false);
  });
  it("requires a scoped secret reference rather than a raw client token", () => {
    const client = { schemaVersion: 3, registrationId: "client-1", provider: "codex", role: "developer", scope,
      environmentId: "env-1", serviceIds: ["docs"], allowedTools: ["search"], connection: { transport: "streamable_http",
        endpoint: "http://127.0.0.1:9000/mcp", token: "secret://gateway/client-1" }, configDigest: digest, expiresAt: later, idempotencyKey: "client-1" };
    expect(MCPClientRegistrationSchema.safeParse(client).success).toBe(true);
    expect(MCPClientRegistrationSchema.safeParse({ ...client, scope: machine }).success).toBe(false);
    expect(MCPClientRegistrationSchema.safeParse({ ...client, connection: { ...client.connection, token: "raw-token" } }).success).toBe(false);
  });
  it("requires negotiated tool discovery and rejects expired/cross-client resource proof", () => {
    expect(MCPServiceObservationSchema.safeParse({ schemaVersion: 3, serviceId: "docs", revision: 1, instanceId: "instance-1",
      status: "ready", discoveredTools: [], ownership: "external", activeClientCount: 0, observedAt: now, diagnosticCode: "listening" }).success).toBe(false);
    const lease = { schemaVersion: 3, leaseId: "lease-1", serviceId: "chrome", resourceKey: "chrome-profile-1", registrationId: "client-1",
      fencingToken: 1, acquiredAt: now, expiresAt: later };
    expect(MCPResourceLeaseSchema.safeParse(lease).success).toBe(true);
    expect(MCPResourceLeaseSchema.safeParse({ ...lease, expiresAt: now }).success).toBe(false);
    expect(MCPToolCallSchema.safeParse({ schemaVersion: 3, callId: "call-1", registrationId: "client-2", serviceId: "chrome",
      tool: "navigate", input: {}, resourceLease: lease, idempotencyKey: "call-1" }).success).toBe(false);
  });
});

describe("role skill manifests and commands", () => {
  it("binds exact skill content to compatible role/provider/session", () => {
    expect(SkillManifestSchema.safeParse(manifest).success).toBe(true);
    for (const patch of [{ provider: "claude" }, { role: "reviewer" }, { scope: { ...scope, sessionId: "other" } }])
      expect(SkillManifestSchema.safeParse({ ...manifest, bindings: [{ ...binding, ...patch }] }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...manifest, bindings: [{ ...binding, skill: { ...binding.skill, digest: otherDigest } }] }).success).toBe(false);
  });
  it("rejects executable skills, unapproved repo skills, duplicates and dependency cycles", () => {
    for (const patch of [{ instructionOnly: false }, { source: "repository" },
      { dependencies: [{ skillId: "tdd", version: "1.0.0", digest }] },
      { dependencies: [{ skillId: "missing", version: "1.0.0", digest }] }])
      expect(SkillManifestSchema.safeParse({ ...manifest, skills: [{ ...skill, ...patch }] }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...manifest, bindings: [binding, binding] }).success).toBe(false);
    const dependency = { ...skill, skillId: "base", dependencies: [{ skillId: "tdd", version: "1.0.0", digest }] };
    expect(SkillManifestSchema.safeParse({ ...manifest, skills: [dependency, { ...skill, dependencies: [{ skillId: "base", version: "1.0.0", digest }] }],
      bindings: [binding, { ...binding, bindingId: "base", skill: { skillId: "base", version: "1.0.0", digest } }] }).success).toBe(false);
  });
  it("routes workflow requests through Conversation and rejects setup scope escalation", () => {
    expect(BflowCommandSchema.safeParse(command).success).toBe(true);
    expect(BflowCommandSchema.safeParse({ ...command, operation: { ...command.operation, entrypoint: "developer" } }).success).toBe(false);
    expect(BflowCommandSchema.safeParse({ ...command, scope: machine }).success).toBe(false);
    expect(BflowCommandSchema.safeParse({ ...command, operation: { name: "setup.apply", plan, approvalReceiptId: "approved-plan-1" } }).success).toBe(false);
    expect(BflowCommandSchema.safeParse({ ...command, scope: machine,
      operation: { name: "setup.apply", plan, approvalReceiptId: "approved-plan-1" } }).success).toBe(true);
  });
  it("does not encode transport completion as a successful command with an error", () => {
    const result = { schemaVersion: 3, commandId: "command-1", correlationId: "correlation-1", status: "accepted",
      output: { queued: true }, artifacts: [], observedAt: now };
    expect(CommandExecutionResultSchema.safeParse(result).success).toBe(true);
    expect(CommandExecutionResultSchema.safeParse({ ...result, status: "failed" }).success).toBe(false);
    expect(CommandExecutionResultSchema.safeParse({ ...result, status: "succeeded", error: { code: "validation", retryable: false, message: "Rejected" } }).success).toBe(false);
  });
});

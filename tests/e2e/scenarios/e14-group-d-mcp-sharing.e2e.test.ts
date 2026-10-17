import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CURRENT_PLATFORM_SCHEMA_VERSION,
  type MCPClientRegistration,
  type MCPServiceDefinition
} from "@bflow/contracts";
import { BflowSharedMCPGateway, StreamableHttpGatewayServer } from "@bflow/mcp-gateway";
import { afterEach, describe, expect, it } from "vitest";

function readLinuxProcMemoryKb(pid: number): { vmRssKb: number; pssKb: number } {
  let vmRssKb = 0;
  let pssKb = 0;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (rssMatch) vmRssKb = Number(rssMatch[1]);
  } catch {}
  try {
    const smaps = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const pssMatch = smaps.match(/^Pss:\s+(\d+)\s+kB/m);
    if (pssMatch) pssKb = Number(pssMatch[1]);
  } catch {}
  return { vmRssKb, pssKb };
}

describe("Scenario E14 (Group D) — MCP Sharing Across Claude, Codex, Agy & Multiple Developers + Memory Benchmark", () => {
  const tempDirs: string[] = [];
  const children: ChildProcess[] = [];

  function makeTempDir(prefix = "bflow-e14-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    chmodSync(dir, 0o700);
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (children.length > 0) {
      const child = children.pop()!;
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("[REAL SUBPROCESS BACKEND + 6 CONCURRENT AGENTS] shares 1 MCP backend across Claude, Codex, Agy & 3 Developer instances, enforces leases/isolation, recovers from crash, and measures real /proc memory savings", async () => {
    const root = makeTempDir();
    const repoAlpha = join(root, "repo-alpha");
    const repoBeta = join(root, "repo-beta");
    mkdirSync(repoAlpha, { mode: 0o700 });
    mkdirSync(repoBeta, { mode: 0o700 });

    const mcpBackendScript = join(root, "real-mcp-backend.mjs");
    writeFileSync(
      mcpBackendScript,
      `import readline from "node:readline";
import { readFileSync } from "node:fs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let callCount = 0;

function getMem() {
  try {
    const st = readFileSync("/proc/self/status", "utf8");
    const m = st.match(/^VmRSS:\\s+(\\d+)\\s+kB/m);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "shared-code-index", version: "1.0.0", pid: process.pid }
      }
    }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          { name: "query_index", description: "Query shared index", inputSchema: { type: "object" } },
          { name: "exclusive_index_rebuild", description: "Rebuild index exclusively", inputSchema: { type: "object" } }
        ]
      }
    }) + "\\n");
  } else if (msg.method === "tools/call") {
    callCount++;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            backendPid: process.pid,
            callCount,
            vmRssKb: getMem(),
            tool: msg.params?.name,
            caller: msg.params?.arguments?.caller
          })
        }]
      }
    }) + "\\n");
  }
});
`,
      { mode: 0o755 }
    );

    const nodeDigest = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
    const scopeAlphaRepo = {
      kind: "repository" as const,
      machineId: "machine-e14-01",
      repositoryId: "repo-alpha",
      workspaceRoot: repoAlpha
    };
    const scopeAlphaSession = {
      kind: "session" as const,
      machineId: "machine-e14-01",
      repositoryId: "repo-alpha",
      workspaceRoot: repoAlpha,
      sessionId: "sess-alpha-1"
    };
    const scopeBetaSession = {
      kind: "session" as const,
      machineId: "machine-e14-01",
      repositoryId: "repo-beta",
      workspaceRoot: repoBeta,
      sessionId: "sess-beta-1"
    };

    const gateway = new BflowSharedMCPGateway();
    const httpServer = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
    const gatewayUrl = await httpServer.start();
    expect(gatewayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

    try {
      const sharedServiceDef: MCPServiceDefinition = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        serviceId: "shared-code-index",
        revision: 1,
        scope: scopeAlphaRepo,
        tool: {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          toolId: "shared-code-index",
          kind: "stdio_mcp",
          version: "1.0.0",
          required: true,
          operations: ["query_index", "exclusive_index_rebuild"],
          resource: {
            sharing: "concurrent",
            maxConcurrency: 16
          }
        },
        connection: {
          kind: "stdio_mcp",
          executable: process.execPath,
          argv: [mcpBackendScript],
          environmentBindings: {},
          executableDigest: nodeDigest,
          ownership: "bflow",
          bridgeRequired: true
        },
        authentication: { mode: "none" },
        healthTimeoutMs: 10_000,
        idleTimeoutMs: 60_000,
        restartLimit: 3
      };

      const regServiceRes = gateway.registry.registerService(sharedServiceDef);
      expect(regServiceRes.ok).toBe(true);

      const agents = [
        { registrationId: "reg-claude-chat", provider: "claude" as const, role: "conversation" as const },
        { registrationId: "reg-codex-coord", provider: "codex" as const, role: "coordinator" as const },
        { registrationId: "reg-agy-review", provider: "agy" as const, role: "reviewer" as const },
        { registrationId: "reg-claude-dev-1", provider: "claude" as const, role: "developer" as const },
        { registrationId: "reg-codex-dev-2", provider: "codex" as const, role: "developer" as const },
        { registrationId: "reg-agy-dev-3", provider: "agy" as const, role: "developer" as const }
      ];

      for (const a of agents) {
        const clientReg: MCPClientRegistration = {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          registrationId: a.registrationId,
          provider: a.provider,
          role: a.role,
          scope: scopeAlphaSession,
          environmentId: `env-${a.registrationId}`,
          serviceIds: ["shared-code-index"],
          allowedTools: ["query_index", "exclusive_index_rebuild"],
          connection: {
            transport: "streamable_http",
            endpoint: gatewayUrl,
            token: `secret://token-${a.registrationId}`
          },
          configDigest: "c".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          idempotencyKey: `idem-${a.registrationId}`
        };
        const regRes = await gateway.register(clientReg);
        expect(regRes.ok).toBe(true);

        const sessRes = gateway.openSession(a.registrationId);
        expect(sessRes.ok).toBe(true);

        const toolsRes = await gateway.listToolsForClient(a.registrationId);
        expect(toolsRes.ok).toBe(true);
        if (toolsRes.ok) {
          expect(toolsRes.value.map((t) => t.tool)).toContain("query_index");
        }
      }

      // Invoke tool concurrently across all 6 agents
      const callResponses = await Promise.all(
        agents.map((a, idx) =>
          gateway.call({
            schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
            callId: `call-${idx + 1}`,
            registrationId: a.registrationId,
            serviceId: "shared-code-index",
            tool: "query_index",
            input: { caller: a.registrationId },
            idempotencyKey: `idem-call-${idx + 1}`
          })
        )
      );

      const observedBackendPids = new Set<number>();
      for (const resp of callResponses) {
        expect(resp.ok).toBe(true);
        if (resp.ok) {
          expect(resp.value.status).toBe("completed");
          const contentArr = resp.value.output as Array<{ text: string }>;
          const payload = JSON.parse(contentArr[0]!.text) as { backendPid: number };
          observedBackendPids.add(payload.backendPid);
        }
      }

      // All 6 agents (Claude, Codex, Agy + 3 Developers) share the EXACT SAME single backend OS process!
      expect(observedBackendPids.size).toBe(1);
      const sharedBackendPid = [...observedBackendPids][0]!;
      expect(sharedBackendPid).toBeGreaterThan(1);

      const inspectRes = await gateway.serviceManager.inspect("shared-code-index", {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: scopeAlphaSession,
        idempotencyKey: "idem-inspect-1"
      });
      expect(inspectRes.ok).toBe(true);
      if (inspectRes.ok) {
        expect(inspectRes.value.status).toBe("ready");
        expect(inspectRes.value.activeClientCount).toBe(6);
      }

      // Exclusive resource lease contention between Developer 1 and Developer 2
      const lease1 = await gateway.acquireResource({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: scopeAlphaSession,
        registrationId: "reg-claude-dev-1",
        serviceId: "shared-code-index",
        resourceKey: "exclusive-browser-profile",
        ttlMs: 30_000,
        idempotencyKey: "idem-lease-1"
      });
      expect(lease1.ok).toBe(true);

      const lease2Conflict = await gateway.acquireResource({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: scopeAlphaSession,
        registrationId: "reg-codex-dev-2",
        serviceId: "shared-code-index",
        resourceKey: "exclusive-browser-profile",
        ttlMs: 30_000,
        idempotencyKey: "idem-lease-2-conflict"
      });
      expect(lease2Conflict.ok).toBe(false);
      if (!lease2Conflict.ok) {
        expect(lease2Conflict.error.code).toBe("conflict");
      }

      if (lease1.ok) {
        const relRes = await gateway.releaseResource(lease1.value, {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          scope: scopeAlphaSession,
          idempotencyKey: "idem-release-1"
        });
        expect(relRes.ok).toBe(true);
      }

      const lease2AfterRelease = await gateway.acquireResource({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: scopeAlphaSession,
        registrationId: "reg-codex-dev-2",
        serviceId: "shared-code-index",
        resourceKey: "exclusive-browser-profile",
        ttlMs: 30_000,
        idempotencyKey: "idem-lease-2-after"
      });
      expect(lease2AfterRelease.ok).toBe(true);
      if (lease1.ok && lease2AfterRelease.ok) {
        expect(lease2AfterRelease.value.fencingToken).toBeGreaterThan(lease1.value.fencingToken);
      }

      // Cross-project isolation: agent in repo-beta cannot register or call repo-alpha's repository-scoped service
      const betaClientReg: MCPClientRegistration = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        registrationId: "reg-beta-attacker",
        provider: "claude",
        role: "developer",
        scope: scopeBetaSession,
        environmentId: "env-beta-attacker",
        serviceIds: ["shared-code-index"],
        allowedTools: ["query_index"],
        connection: {
          transport: "streamable_http",
          endpoint: gatewayUrl,
          token: "secret://token-beta-attacker"
        },
        configDigest: "d".repeat(64),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        idempotencyKey: "idem-beta-reg"
      };
      await gateway.register(betaClientReg);
      const crossProjectCall = await gateway.call({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-beta-attack",
        registrationId: "reg-beta-attacker",
        serviceId: "shared-code-index",
        tool: "query_index",
        input: { caller: "repo-beta-attacker" },
        idempotencyKey: "idem-call-beta-attack"
      });
      expect(crossProjectCall.ok).toBe(false);

      // Real Linux /proc/<pid>/smaps_rollup Memory Benchmark: 1 Shared Backend vs 6 Per-Agent Isolated Backends
      const sharedMem = readLinuxProcMemoryKb(sharedBackendPid);
      expect(sharedMem.vmRssKb).toBeGreaterThan(0);

      const isolatedPids: number[] = [];
      for (let i = 0; i < 6; i++) {
        const child = spawn(process.execPath, [mcpBackendScript], { stdio: ["pipe", "pipe", "pipe"] });
        children.push(child);
        await new Promise<void>((resolveReady) => {
          child.stdout.once("data", () => resolveReady());
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
        });
        isolatedPids.push(child.pid!);
      }

      const isolatedMetrics = isolatedPids.map((pid) => readLinuxProcMemoryKb(pid));
      const totalIsolatedRssKb = isolatedMetrics.reduce((acc, m) => acc + m.vmRssKb, 0);
      const totalIsolatedPssKb = isolatedMetrics.reduce((acc, m) => acc + m.pssKb, 0);

      expect(totalIsolatedRssKb).toBeGreaterThan(sharedMem.vmRssKb * 3);
      if (sharedMem.pssKb > 0 && totalIsolatedPssKb > 0) {
        expect(totalIsolatedPssKb).toBeGreaterThan(sharedMem.pssKb * 2);
      }

      // Service crash & restart recovery
      process.kill(sharedBackendPid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 150));

      const postRestartResp = await gateway.call({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-after-crash-1",
        registrationId: "reg-claude-chat",
        serviceId: "shared-code-index",
        tool: "query_index",
        input: { caller: "reg-claude-chat-after-restart" },
        idempotencyKey: "idem-call-after-crash-1"
      });
      expect(postRestartResp.ok).toBe(true);
      if (postRestartResp.ok) {
        const contentArr = postRestartResp.value.output as Array<{ text: string }>;
        const postRestartPayload = JSON.parse(contentArr[0]!.text) as { backendPid: number };
        expect(postRestartPayload.backendPid).toBeGreaterThan(1);
        expect(postRestartPayload.backendPid).not.toBe(sharedBackendPid);
      }
    } finally {
      await httpServer.stop();
      await gateway.serviceManager.release("shared-code-index", {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: scopeAlphaSession,
        idempotencyKey: "idem-release-svc"
      });
    }
  }, 30_000);
});

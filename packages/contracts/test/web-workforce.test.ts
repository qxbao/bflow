import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WebActivityEntrySchema, WebAgentViewSchema, WebAgentWorkSchema, WebHandoffViewSchema,
  WebHttpContracts, WebPageSchema, WebWorkforceViewSchema
} from "../src/web.js";

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/local-web/${name}`, import.meta.url), "utf8"));
const full = () => fixture("workforce-full.json");

describe("D-WEB-03 workforce projection contract", () => {
  it("round trips workforce view", () => {
    for (const name of ["workforce-full.json", "workforce-empty.json"]) {
      const raw = fixture(name);
      expect(WebWorkforceViewSchema.parse(raw)).toEqual(raw);
    }
  });
  it("rejects unknown fields at every level", () => {
    const view = full();
    expect(WebWorkforceViewSchema.safeParse({ ...view, extra: 1 }).success).toBe(false);
    const agent = structuredClone(view); agent.agents[0].extra = 1;
    expect(WebWorkforceViewSchema.safeParse(agent).success).toBe(false);
    const transport = structuredClone(view); transport.agents[0].transport.extra = 1;
    expect(WebWorkforceViewSchema.safeParse(transport).success).toBe(false);
    const work = structuredClone(view); work.agents[2].work[0].extra = 1;
    expect(WebWorkforceViewSchema.safeParse(work).success).toBe(false);
    const handoff = structuredClone(view); handoff.handoffs[0].from.extra = 1;
    expect(WebWorkforceViewSchema.safeParse(handoff).success).toBe(false);
    expect(WebActivityEntrySchema.safeParse({ entryId: "6f1b3b0e-7d6f-4c9a-9a1e-0d1d2f2f3a4b", occurredAt: "2026-11-02T00:00:00.000Z",
      kind: "assignment", role: "developer", action: "accepted", runId: "r", extra: 1 }).success).toBe(false);
  });
  it("rejects paneId, cwd, worktreePath, session and metadata", () => {
    for (const key of ["paneId", "cwd", "worktreePath", "session", "metadata", "token"]) {
      const agent = structuredClone(full()); agent.agents[0][key] = "x";
      expect(WebAgentViewSchema.safeParse(agent.agents[0]).success, key).toBe(false);
      const view = structuredClone(full()); view.agents[0][key] = "x";
      expect(WebWorkforceViewSchema.safeParse(view).success, key).toBe(false);
      const handoff = structuredClone(full()); handoff.handoffs[0][key] = "x";
      expect(WebHandoffViewSchema.safeParse(handoff.handoffs[0]).success, key).toBe(false);
    }
  });
  it("rejects values outside the closed enums", () => {
    const agent = full().agents[2];
    expect(WebAgentViewSchema.safeParse({ ...agent, role: "wizard" }).success).toBe(false);
    expect(WebAgentViewSchema.safeParse({ ...agent, allocation: "done" }).success).toBe(false);
    expect(WebAgentViewSchema.safeParse({ ...agent, group: "office" }).success).toBe(false);
    expect(WebAgentWorkSchema.safeParse({ ...agent.work[0], delivery: "done" }).success).toBe(false);
    expect(WebAgentWorkSchema.safeParse({ ...agent.work[0], kind: "other" }).success).toBe(false);
    expect(WebHandoffViewSchema.safeParse({ ...full().handoffs[0], state: "succeeded" }).success).toBe(false);
    expect(WebHandoffViewSchema.safeParse({ ...full().handoffs[0], ordinal: -1 }).success).toBe(false);
  });
  it("caps agents, work, handoffs and evidence", () => {
    const view = full();
    const agent = view.agents[0];
    const work = view.agents[2].work[0];
    const handoff = view.handoffs[1];
    const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ ...agent, instanceId: `agent-${i}` }));
    expect(WebWorkforceViewSchema.safeParse({ ...view, agents: agents(100) }).success).toBe(true);
    expect(WebWorkforceViewSchema.safeParse({ ...view, agents: agents(101) }).success).toBe(false);
    const handoffs = (n: number) => Array.from({ length: n }, (_, i) => ({ ...handoff, handoffId: `h-${i}`, ordinal: i }));
    expect(WebWorkforceViewSchema.safeParse({ ...view, handoffs: handoffs(100) }).success).toBe(true);
    expect(WebWorkforceViewSchema.safeParse({ ...view, handoffs: handoffs(101) }).success).toBe(false);
    const works = (n: number) => Array.from({ length: n }, (_, i) => ({ ...work, messageId: `m-${i}` }));
    expect(WebAgentViewSchema.safeParse({ ...agent, work: works(8) }).success).toBe(true);
    expect(WebAgentViewSchema.safeParse({ ...agent, work: works(9) }).success).toBe(false);
    const evidence = (n: number) => Array.from({ length: n }, () => handoff.evidence[0]);
    expect(WebHandoffViewSchema.safeParse({ ...handoff, evidence: evidence(20) }).success).toBe(true);
    expect(WebHandoffViewSchema.safeParse({ ...handoff, evidence: evidence(21) }).success).toBe(false);
    expect(WebAgentViewSchema.safeParse({ ...agent, displayName: "x".repeat(201) }).success).toBe(false);
    expect(WebAgentViewSchema.safeParse({ ...agent, displayName: "  " }).success).toBe(false);
  });
  it("registers read-only workforce and activity routes without altering neighbours", () => {
    expect(WebHttpContracts.workforce).toMatchObject({ method: "GET", path: "/api/v1/projects/:id/workforce", statuses: [200] });
    expect(WebHttpContracts.workforce.response).toBe(WebWorkforceViewSchema);
    expect(WebHttpContracts.workforce.body.safeParse(undefined).success).toBe(true);
    expect(WebHttpContracts.workforce.query.safeParse({ x: 1 }).success).toBe(false);
    expect(WebHttpContracts.activity).toMatchObject({ method: "GET", path: "/api/v1/projects/:id/runs/:runId/activity", statuses: [200] });
    expect(WebHttpContracts.activity.query.safeParse({ cursor: "c1" }).success).toBe(true);
    expect(WebHttpContracts.activity.query.safeParse({}).success).toBe(true);
    expect(WebHttpContracts.activity.query.safeParse({ cursor: "" }).success).toBe(false);
    expect(WebHttpContracts.activity.query.safeParse({ other: "x" }).success).toBe(false);
    const entry = { entryId: "6f1b3b0e-7d6f-4c9a-9a1e-0d1d2f2f3a4b", occurredAt: "2026-11-02T00:00:00.000Z",
      kind: "assignment", role: "developer", action: "accepted", runId: "r" };
    expect(WebHttpContracts.activity.response.safeParse({ apiVersion: 1, items: [entry] }).success).toBe(true);
    expect(WebHttpContracts.activity.response.safeParse({ apiVersion: 1, items: [{ ...entry, entryId: "not-uuid" }] }).success).toBe(false);
    expect(WebPageSchema(WebActivityEntrySchema).safeParse({ apiVersion: 1, items: [] }).success).toBe(true);
    expect(Object.keys(WebHttpContracts)).toEqual(expect.arrayContaining(["session", "runs", "run", "events", "sendMessage"]));
  });
  it("keeps the browser closure of web.ts limited to pure zod modules", () => {
    // Baseline before D-WEB-03 plus agent-roles.ts, a zod-only leaf needed for AgentRoleSchema.
    const expected = ["agent-roles.ts", "agent.ts", "approval.ts", "artifact.ts", "common.ts", "conversation-status.ts",
      "errors.ts", "execution.ts", "quality.ts", "sdlc.ts", "web.ts"];
    const visited = new Set<string>();
    const visit = (path: string) => {
      if (visited.has(path)) return;
      visited.add(path);
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/(?:node:|\bBuffer\b|\bprocess\b|web-host|role-profile|receipts\.js)/);
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (specifier.startsWith(".")) visit(resolve(dirname(path), specifier.replace(/\.js$/, ".ts")));
        else expect(specifier).toBe("zod");
      }
    };
    const temporary = mkdtempSync(join(tmpdir(), "bflow web workforce closure "));
    try {
      cpSync(fileURLToPath(new URL("../src/", import.meta.url)), temporary, { recursive: true });
      visit(fileURLToPath(pathToFileURL(join(temporary, "web.ts"))));
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    expect([...visited].map(path => basename(path)).sort()).toEqual(expected);
  });
});

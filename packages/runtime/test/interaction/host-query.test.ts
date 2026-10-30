import { mkdtemp, readdir, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  openUserInteractionClient,
  interactionProjectId,
} from "../../src/interaction/client.js";
it("missing host stays readable unavailable without writing files or starting processes", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "web-query-"));
  try {
    const client = await openUserInteractionClient({
      repositoryPath,
      sessionId: "s1",
    });
    const projectId = interactionProjectId(repositoryPath);
    expect(await client.readProjectSession(projectId)).toMatchObject({
      ok: true,
      value: { state: "unavailable", pendingIntakes: [] },
    });
    expect(await client.listRuns(projectId, {})).toMatchObject({
      ok: false,
      error: { code: "transport_unavailable" },
    });
    expect(await client.listRuns("foreign", {})).toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
    expect(await readdir(repositoryPath)).toEqual([]);
    expect(await client.readOperation(projectId, "op")).toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
it("rejects unsafe session input", async () => {
  await expect(
    openUserInteractionClient({ repositoryPath: ".", sessionId: "../s" }),
  ).rejects.toThrow();
});

import { mkdir, writeFile, readFile } from "node:fs/promises";
import {
  ensureAgenticHost,
  queryAgenticHostInteraction,
} from "../../dist/agentic/host-controller.js";
import { findPrivateRuntimeStateDirectory } from "../../src/private-state.js";
import { state, run, at, clarificationContext } from "./fixtures.js";
it("queries a real host subprocess before Core without activating it, scopes reads and redacts private values", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "web-query-host-"));
  const sessionId = "host-1";
  // Queries must not depend on a machine-installed Herdr. Only cleanup may observe
  // the stopped synthetic session; any unexpected transport command fails this fixture.
  const herdrBinary = join(repositoryPath, "herdr-fixture.mjs");
  const callsPath = join(repositoryPath, "herdr-calls.jsonl");
  const shutdownArgs = ["--session", sessionId, "status", "server", "--json"];
  await writeFile(
    herdrBinary,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      `const expected = ${JSON.stringify(shutdownArgs)};`,
      "if (JSON.stringify(args) !== JSON.stringify(expected)) throw new Error('Unexpected Herdr command in read-only fixture');",
      `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');`,
      "process.stdout.write(JSON.stringify({ running: false }) + '\\n');",
    ].join("\n"),
    { mode: 0o700 },
  );
  const controller = await ensureAgenticHost({
    repositoryPath,
    sessionId,
    herdrBinary,
  });
  try {
    const root = findPrivateRuntimeStateDirectory(repositoryPath)!;
    const configuration = JSON.parse(
      await readFile(join(root, "host", sessionId, "host.json"), "utf8"),
    );
    const manifestDir = join(repositoryPath, ".bflow/state/panes");
    await mkdir(manifestDir, { recursive: true });
    const pane = {
      schemaVersion: 2,
      bindingId: "binding",
      sessionId,
      role: "conversation",
      agentId: "agent",
      workspaceId: "workspace",
      tabId: "tab",
      paneId: "pane",
      provider: "claude",
      agentKind: "claude",
      cwd: repositoryPath,
      isolationMode: "dedicated_pane",
      readOnlyWorkspace: true,
      transportState: "done",
      boundAt: at,
    };
    await writeFile(
      join(manifestDir, sessionId + ".manifest.json"),
      JSON.stringify({
        schemaVersion: 2,
        sessionId,
        projectName: "Project",
        workspaceRoot: repositoryPath,
        herdrWorkspaceId: "workspace",
        herdrTabId: "tab",
        status: "up",
        conversationSessionId: "conversation-1",
        activeRunIds: [],
        panes: [
          pane,
          {
            ...pane,
            bindingId: "coordinator-binding",
            role: "coordinator",
            agentId: "coordinator",
            paneId: "coordinator-pane",
          },
        ],
        attachTarget: { role: "conversation", paneId: "pane" },
        createdAt: at,
        updatedAt: at,
      }),
    );
    const r = run();
    r.delegation.title =
      "token=" + configuration.token + " " + configuration.socketPath;
    const foreign = run("foreign");
    foreign.delegation.sessionId = "other";
    const journalPath = join(root, "agentic/journal/state.json");
    await mkdir(join(root, "agentic/journal"), { recursive: true });
    await writeFile(
      journalPath,
      JSON.stringify({ ...state([r, foreign]), repository: repositoryPath }),
    );
    const contextPath = join(
      root,
      "agentic/conversation/conversation-1.context.json",
    );
    await mkdir(join(root, "agentic/conversation"), { recursive: true });
    await writeFile(
      contextPath,
      JSON.stringify(clarificationContext(sessionId)),
    );
    // A second run makes a cursor; changes in the journal must report conflict, not host loss.
    const second = run("second");
    await writeFile(
      journalPath,
      JSON.stringify({
        ...state([r, foreign, second]),
        repository: repositoryPath,
      }),
    );
    const before = await readFile(journalPath);
    const client = await openUserInteractionClient({
      repositoryPath,
      sessionId,
    });
    const projectId = interactionProjectId(repositoryPath);
    await queryAgenticHostInteraction(
      { repositoryPath, sessionId },
      { kind: "run", projectId, runId: r.runId },
    );
    const result = await client.readRun(projectId, r.runId);
    expect(result).toMatchObject({
      ok: true,
      value: { runId: r.runId, coreStatus: null, sdlcStatus: "planning" },
    });
    expect(JSON.stringify(result)).not.toContain(configuration.token);
    expect(JSON.stringify(result)).not.toContain(configuration.socketPath);
    expect(await client.readRun(projectId, "foreign")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await client.readProjectSession("foreign")).toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
    expect(await client.readProjectSession(projectId)).toMatchObject({
      ok: true,
      value: { state: "unavailable" },
    });
    const session = await client.readProjectSession(projectId);
    expect(session).toMatchObject({
      ok: true,
      value: {
        conversationStatus: "awaiting_user_clarification",
        pendingIntakes: [
          {
            intakeId: "intake-1",
            status: "clarifying",
            clarifications: [{ question: "Which behavior?" }],
          },
        ],
      },
    });
    const page = await client.listRuns(projectId, { limit: 1 });
    if (!page.ok) throw new Error("expected page");
    second.status = "failed";
    await writeFile(
      journalPath,
      JSON.stringify({
        ...state([r, foreign, second]),
        repository: repositoryPath,
      }),
    );
    expect(
      await client.listRuns(projectId, {
        limit: 1,
        cursor: page.value.nextCursor,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    await writeFile(journalPath, before);
    const savedContext = await readFile(contextPath);
    await client.readProjectSession(projectId);
    expect(await readFile(contextPath)).toEqual(savedContext);
    // Cross-process principal scope is enforced again inside the host, not only by the client.
    expect(
      await queryAgenticHostInteraction(
        { repositoryPath, sessionId },
        { kind: "runs", projectId: "foreign", query: {} },
      ),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await readdir(join(root, "agentic/journal"))).toEqual([
      "state.json",
    ]);
    expect(await readFile(journalPath)).toEqual(before);
    expect(await readdir(join(root, "host", sessionId))).not.toContain(
      "launch-index.json",
    );
    expect(await readdir(repositoryPath)).not.toContain("herdr-calls.jsonl");
    const largeRun = run('large-journal');
    largeRun.delegation.metadata = {retainedDiagnostic:'x'.repeat(17*1024*1024)};
    await writeFile(journalPath,JSON.stringify({...state([largeRun]),repository:repositoryPath}));
    expect(await client.listRuns(projectId,{})).toMatchObject({ok:true,value:{items:[{runId:'large-journal'}]}});
    await truncate(journalPath,64*1024*1024+1);
    expect(await client.listRuns(projectId,{})).toMatchObject({ok:false});

  } finally {
    try {
      await controller.shutdown();
      expect(
        (await readFile(callsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([shutdownArgs]);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  }
}, 30000);

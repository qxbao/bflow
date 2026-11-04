import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WebCommandSchema } from "@bflow/contracts";
// The host process runs the built source (dist), exactly as the CLI spawns it; build before this test.
import { callDirectorOwnerHost, callDirectorTool, callUserInteractionHost, ensureAgenticHost, queryAgenticHostInteraction,
  registerUserInteractionIssuer } from "../../dist/agentic/host-controller.js";
import { callHost } from "../../src/agentic/host-protocol.js";
import { interactionProjectId } from "../../src/interaction/client.js";
import { openLocalDirectorServices } from "../../src/director/web.js";
import { fixture } from "../interaction/web-command-fixtures.js";

/**
 * Production ingress: a real host process (Director layout, not activated: no Herdr session/manifest) reached over its private
 * socket with the three credential kinds. Covers host.ts credential routing, the owner query intercept and the not-ready
 * refusal; ready-path guards (session/run mismatch, queue while absent) are covered at the bridge in web-bridge.test.ts.
 */
it("routes Director Web, Director-token and owner calls through the host credential switch", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "director-ingress-")));
  const herdrBinary = join(directory, "herdr-fixture.mjs");
  await writeFile(herdrBinary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false}) + "\\n");\n', { mode: 0o700 });
  const host = { repositoryPath: directory, sessionId: "host-1" };
  const controller = await ensureAgenticHost({ ...host, herdrBinary, layout: "director", progressCommand: ["bflow", "progress", "--follow"] });
  try {
    const projectId = interactionProjectId(directory);
    const f = fixture();
    const registered = await registerUserInteractionIssuer(host, { ...f.registration, projectId, principalId: `local-user-${process.getuid?.() ?? "local"}` });
    const web = registered.credential;
    const director = (await callDirectorOwnerHost(host, "director_register", { provider: "claude" })) as { token: string; cursor: string };
    const send = { apiVersion: 1, messageId: randomUUID(), projectId, sessionId: "conv-1", content: "duyệt #1" };

    // Infrastructure not ready (no activated manifest): Web send is refused and nothing is written.
    expect(await callUserInteractionHost(host, web, "interaction_director_send", send))
      .toMatchObject({ ok: false, error: { code: "transport_unavailable", details: { reason: "unavailable" } } });
    // A Director reply is stored; the Web transcript read shows it (redacted) and never the refused Web message.
    await callDirectorTool(host, director.token, "director_say", { text: `xin chào, token ${director.token}` });
    const history = await callUserInteractionHost(host, web, "interaction_director_history", { projectId });
    expect(history).toMatchObject({ ok: true, value: { items: [{ seq: 1, author: "director", channel: "cli" }] } });
    expect(JSON.stringify(history)).not.toContain(director.token);
    expect(JSON.stringify(history)).not.toContain("duyệt #1");

    // Web credential: no Director tools, owner Director methods, owner queries or approvals.
    await expect(callHost(registered.socketPath, web, "director_call", { name: "director_say", arguments: { text: "x" } })).rejects.toThrow();
    await expect(callHost(registered.socketPath, web, "director_register", { provider: "claude" })).rejects.toThrow();
    await expect(callHost(registered.socketPath, web, "director_issue_status", { issueId: "i", status: "dismissed" })).rejects.toThrow();
    await expect(callHost(registered.socketPath, web, "interaction_query", { kind: "director", projectId })).rejects.toThrow();
    await expect(callHost(registered.socketPath, web, "human_decision_cli", {})).rejects.toThrow();
    // Director token: only director_call.
    await expect(callHost(registered.socketPath, director.token, "interaction_director_send", send)).rejects.toThrow("Director credentials can only call director tools");
    await expect(callHost(registered.socketPath, director.token, "interaction_director_history", { projectId })).rejects.toThrow("Director credentials can only call director tools");
    await expect(callHost(registered.socketPath, director.token, "interaction_query", { kind: "director", projectId })).rejects.toThrow("Director credentials can only call director tools");
    // Owner token: owner queries, but not the Web-credential methods.
    await expect(callDirectorOwnerHost(host, "interaction_director_send" as never, send)).rejects.toThrow();
    await expect(callDirectorOwnerHost(host, "interaction_director_history" as never, { projectId })).rejects.toThrow();
    const view = await queryAgenticHostInteraction(host, { kind: "director", projectId });
    expect(view).toMatchObject({ ok: true, value: { layout: "not_started", transcriptSeq: 1, cliCaptureMayBeIncomplete: true,
      snapshot: { director: { presence: "active", provider: "claude" } } } });
    expect(JSON.stringify(view)).not.toContain(directory);
    expect(JSON.stringify(view)).not.toContain(director.token);
    expect(await queryAgenticHostInteraction(host, { kind: "director_issues", projectId })).toMatchObject({ ok: true, value: { items: [] } });
    expect(await queryAgenticHostInteraction(host, { kind: "director", projectId: "project-other" })).toMatchObject({ ok: false });

    // Signed issue command through interaction_execute: refused while not ready, before any receipt; never reaches Conversation.
    const command = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId, kind: "issue_retry", runId: "run-1",
      issueId: "park:run-1:t:1", expectedUpdatedAt: new Date().toISOString() });
    const principal = f.proof(command as never, { projectId, principalId: registered.principalId,
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });
    expect(await callUserInteractionHost(host, web, "interaction_execute", { command, principal }))
      .toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
    expect(await callUserInteractionHost(host, web, "interaction_operation", { projectId, operationId: command.commandId }))
      .toMatchObject({ ok: false, error: { code: "not_found" } });

    // Client adapter over the same running host: same answers through LocalDirectorServices.
    const services = await openLocalDirectorServices({ ...host, interaction: { credential: web } });
    expect(await services.readDirector(projectId)).toMatchObject({ ok: true, value: { layout: "not_started" } });
    expect(await services.listDirectorMessages(projectId)).toMatchObject({ ok: true, value: { items: [{ seq: 1 }] } });
    expect(await services.sendDirectorMessage({ ...send, messageId: randomUUID() })).toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
  } finally {
    await controller.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

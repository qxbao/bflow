import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DelegationRequestSchema, SessionManifestSchema, type WorkflowPack, type OperationResult, type PaneBinding, type WorkflowRunSnapshot } from "@bflow/contracts";
import { AgenticHostPlatformOptionsSchema } from "../../src/platform/host-options.js";
import { digest } from "../../src/agentic/journal.js";
import { hostInteractionQuery } from "../../src/interaction/views.js";
import { interactionProjectId } from "../../src/interaction/client.js";
import { run, state } from "../interaction/fixtures.js";

/** Queries the real shared Web reader against copied, actual extension authority, without a daemon or provider. */
export async function extensionReadViews(f: {
  root: string; repo: string; pack: WorkflowPack; panes: Map<string, PaneBinding>;
  host: { inspect(runId: string): Promise<unknown> };
  engine: { getSnapshot(runId: string): Promise<OperationResult<WorkflowRunSnapshot | null>> };
}) {
  const root = join(f.root, "read-surface"), hostSession = "host-read", manifestDirectory = join(root, "panes");
  const view = await f.host.inspect("run-native") as { delegation: unknown };
  const delegation = DelegationRequestSchema.parse(view.delegation);
  const current = new Date().toISOString(), base = f.panes.get("specifier")!;
  const manifest = SessionManifestSchema.parse({ schemaVersion: 2, sessionId: hostSession, projectName: "Extension probe", workspaceRoot: f.repo,
    herdrWorkspaceId: "w", herdrTabId: "w:t", status: "up", conversationSessionId: delegation.sessionId,
    activeRunIds: ["run-native"], panes: [{ ...base, sessionId: hostSession, role: "conversation", bindingId: "conversation", paneId: "conversation", agentId: "conversation" },
      { ...base, sessionId: hostSession, role: "coordinator", bindingId: "coordinator", paneId: "coordinator", agentId: "coordinator" }],
    attachTarget: { role: "conversation", paneId: "conversation" }, createdAt: current, updatedAt: current });
  const ordinary = { ...state([run("run-native", { delegation, status: "intake" })]), repository: f.repo };
  const routePath = join(root, "agentic/extensions", digest(hostSession), "routes/state.json");
  await mkdir(join(root, "agentic/journal"), { recursive: true }); await mkdir(join(root, "agentic/extensions", digest(hostSession), "routes"), { recursive: true });
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(join(manifestDirectory, `${hostSession}.manifest.json`), JSON.stringify(manifest));
  await writeFile(join(root, "agentic/journal/state.json"), JSON.stringify(ordinary));
  const route = await readFile(join(f.root, "host-sdk/routes/state.json")); await writeFile(routePath, route);
  const configuration = { repositoryPath: f.repo, sessionId: hostSession, directory: join(root, "host", hostSession),
    socketPath: join(root, "host.sock"), token: "private-test-token", manifestDirectory,
    platform: AgenticHostPlatformOptionsSchema.parse({ schemaVersion: 3, machineId: "read-machine", repositoryId: "read-repo", workflowPack: f.pack,
      roles: ["conversation", "coordinator"].map(role => ({ role, provider: "codex", required: true, permissionMode: "restricted",
        capabilityIds: [], mcpServiceIds: [], toolIds: [], skillSelections: [] })), skillsStoreRoot: "/tmp/read-skills", approvedBuiltinSkillDigests: [] }) };
  const query = { kind: "run", projectId: interactionProjectId(f.repo), runId: "run-native" };
  const readCore = async (id: string) => { const result = await f.engine.getSnapshot(id); if (!result.ok) throw new Error(result.error.message); return result.value ?? undefined; };
  const online = await hostInteractionQuery(configuration, query, { ready: true, readCore });
  const offline = await hostInteractionQuery(configuration, query, { ready: false, readCore });
  const unchanged = (await readFile(routePath)).equals(route);
  return { online, offline, unchanged };
}

import { execFile } from "node:child_process";
import { readFile, lstat, readdir } from "node:fs/promises";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { sign } from "node:crypto";
import { AgentBindingReceiptSchema, RoleMessageSchema, SessionManifestSchema, canonicalReceiptJson } from "@bflow/contracts";
import { createSignedBindingReceipt } from "./receipt-host.js";
import { record, textField } from "./journal.js";

/** Native Herdr action entrypoint; not a model tool and never loads a model API. */
export async function deliverNativeHerdrMessage(env = process.env): Promise<void> {
  if (env.HERDR_ENV !== "1" || env.HERDR_PLUGIN_ID !== "bflow.receipts") throw new Error("Native Herdr plugin invocation required");
  const directory = textField(env.HERDR_PLUGIN_CONFIG_DIR);
  const context = record(JSON.parse(textField(env.HERDR_PLUGIN_CONTEXT_JSON)));
  const serverObservation = await promisify(execFile)(env.HERDR_BIN_PATH ?? "herdr", ["status", "server", "--json"],
    { env, timeout: 10_000, maxBuffer: 1024 * 1024 });
  const currentServer = record(JSON.parse(serverObservation.stdout));
  const currentSession = textField(currentServer.session);
  if (currentServer.running !== true) throw new Error("Native Herdr session is not running");
  // A linked plugin can be shared by named sessions. Select a host only by its
  // actual manifest pane/workspace, never a mutable process-global host.json.
  let configs: Record<string, unknown>[];
  try { configs = await Promise.all((await readdir(resolve(directory, "hosts"))).filter(name => /^[A-Za-z0-9._-]+\.json$/.test(name))
    .map(async name => record(JSON.parse(await readFile(resolve(directory, "hosts", name), "utf8"))))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    configs = [record(JSON.parse(await readFile(resolve(directory, "host.json"), "utf8")))]; }
  const matching: Record<string, unknown>[] = [];
  for (const candidate of configs) {
    if (candidate.herdrSocketPath !== undefined && candidate.herdrSocketPath !== env.HERDR_SOCKET_PATH) continue;
    try {
      const candidateManifest = SessionManifestSchema.parse(JSON.parse(await readFile(textField(candidate.manifestFile), "utf8")));
      if (candidateManifest.sessionId === currentSession && candidateManifest.panes.some(pane => pane.paneId === context.focused_pane_id && pane.workspaceId === context.workspace_id)) matching.push(candidate);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (matching.length !== 1) throw new Error("Native pane must belong to exactly one active host manifest");
  const config = matching[0]!;
  const keyPath = textField(config.privateKeyFile);
  const keyStat = await lstat(keyPath);
  if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) throw new Error("Native signing key must be a private regular file");
  const privateKey = await readFile(keyPath, "utf8");
  let message = RoleMessageSchema.parse(JSON.parse(textField(context.selected_text)));
  const manifest = SessionManifestSchema.parse(JSON.parse(await readFile(textField(config.manifestFile), "utf8")));
  const binding = manifest.panes.find(pane => pane.paneId === message.sender.pane_id && pane.agentId === message.sender.agent_id && pane.role === message.sender.role);
  if (!binding || context.focused_pane_id !== binding.paneId || context.workspace_id !== binding.workspaceId)
    throw new Error("Native message sender is outside the host's role manifest");
  if (message.type === "execution.receipt") {
    const input = AgentBindingReceiptSchema.parse(message.payload);
    const target = input.handle.target;
    if (!target.paneId || !target.session || message.sender.pane_id !== target.paneId || message.sender.agent_id !== target.agentId ||
        message.run_id !== input.handle.runId || !message.causation_id || context.correlation_id !== message.causation_id)
      throw new Error("Native receipt context/assignment mismatch");
    const result = await promisify(execFile)(env.HERDR_BIN_PATH ?? "herdr", ["agent", "get", target.paneId], { env, timeout: 10_000, maxBuffer: 1024 * 1024 });
    const agent = record(record(record(JSON.parse(result.stdout)).result).agent);
    const session = record(agent.agent_session);
    if ((agent.name ?? agent.agent) !== target.agentId || agent.pane_id !== target.paneId ||
        session.source !== target.session.source || session.kind !== target.session.kind || session.value !== target.session.value ||
        (target.workspaceId && agent.workspace_id !== target.workspaceId) || (target.tabId && agent.tab_id !== target.tabId) ||
        (target.terminalId && agent.terminal_id !== target.terminalId) ||
        (target.worktreePath && agent.cwd !== target.worktreePath && agent.foreground_cwd !== target.worktreePath)) throw new Error("Native receipt occupant/session changed");
    if (Date.parse(input.observedAt) > Date.now() || Date.parse(input.observedAt) < Date.parse(input.handle.acceptedAt))
      throw new Error("Native receipt time is outside the submission lifetime");
    const receipt = createSignedBindingReceipt({ receiptId: input.receiptId, issuerId: textField(config.issuerId),
      handle: input.handle, observedAt: input.observedAt, privateKey,
      correlation: { token: message.causation_id, provenance: "transport", verified: true } });
    message = RoleMessageSchema.parse({ ...message, payload: receipt });
  }
  const packet = { issuerId: textField(config.issuerId), message,
    signature: sign(null, Buffer.from(canonicalReceiptJson(message)), privateKey).toString("base64") };
  await new Promise<void>((accept, reject) => {
    const socket = connect(textField(config.runtimeSocket));
    let response = "";
    socket.setTimeout(15_000, () => { socket.destroy(); reject(new Error("Native ingress reply timed out; reconcile before replay")); });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify(packet) + "\n"));
    socket.on("data", chunk => { response += String(chunk); if (response.length > 8192) socket.destroy(); });
    socket.once("end", () => { try { record(JSON.parse(response)).ok === true ? accept() : reject(new Error("Native ingress rejected delivery")); } catch (error) { reject(error); } });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deliverNativeHerdrMessage().catch(() => { process.stderr.write("Bflow native receipt delivery failed; reconcile before retry\n"); process.exitCode = 1; });
}

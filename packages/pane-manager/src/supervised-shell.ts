import { constants } from "node:fs";
import { lstat, open, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OperationResult } from "@bflow/contracts";
import type { AgentLaunchProfile, CommandOutcome, HerdrPaneInfo, HerdrProcessInfo } from "./types.js";
import { isShellReadyForAgent } from "./runner.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** These are Runtime-private scope fields, not a new public launch contract. */
export function supervisedShellProblem(launch: AgentLaunchProfile): string | undefined {
  const id = launch.env.BFLOW_PROCESS_SCOPE_ID;
  if (id === undefined) return undefined;
  if (!UUID.test(id)) return "Invalid supervised process-scope identity";
  const bin = launch.env.PATH?.split(":")[0];
  if (!bin || !isAbsolute(bin) || basename(bin) !== "bin" || basename(dirname(bin)) !== id ||
      launch.env.ZDOTDIR !== join(dirname(bin), "shell"))
    return "Supervised launch requires its private scope bin first in PATH and matching shell directory";
  return undefined;
}

interface Intent {
  version: 1;
  paneId: string;
  terminalId: string;
  shellPid: number;
  startTime: string;
  launchId: string;
  launchFingerprint: string;
  nonce: string;
}

async function privateText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16_384)
      throw new Error("Unsafe supervised shell receipt");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
async function exclusiveText(path: string, value: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value, "utf8"); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function startTime(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const value = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!value || !/^\d+$/.test(value)) throw new Error("Missing shell process identity");
  return value;
}
function parseIntent(raw: string): Intent {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid supervised shell intent");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "launchFingerprint,launchId,nonce,paneId,shellPid,startTime,terminalId,version" ||
      v.version !== 1 || !Number.isSafeInteger(v.shellPid) || Number(v.shellPid) <= 0 ||
      ![v.paneId, v.terminalId, v.launchId, v.launchFingerprint].every(x => typeof x === "string" && x.length > 0) ||
      typeof v.startTime !== "string" || !/^\d+$/.test(v.startTime) || typeof v.nonce !== "string" || !UUID.test(v.nonce))
    throw new Error("Invalid supervised shell intent");
  return v as unknown as Intent;
}

/** A durable one-shot shell replacement; terminal output is never its acknowledgement. */
export async function prepareSupervisedShell(input: {
  launch: AgentLaunchProfile;
  pane: HerdrPaneInfo;
  processes: HerdrProcessInfo;
  timeoutMs: number;
  signal?: AbortSignal;
  run: (args: string[], timeoutMs: number) => Promise<CommandOutcome>;
  observe: () => Promise<{ pane: HerdrPaneInfo; processes: HerdrProcessInfo }>;
}): Promise<OperationResult<void>> {
  const blocked = (message: string): OperationResult<void> => ({ ok: false, error: {
    code: "conflict", retryable: true,
    message: `Supervised provider shell was not confirmed: ${message}. No agent was started; reconcile or replace this pane before retrying.`
  } });
  try {
    const { launch, pane, processes } = input;
    const problem = supervisedShellProblem(launch);
    if (problem) return blocked(problem);
    if (process.platform !== "linux" || !pane.terminalId || !Number.isSafeInteger(processes.shellPid) || !processes.shellPid ||
        !isShellReadyForAgent(pane, processes).ready) return blocked("unsupported or unproven idle shell");
    const shellPid = processes.shellPid;
    const identity = await startTime(shellPid);
    const bin = launch.env.PATH!.split(":")[0]!;
    const root = dirname(bin), directory = join(root, "shell");
    for (const path of [root, bin, directory]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || await realpath(path) !== path)
        return blocked("unsafe private scope directory");
    }
    const wrapper = await lstat(join(bin, launch.provider));
    if (!wrapper.isFile() || wrapper.uid !== process.getuid?.() || (wrapper.mode & 0o077) || !(wrapper.mode & 0o100))
      return blocked("missing private executable scope wrapper");
    const bash = await realpath("/bin/bash");
    const executable = await readlink(`/proc/${shellPid}/exe`);
    if (executable !== bash && executable !== await realpath("/bin/zsh").catch(() => ""))
      return blocked("only Bash and Zsh startup shells are supported");
    const path = join(directory, "pane-bootstrap.json");
    let intent: Intent;
    let fresh = false;
    try { intent = parseIntent(await privateText(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      intent = { version: 1, paneId: pane.paneId, terminalId: pane.terminalId, shellPid, startTime: identity,
        launchId: launch.launchId, launchFingerprint: launch.launchFingerprint, nonce: randomUUID() };
      try { await exclusiveText(path, JSON.stringify(intent)); fresh = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        intent = parseIntent(await privateText(path));
      }
    }
    if (intent.paneId !== pane.paneId || intent.terminalId !== pane.terminalId || intent.shellPid !== shellPid ||
        intent.startTime !== identity || intent.launchId !== launch.launchId || intent.launchFingerprint !== launch.launchFingerprint)
      return blocked("bootstrap intent belongs to a different terminal, process or launch");
    const ack = join(directory, `pane-bootstrap-${intent.nonce}.ack`);
    if (fresh) {
      const rc = join(directory, `pane-bootstrap-${intent.nonce}.bashrc`);
      // Only paths and non-secret scope identity enter this private file. No env/token is typed into the terminal.
      // Clean interactive Bash skips user/system profile hooks, inherited provider functions and hash/alias state.
      await exclusiveText(rc, [
        "builtin set +o history", "builtin unset HISTFILE PROMPT_COMMAND BASH_ENV ENV",
        "builtin unalias -a", `builtin unset -f ${launch.provider}`, "builtin hash -r",
        `if [[ \"\${BFLOW_PROCESS_SCOPE_ID-}\" == ${quote(launch.env.BFLOW_PROCESS_SCOPE_ID!)} ]]; then`,
        `  builtin export PATH=${quote(launch.env.PATH!)}`,
        `  if [[ \"$(builtin type -P ${launch.provider})\" == ${quote(join(bin, launch.provider))} ]]; then`,
        `    builtin umask 077; builtin printf '%s:%s\\n' ${quote(intent.nonce)} \"$$\" > ${quote(ack)}`,
        "  fi", "fi", ""
      ].join("\n"));
      const before = await input.observe();
      if (before.pane.paneId !== pane.paneId || before.pane.terminalId !== pane.terminalId ||
          before.processes.shellPid !== shellPid || !isShellReadyForAgent(before.pane, before.processes).ready ||
          await startTime(shellPid) !== identity) return blocked("terminal or idle shell changed before bootstrap");
      const outcome = await input.run(["pane", "run", pane.paneId, `\\builtin exec ${quote(bash)} --noprofile --rcfile ${quote(rc)} -i`], input.timeoutMs);
      if (outcome.exitCode !== 0 || outcome.failure) return blocked("bootstrap delivery is uncertain; its durable intent forbids replay");
      // `herdr pane run` acknowledges CLI delivery silently (unlike JSON-returning agent commands).
      // Delivery is not execution proof: the private nonce receipt and process checks below remain mandatory.
      if (outcome.stdout !== "" || outcome.stderr !== "") return blocked("bootstrap delivery acknowledgement is uncertain");
    }
    // A nonce acknowledgement binds execution to this exact launch and shell. A prior pending intent is never resent.
    const deadline = Date.now() + Math.min(input.timeoutMs, 3000);
    while (true) {
      if (input.signal?.aborted) return blocked("bootstrap observation interrupted");
      try {
        const receipt = await privateText(ack);
        if (receipt === `${intent.nonce}:${shellPid}\n`) break;
        if (receipt.length > 0) return blocked("bootstrap acknowledgement identity mismatch");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (Date.now() >= deadline) return blocked("bootstrap acknowledgement is missing; its durable intent forbids replay");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const current = await input.observe();
    if (current.pane.paneId !== pane.paneId || current.pane.terminalId !== pane.terminalId ||
        current.processes.shellPid !== shellPid || !isShellReadyForAgent(current.pane, current.processes).ready ||
        await startTime(shellPid) !== identity || await readlink(`/proc/${shellPid}/exe`) !== bash)
      return blocked("terminal or idle shell changed after bootstrap");
    return { ok: true, value: undefined };
  } catch { return blocked("private bootstrap validation or observation failed"); }
}

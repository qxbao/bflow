import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { systemToolHost, type ToolHost } from "./installer.js";
import { atomicJson, fileDigest, noLinksBelow, privateDirectory, readRegular, sha256, withFileLock } from "./files.js";

const providerSchema = z.enum(["claude", "codex", "agy"]);
const snapshotSchema = z.object({ path: z.string(), content: z.string().nullable(), mode: z.number().int().nullable() }).strict();
export const RtkConfigurationPlanSchema = z.object({ schemaVersion: z.literal(3), provider: providerSchema,
  executable: z.string(), executableDigest: z.string(), repositoryRoot: z.string(), stateRoot: z.string(),
  argv: z.array(z.string()), preview: z.string(), snapshots: z.array(snapshotSchema), planDigest: z.string() }).strict();
export type RtkConfigurationPlan = z.infer<typeof RtkConfigurationPlanSchema>;
const receiptSchema = z.object({ schemaVersion: z.literal(3), planDigest: z.string(),
  entries: z.array(snapshotSchema.extend({ afterDigest: z.string().nullable() }).strict()) }).strict();

const files = {
  claude: ["CLAUDE.md", ".rtk/filters.toml", ".claude/settings.json", ".claude/settings.local.json"],
  codex: ["RTK.md", "AGENTS.md", ".codex/hooks.json"],
  agy: [".agents/rules/antigravity-rtk-rules.md", ".agents/plugins/rtk/plugin.json", ".agents/plugins/rtk/hooks.json", ".agents/plugins/rtk/rules/AGENTS.md"]
} as const;

async function snapshot(path: string) {
  try {
    const info = await lstat(path);
    return snapshotSchema.parse({ path, content: await readRegular(path), mode: info.mode & 0o777 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, content: null, mode: null };
    throw error;
  }
}

function hookCommands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(hookCommands);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const commands = typeof object.command === "string" && /(?:^|[\s/"'])rtk(?:[\s"']|$)/.test(object.command) ? [object.command] : [];
  return commands.concat(Object.values(object).flatMap(item => typeof item === "object" ? hookCommands(item) : []));
}

export async function planRtkConfiguration(input: {
  provider: "claude" | "codex" | "agy"; executable: string; repositoryRoot: string; stateRoot: string; host?: ToolHost;
}): Promise<RtkConfigurationPlan> {
  const provider = providerSchema.parse(input.provider);
  const root = await privateDirectory(input.repositoryRoot);
  const stateRoot = await privateDirectory(input.stateRoot);
  const stateSuffix = relative(root, stateRoot);
  if (!(stateSuffix === ".." || stateSuffix.startsWith(`..${sep}`))) throw new Error("RTK recovery state must be outside the agent repository");
  const host = input.host ?? systemToolHost;
  const help = await host.run(input.executable, ["init", "--help"], { timeoutMs: 15_000 });
  const text = help.stdout + help.stderr;
  if (help.exitCode !== 0 || !text.includes("--dry-run") || (provider === "codex" && !text.includes("--codex")) ||
    (provider === "agy" && !text.includes("antigravity"))) throw new Error("Installed RTK does not support this provider's previewable configuration route");
  const argv = ["init", ...(provider === "codex" ? ["--codex"] : provider === "agy" ? ["--agent", "antigravity"] : []),
    ...(provider !== "codex" && text.includes("--no-patch") ? ["--no-patch"] : []), ...(text.includes("--no-trust-filters") ? ["--no-trust-filters"] : [])];
  const preview = await host.run(input.executable, [...argv, "--dry-run"], { cwd: root, timeoutMs: 15_000 });
  if (preview.exitCode !== 0) throw new Error("RTK configuration preview failed");
  const snapshots = await Promise.all(files[provider].map(async file => {
    const path = join(root, file); await noLinksBelow(root, path); return snapshot(path);
  }));
  for (const item of snapshots) if (item.content !== null && item.path.endsWith(".json")) JSON.parse(item.content);
  const body = { schemaVersion: 3 as const, provider, executable: input.executable, executableDigest: await fileDigest(input.executable),
    repositoryRoot: root, stateRoot, argv, preview: preview.stdout + preview.stderr, snapshots };
  return RtkConfigurationPlanSchema.parse({ ...body, planDigest: sha256(JSON.stringify(body)) });
}

export async function applyRtkConfiguration(raw: RtkConfigurationPlan, host: ToolHost = systemToolHost) {
  const plan = RtkConfigurationPlanSchema.parse(raw);
  const { planDigest, ...body } = plan;
  if (sha256(JSON.stringify(body)) !== planDigest) throw new Error("RTK configuration plan changed");
  const current = await planRtkConfiguration({ ...plan, host });
  const receiptPath = join(plan.stateRoot, `rtk-${plan.provider}-${sha256(plan.repositoryRoot)}.json`);
  const intentPath = `${receiptPath}.intent`;
  return withFileLock(`${receiptPath}.lock`, async () => {
    // A matching retained receipt makes repeat setup idempotent even though the original before-state differs.
    try {
      const receipt = receiptSchema.parse(JSON.parse(await readRegular(receiptPath)));
      if (receipt.planDigest === plan.planDigest && (await Promise.all(receipt.entries.map(async entry => {
        const now = await snapshot(entry.path); return (now.content === null ? null : sha256(now.content)) === entry.afterDigest;
      }))).every(Boolean)) return { status: "already_satisfied" as const, receiptPath };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current.planDigest !== plan.planDigest) throw new Error("RTK configuration changed after preview; create a new plan");
    try { await lstat(intentPath); return { status: "unknown" as const, receiptPath: intentPath }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const globalPath = plan.provider === "claude" ? join(homedir(), ".claude", "settings.json") :
      plan.provider === "codex" ? join(homedir(), ".codex", "hooks.json") : join(homedir(), ".gemini", "config", "hooks.json");
    let globalCount = 0;
    try { globalCount = hookCommands(JSON.parse(await readRegular(globalPath))).length; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (globalCount && plan.snapshots.some(item => item.content && item.path.endsWith(".json") && hookCommands(JSON.parse(item.content)).length))
      throw new Error("RTK is already hooked globally and locally; reconcile duplicate registrations first");
    await atomicJson(intentPath, { schemaVersion: 3, planDigest: plan.planDigest, entries: plan.snapshots.map(entry => ({ ...entry, afterDigest: null })) });
    const result = await host.run(plan.executable, plan.argv, { cwd: plan.repositoryRoot, timeoutMs: 30_000 });
    const after = await Promise.all(plan.snapshots.map(entry => snapshot(entry.path)));
    const receipt = { schemaVersion: 3 as const, planDigest: plan.planDigest, entries: plan.snapshots.map((entry, i) => ({
      ...entry, afterDigest: after[i]!.content === null ? null : sha256(after[i]!.content!) })) };
    await atomicJson(receiptPath, receipt);
    await rm(intentPath);
    const localCount = after.filter(item => item.path.endsWith(".json") && item.content).reduce((count, item) =>
      count + hookCommands(JSON.parse(item.content!)).length, 0);
    if (result.exitCode !== 0 || globalCount && localCount) {
      await rollbackRtkConfiguration(receiptPath);
      throw new Error("RTK configuration failed or introduced duplicate hooks; prior files restored");
    }
    const awareness = after.map(item => item.content ?? "").join("\n");
    if (!/rtk/i.test(awareness)) { await rollbackRtkConfiguration(receiptPath); throw new Error("RTK awareness or hooks were not produced"); }
    const version = await host.run(plan.executable, ["--version"], { timeoutMs: 15_000 });
    const gain = await host.run(plan.executable, ["gain"], { timeoutMs: 15_000 });
    if (version.exitCode !== 0 || gain.exitCode !== 0) throw new Error("Configured RTK failed its functional probe");
    return { status: "applied" as const, receiptPath };
  });
}

export async function rollbackRtkConfiguration(receiptPath: string): Promise<void> {
  const receipt = receiptSchema.parse(JSON.parse(await readRegular(receiptPath)));
  for (const entry of receipt.entries) {
    const current = await snapshot(entry.path);
    if ((current.content === null ? null : sha256(current.content)) !== entry.afterDigest) throw new Error("RTK config was edited after setup; rollback would overwrite user changes");
  }
  for (const entry of receipt.entries) {
    if (entry.content === null) await rm(entry.path, { force: true });
    else { await mkdir(dirname(entry.path), { recursive: true, mode: 0o700 }); await writeFile(entry.path, entry.content, { mode: entry.mode ?? 0o600 }); await chmod(entry.path, entry.mode ?? 0o600); }
  }
  await rm(receiptPath);
}

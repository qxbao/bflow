import { describe, expect, it } from "vitest";
import { renderPreview, type SetupPreview } from "@bflow/machine-setup";
import { formatSetupPreview, formatTargetPaths, stripAnsi } from "../src/presentation.js";
import { formatCommandSuccess } from "../src/formatters.js";
import { getHelpText } from "../src/help.js";
import { HIGH_LEVEL_COMMAND_SPECS } from "../src/high-level/index.js";
import { parseCommandArgs } from "../src/high-level/args.js";
import { buildEnvelope, newCommandIdentity, type CommandReport } from "../src/high-level/envelope.js";
import { formatHighLevelHuman } from "../src/high-level/presentation.js";
import type { SetupCommandOutput } from "../src/types.js";
import { parseCliArgs } from "../src/parser.js";

const bundles = Array.from({ length: 32 }, (_, i) => `/home/user/.local/share/bflow/skills-store/bundles/${i.toString(16).padStart(64, "0")}`);
const configFiles = ["setup-gateway.json", "mcp.json", "machine.json"].map(name => `/home/user/.config/bflow/${name}`);
const repoFiles = ["/work/shop/.gitnexus", "/work/shop/.git/info/exclude"];
const preview: SetupPreview = {
  steps: [
    { stepId: "resolve_skills:role-skills", action: "resolve_skills", componentId: "role-skills", summary: "Install pinned role skills",
      targets: bundles, machineWide: true, requiresApproval: true, requiresElevation: false },
    { stepId: "register_mcp:mcp-config", action: "register_mcp", componentId: "mcp-config", summary: "Register MCP services",
      targets: [...configFiles, ...repoFiles], machineWide: true, requiresApproval: true, requiresElevation: true,
      blockedReason: "unsupported_platform", commandPreview: ["service-manager", "register", "--user"] }
  ],
  satisfied: [], needsRepair: [], manual: [{ toolId: "custom-tool", guidance: "Install custom-tool manually; no pinned installer is available." }],
  machineWideChanges: [...bundles.map(path => `resolve_skills:role-skills: ${path}`), ...configFiles.concat(repoFiles).map(path => `register_mcp:mcp-config: ${path}`)]
};

describe("friendly CLI output", () => {
  it("groups the long setup example while retaining scope, file names, manual blockers and confirmation", () => {
    const raw = `${renderPreview(preview)}\n\nApply plan setup-1?`;
    const plain = formatSetupPreview(raw);
    expect(plain).toContain("32 pinned skill bundles");
    expect(plain).toContain("Store: /home/user/.local/share/bflow/skills-store/bundles");
    expect(plain).not.toContain(bundles[0]);
    expect(plain).toContain("requires approval; this account");
    expect(plain).toContain("requires elevation (manual)");
    expect(plain).toContain("unsupported platform");
    expect(plain).toContain("command: service-manager register --user");
    for (const file of configFiles) expect(plain).toContain(file.split("/").at(-1));
    for (const file of repoFiles) expect(plain).toContain(file);
    expect(plain).toContain("Manual action required:");
    expect(plain).toContain(preview.manual[0]!.guidance);
    expect(plain).toContain("bflow setup --plan --json");
    expect(plain).toMatch(/Apply plan setup-1\?$/);
    expect(plain.length).toBeLessThan(raw.length / 2);
    expect(stripAnsi(formatSetupPreview(raw, true))).toBe(plain);
  });

  it("keeps unusual targets, spaces and credentials safe without treating arbitrary paths as bundles", () => {
    const paths = ["/work/my repo/file.txt", "/work/my repo/other.txt", "/other/bundles/not-a-digest", "/work/token=secret-value\u001b[31m"];
    const output = formatTargetPaths(paths).join("\n");
    expect(output).toContain("/work/my repo");
    expect(output).toContain("file.txt");
    expect(output).toContain("other.txt");
    expect(output).toContain("/other/bundles/not-a-digest");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("\u001b[");
    const windows = formatTargetPaths(["C:\\Users\\Test User\\bflow\\machine.json", "C:\\Users\\Test User\\bflow\\mcp.json"]).join("\n");
    expect(windows).toContain("C:\\Users\\Test User\\bflow");
    expect(windows).toContain("machine.json");
  });

  it("preserves literal backslashes in POSIX filenames when grouping target paths", () => {
    const paths = ["/work/my\\config.json", "/work/my\\mcp.json"];
    const grouped = formatTargetPaths(paths).join("\n");
    expect(grouped).toContain("my\\config.json");
    expect(grouped).toContain("my\\mcp.json");
    expect(grouped).not.toContain("- /work/my\n");
  });

  it("does not hide non-skill hash targets under a skill bundle label", () => {
    const path = "/work/bundles/" + "a".repeat(64);
    const text = `Planned steps (1):\n- register_mcp:mcp-config [approval, machine-wide] Configure MCP\n    target: ${path}\nMachine-wide changes:\n- register_mcp:mcp-config: ${path}`;
    expect(formatSetupPreview(text)).toContain(path);
    expect(formatSetupPreview(text)).not.toContain("pinned skill bundle");
    expect(formatTargetPaths([path]).join("\n")).toContain(path);
  });

  it("uses the grouped inventory in setup dry runs and retains every exact target in JSON", () => {
    const output: SetupCommandOutput = {
      mode: "dry_run", machineId: "machine-1", os: "linux", serviceManagerKind: "systemd-user", outcome: "changes_pending",
      plan: { schemaVersion: 3, planId: "setup-1", machineId: "machine-1", revision: 1, planDigest: "a".repeat(64),
        createdAt: "2026-10-19T00:00:00Z", idempotencyKey: "setup-1", steps: [] },
      preview, tools: [], skills: { catalogLoaded: true, skillCount: 32, syncedManifests: 0, storeRoot: "/store" }, diagnostics: []
    };
    expect(formatCommandSuccess("setup", output, false)).toContain("32 pinned skill bundles");
    const json = formatCommandSuccess("setup", output, true, { color: true });
    expect(JSON.parse(json).data.preview).toEqual(preview);
    expect(json).not.toContain("\u001b[");
  });

  const identity = newCommandIdentity("corr-readable");
  const render = (report: CommandReport, color = false) => formatHighLevelHuman(buildEnvelope(
    identity, report, "2026-10-19T00:00:00Z"), color);

  it("keeps approval and reconciliation distinct from success with readable statuses and copyable IDs", () => {
    const report: CommandReport = { command: "skills.sync", outcome: "approval_required", status: "waiting_user", exitCode: 5,
      idempotencyKey: "skills:" + "a".repeat(180), steps: [{ id: "resolve-desired", status: "succeeded" }],
      data: { targets: bundles, machineWide: true } };
    const plain = render(report);
    expect(plain).toContain("approval required [WAIT]");
    expect(plain).toContain("Command status: [WAITING USER]");
    expect(plain).toContain("Correlation ID: corr-readable");
    expect(plain).toContain(`Idempotency key: ${report.idempotencyKey}`);
    expect(plain).toContain("32 pinned skill bundles");
    expect(plain).not.toMatch(/status=|exit=|commandId=|approval_required/);
    expect(plain).toContain("--allow-machine-scope");
    expect(stripAnsi(render(report, true))).toBe(plain);
    expect(render({ ...report, outcome: "reconciliation_required", status: "unknown", exitCode: 7 })).toContain("reconciliation required [WAIT]");
  });

  it("shows backend and tool diagnostics on separate lines and reports empty inventories explicitly", () => {
    const common = { outcome: "not_ready", status: "succeeded", exitCode: 3, steps: [] } as const;
    const tools = render({ ...common, command: "tool.status", data: { tools: [{ toolId: "node", status: "version_mismatch", version: "20", required: true,
      requirement: ">=22", path: "/usr/bin/node", diagnostics: ["Version is too old"], remediation: "Install Node 22" }] } });
    for (const line of ["[VERSION MISMATCH]", "Requirement: >=22", "Path: /usr/bin/node", "Diagnostics: Version is too old", "Next: Install Node 22"]) expect(tools).toContain(line);
    const mcp = render({ ...common, command: "mcp.status", data: { config: { state: "invalid", reason: "Invalid schema" },
      backends: [{ serviceId: "search", state: "unavailable", local: "Executable missing", gateway: "Backend disconnected" }] } });
    for (const line of ["Config issue: Invalid schema", "Local: Executable missing", "Gateway: Backend disconnected"]) expect(mcp).toContain(line);
    expect(render({ ...common, command: "mcp.status", data: { backends: [] } })).toContain("None configured.");
  });

  it("preserves repeated spaces in repository, worktree and executable paths", () => {
    const common = { outcome: "inspected", status: "succeeded", exitCode: 0, steps: [] } as const;
    const root = "/work/my  project";
    expect(render({ ...common, command: "repo.inspect", data: { repository: { root } } })).toContain(`Root: ${root}`);
    expect(render({ ...common, command: "task.implement", data: { worktreePath: root + "/task  one" } })).toContain(`Worktree: ${root}/task  one`);
    expect(render({ ...common, command: "tool.status", data: { tools: [{ toolId: "node", status: "present", path: root + "/bin/node" }] } })).toContain(`Path: ${root}/bin/node`);
  });

  it("lists each high-level command once in global help and gives examples the parser accepts", () => {
    const help = getHelpText();
    const listing = help.slice(0, help.indexOf("Global Options:"));
    for (const spec of HIGH_LEVEL_COMMAND_SPECS) {
      expect(listing.split("\n").filter(line => line.trimStart().startsWith(spec.words.join(" ")))).toHaveLength(1);
    }
    const examples = help.slice(help.indexOf("Examples:")).split("\n").filter(line => line.startsWith("  bflow "));
    for (const example of examples) {
      const words = example.trim().split(/\s+/).slice(1);
      const spec = HIGH_LEVEL_COMMAND_SPECS.find(spec => spec.words.every((word, index) => words[index] === word));
      if (spec) expect(() => parseCommandArgs(spec, words.slice(spec.words.length)), example).not.toThrow();
    }
  });

  it("keeps examples exposed by the legacy help API compatible with its parser", () => {
    for (const topic of ["task implement", "verify", "git prepare", "agent check"] as const) {
      const examples = getHelpText(topic).split("Examples:")[1]!.split("\n").filter(line => line.startsWith("  bflow "));
      for (const example of examples) expect(parseCliArgs(example.trim().split(/\s+/).slice(1)).ok, example).toBe(true);
    }
  });
});

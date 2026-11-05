import { spawn as nodeSpawn } from "node:child_process";
import { realpath as fsRealpath, stat } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import { WebDirectorProfileNameSchema, WebDirectorLaunchOptionsSchema, type WebDirectorLaunchOption, type WebDirectorLaunchOptions } from "@bflow/contracts";
import { createProviderProcessRunner, type ProviderCommandRunner } from "@bflow/agent-providers";
import { findExecutable as machineFindExecutable } from "@bflow/machine-setup";
import { createDirectorProfileAccess, DirectorProfileError, type DirectorProfileAccess, type DirectorProfileSelection } from './director-profiles.js';
import { CLI_EXIT_CODES } from "./types.js";
import {
  DIRECTOR_LAUNCH_PROVIDERS,
  DIRECTOR_START_ARGS,
  defaultIsWsl,
  directorCommandLine,
  directorTerminalInvocation,
  sanitizeDirectorLaunchEnvironment,
  selectDirectorTerminal,
  type DirectorLaunchProvider,
  type DirectorTerminalKind,
  type DirectorTerminalSelection
} from "./director-terminal.js";

export type { DirectorLaunchProvider } from "./director-terminal.js";

const VERSION_TIMEOUT_MS = 3000;
const VERSION_MAX_BYTES = 4096;
const VERSION_CACHE_TTL_MS = 5 * 60_000;
const EARLY_EXIT_WINDOW_MS = 750;
const MANUAL_COMMAND_MAX = 4096;
/** Live-measured start syntax (S6, 2026-11-03); others are source plus local tests only. */
const LIVE_MEASURED: ReadonlySet<DirectorLaunchProvider> = new Set(["claude"]);

export type DirectorLaunchErrorCode =
  | "director_active" | "launch_in_progress" | "launch_cancelled" | "launch_uncertain"
  | "provider_unavailable" | "profile_unavailable" | "skill_missing" | "repository_invalid" | "command_too_long";

export class DirectorLaunchError extends Error {
  constructor(readonly code: DirectorLaunchErrorCode, message: string, readonly manualCommand?: string) {
    super(message);
    this.name = "DirectorLaunchError";
  }
}

/** Repository identity as the Web project registry and `bflow open` know it. */
export interface DirectorLaunchRepository { readonly projectId: string; readonly canonicalPath: string }

export type DirectorSkillState = "current" | "missing" | "modified" | "unknown";
export interface DirectorVersionCacheEntry { readonly key: string; readonly at: number }

export interface DirectorLaunchDeps {
  readonly profileName?: string | undefined;
  readonly profiles?: DirectorProfileAccess | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly pathEntries?: readonly string[] | undefined;
  readonly findExecutable?: ((name: string, pathEntries: readonly string[], platform: NodeJS.Platform) => Promise<string | null>) | undefined;
  /** Bounded `--version` probe only; never a model probe. */
  readonly runner?: ProviderCommandRunner | undefined;
  readonly isWsl?: (() => Promise<boolean>) | undefined;
  readonly findTerminal?: (() => Promise<DirectorTerminalSelection>) | undefined;
  readonly checkSkill?: ((repositoryRoot: string, provider: DirectorLaunchProvider) => Promise<DirectorSkillState>) | undefined;
  readonly realpath?: ((path: string) => Promise<string>) | undefined;
  readonly versionCache?: Map<string, DirectorVersionCacheEntry> | undefined;
  readonly spawn?: typeof nodeSpawn | undefined;
  readonly now?: (() => Date) | undefined;
  readonly earlyExitWindowMs?: number | undefined;
}

/** Private launch plan; the browser never supplies argv, cwd or environment. */
export interface DirectorLaunchPlan {
  readonly profile?: DirectorProfileSelection | undefined;
  readonly provider: DirectorLaunchProvider;
  readonly cwd: string;
  /** Provider argv with an absolute executable, run without a shell. */
  readonly argv: readonly string[];
  readonly manualCommand: string;
  readonly terminal?: { readonly kind: DirectorTerminalKind; readonly executable: string; readonly args: readonly string[] } | undefined;
  readonly terminalUnavailableReason?: string | undefined;
  readonly env: Readonly<Record<string, string>>;
}

export interface DirectorLaunchResult {
  readonly mode: "terminal_opened" | "manual_command";
  readonly manualCommand: string;
  readonly launchedAt: string;
  /** Present for manual_command: why no terminal was opened. */
  readonly reason?: string | undefined;
}

/** Director presence as seen by the caller; `unknown` is a read failure, `host_stopped` means no host is running. */
export type DirectorLaunchPresence = "active" | "waiting" | "absent" | "host_stopped" | "unknown";

const defaultVersionCache = new Map<string, DirectorVersionCacheEntry>();
const inFlight = new Set<string>();

function resolved(deps: DirectorLaunchDeps) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const pathEntries = deps.pathEntries ?? (env.PATH ?? "").split(delimiter).filter(Boolean);
  const findExe = deps.findExecutable ?? machineFindExecutable;
  const find = (name: string) => findExe(name, pathEntries, platform).catch(() => null);
  return {
    platform, env, find, profiles: deps.profiles ?? createDirectorProfileAccess(env,find),
    runner: deps.runner ?? createProviderProcessRunner({ maxOutputBytes: VERSION_MAX_BYTES, defaultTimeoutMs: VERSION_TIMEOUT_MS }),
    findTerminal: deps.findTerminal ?? (() => selectDirectorTerminal({ platform, env, isWsl: deps.isWsl ?? (() => defaultIsWsl(env)), find })),
    checkSkill: deps.checkSkill ?? defaultCheckSkill,
    realpath: deps.realpath ?? fsRealpath,
    cache: deps.versionCache ?? defaultVersionCache,
    now: deps.now ?? (() => new Date())
  };
}

/** Checks only the generated `bflow-start` skill file of the provider against the install receipt content. */
async function defaultCheckSkill(repositoryRoot: string, provider: DirectorLaunchProvider): Promise<DirectorSkillState> {
  try {
    const [{ checkDirectorRepoFiles }, { resolveBflowCommand }] = await Promise.all([import("./director-repo-files.js"), import("./init-director.js")]);
    const checks = await checkDirectorRepoFiles({ repositoryRoot, bflowCommand: await resolveBflowCommand(), providers: [provider] });
    const skill = checks.find(check => check.path.endsWith("/bflow-start/SKILL.md"));
    return skill ? skill.status : "unknown";
  } catch { return "unknown"; }
}

function manualCommandFor(cwd: string, provider: DirectorLaunchProvider): string {
  const command = directorCommandLine(cwd, provider, [provider, ...DIRECTOR_START_ARGS[provider]]);
  if (command.length > MANUAL_COMMAND_MAX) throw new DirectorLaunchError("command_too_long", "Đường dẫn kho quá dài để tạo lệnh mở phiên.");
  return command;
}

async function canonicalRoot(repository: DirectorLaunchRepository, realpath: (path: string) => Promise<string>): Promise<string> {
  let real: string;
  try {
    real = await realpath(repository.canonicalPath);
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch { throw new DirectorLaunchError("repository_invalid", "Không đọc được thư mục kho mã của dự án."); }
  if (real !== repository.canonicalPath) throw new DirectorLaunchError("repository_invalid", "Đường dẫn kho không phải đường dẫn chuẩn của dự án.");
  return real;
}

function skillReason(state: DirectorSkillState): string | undefined {
  if (state === "missing") return "Chưa cài skill /bflow-start trong kho. Chạy `bflow init --update`.";
  if (state === "modified") return "Skill /bflow-start trong kho đã bị sửa tay. Chạy `bflow init --update` nếu nó không chạy đúng.";
  if (state === "unknown") return "Không kiểm tra được skill /bflow-start trong kho.";
  return undefined;
}

async function probeVersion(executable: string, cwd: string, provider: DirectorLaunchProvider, r: ReturnType<typeof resolved>): Promise<string | undefined> {
  let key: string;
  try { const info = await stat(executable); key = `${executable}\0${info.mtimeMs}\0${info.size}`; }
  catch { key = `${executable}\0?`; }
  const cached = r.cache.get(executable);
  const nowMs = r.now().getTime();
  if (cached && cached.key === key && nowMs - cached.at < VERSION_CACHE_TTL_MS) return undefined;
  const outcome = await r.runner.run({ executable, args: ["--version"], cwd, env: sanitizeDirectorLaunchEnvironment(r.env, provider),
    inheritEnvironment: false, timeoutMs: VERSION_TIMEOUT_MS, maxOutputBytes: VERSION_MAX_BYTES });
  if (outcome.failure === "timeout") return `Lệnh \`${provider} --version\` không trả lời trong ${VERSION_TIMEOUT_MS / 1000} giây.`;
  if (!outcome.started || outcome.exitCode !== 0) return `Lệnh \`${provider} --version\` không chạy thành công.`;
  r.cache.set(executable, { key, at: nowMs });
  return undefined;
}

async function inspectProvider(root: string, provider: DirectorLaunchProvider, r: ReturnType<typeof resolved>): Promise<WebDirectorLaunchOption> {
  const manualCommand = manualCommandFor(root, provider);
  const profiles=await r.profiles.list(provider);
  const profileChoices=profiles.length?{profiles}:{};
  const executable = await r.find(provider);
  if (!executable) return { provider, ...profileChoices, state: "unavailable", reason: `Không tìm thấy lệnh \`${provider}\` trên PATH.`, manualCommand };
  const [skill, versionProblem] = await Promise.all([r.checkSkill(root, provider), probeVersion(executable, root, provider, r)]);
  if (skill === "missing") return { provider, ...profileChoices, state: "unavailable", reason: skillReason(skill)!, manualCommand };
  const reason = skillReason(skill) ?? versionProblem
    ?? (LIVE_MEASURED.has(provider) ? undefined : `Cách mở phiên Director bằng ${provider} chưa kiểm trực tiếp (chỉ có kiểm thử cục bộ).`);
  // Installed is never "ready": available only says binary, version and skill checks passed.
  return reason === undefined ? { provider, ...profileChoices, state: "available", manualCommand } : { provider, ...profileChoices, state: "unverified", reason, manualCommand };
}

/** Bounded discovery: PATH lookup, cached `--version` and the repository skill file. No model or login probe. */
export async function inspectDirectorLaunchOptions(repository: DirectorLaunchRepository, deps: DirectorLaunchDeps = {}): Promise<WebDirectorLaunchOptions> {
  const r = resolved(deps);
  const root = await canonicalRoot(repository, r.realpath);
  const [terminal, ...providers] = await Promise.all([r.findTerminal(), ...DIRECTOR_LAUNCH_PROVIDERS.map(p => inspectProvider(root, p, r))]);
  return WebDirectorLaunchOptionsSchema.parse({
    apiVersion: 1, projectId: repository.projectId,
    terminal: terminal.available ? { available: true } : { available: false, reason: terminal.reason },
    providers, observedAt: r.now().toISOString()
  });
}

/** Builds the private plan for one provider; refuses a non-canonical repository, missing binary or missing skill. */
export async function buildDirectorLaunchPlan(repository: DirectorLaunchRepository, provider: DirectorLaunchProvider, deps: DirectorLaunchDeps = {}): Promise<DirectorLaunchPlan> {
  if (!DIRECTOR_LAUNCH_PROVIDERS.includes(provider)) throw new DirectorLaunchError("provider_unavailable", "Nhà cung cấp không hợp lệ.");
  const r = resolved(deps);
  const cwd = await canonicalRoot(repository, r.realpath);
  let manualCommand = manualCommandFor(cwd, provider);
  const executable = await r.find(provider);
  if (!executable) throw new DirectorLaunchError("provider_unavailable", `Không tìm thấy lệnh \`${provider}\` trên PATH.`, manualCommand);
  const skill = await r.checkSkill(cwd, provider);
  if (skill === "missing") throw new DirectorLaunchError("skill_missing", skillReason(skill)!, manualCommand);
  let profile:DirectorProfileSelection|undefined;
  if(deps.profileName!==undefined){
    try{const selected=await r.profiles.select(provider,deps.profileName);profile={...selected,selectors:{...selected.selectors,PATH:[dirname(executable),r.env.PATH??''].filter(Boolean).join(delimiter)}};}
    catch(error){throw new DirectorLaunchError("profile_unavailable",error instanceof DirectorProfileError?error.message:"Không kiểm tra được profile đã chọn.");}
  }
  const argv = profile?[profile.executable,'run',provider,'--name',profile.name,'--',...DIRECTOR_START_ARGS[provider]]:[executable, ...DIRECTOR_START_ARGS[provider]];
  const env = {...sanitizeDirectorLaunchEnvironment(r.env, provider),...profile?.selectors};
  if(profile)manualCommand=directorCommandLine(cwd,provider,['ai-isolator','run',provider,'--name',profile.name,'--',...DIRECTOR_START_ARGS[provider]],{AI_ISOLATOR_HOME:profile.identity.stateRoot});
  if(manualCommand.length>MANUAL_COMMAND_MAX)throw new DirectorLaunchError("command_too_long","Lệnh mở profile quá dài.");
  const selection = await r.findTerminal();
  if (!selection.available) return { provider, ...(profile?{profile}:{}), cwd, argv, manualCommand, env, terminalUnavailableReason: selection.reason };
  const envExecutable = (await r.find("env")) ?? "/usr/bin/env";
  const invocation = directorTerminalInvocation({ selection, cwd, provider, argv, envExecutable, env: r.env, ...(profile?{environmentAssignments:profile.selectors}:{}) });
  if (!invocation.ok) return { provider, ...(profile?{profile}:{}), cwd, argv, manualCommand, env, terminalUnavailableReason: invocation.reason };
  return { provider, ...(profile?{profile}:{}), cwd, argv, manualCommand, env, terminal: { kind: invocation.kind, executable: invocation.executable, args: invocation.args } };
}

/**
 * Refuses to open a second Director next to one that may be alive. `absent`/`host_stopped` do not
 * prove an old CLI process exited; `replaceActive` only allows a new launch and never stops anything.
 */
export function assertDirectorLaunchAllowed(presence: DirectorLaunchPresence, replaceActive: boolean): void {
  if (replaceActive || presence === "absent" || presence === "host_stopped") return;
  const what = presence === "unknown" ? "Không đọc được trạng thái Director hiện tại" : `Director đang ${presence === "active" ? "hoạt động" : "chờ"}`;
  throw new DirectorLaunchError("director_active", `${what}; cần xác nhận mở phiên mới thay thế (replaceActive).`);
}

/**
 * Opens at most one terminal window. `terminal_opened` proves only that the terminal process started
 * and did not fail within a short window; the session is ready only after the Director registers.
 * An early failure after start is `launch_uncertain` and is never retried here.
 */
export async function launchDirectorPlan(plan: DirectorLaunchPlan, options: {
  readonly presence: DirectorLaunchPresence;
  readonly replaceActive?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly deps?: DirectorLaunchDeps | undefined;
}): Promise<DirectorLaunchResult> {
  const deps = options.deps ?? {};
  const now = deps.now ?? (() => new Date());
  assertDirectorLaunchAllowed(options.presence, options.replaceActive ?? false);
  if (options.signal?.aborted) throw new DirectorLaunchError("launch_cancelled", "Đã hủy trước khi mở terminal.");
  if(plan.profile){
    try{
      const current=await resolved(deps).profiles.select(plan.provider,plan.profile.name);
      if(JSON.stringify(current.identity)!==JSON.stringify(plan.profile.identity)||current.executable!==plan.profile.executable)throw new DirectorProfileError('Profile đã đổi sau khi kiểm tra; mở lại lựa chọn trước khi chạy.');
    }catch(error){throw new DirectorLaunchError('profile_unavailable',error instanceof DirectorProfileError?error.message:'Không kiểm tra lại được profile đã chọn.');}
  }
  const terminal = plan.terminal;
  if (!terminal) return { mode: "manual_command", manualCommand: plan.manualCommand, launchedAt: now().toISOString(), reason: plan.terminalUnavailableReason };
  if (inFlight.has(plan.cwd)) throw new DirectorLaunchError("launch_in_progress", "Đang mở một phiên Director cho kho này.");
  inFlight.add(plan.cwd);
  try {
    const outcome = await spawnTerminal(terminal, plan, deps.spawn ?? nodeSpawn, deps.earlyExitWindowMs ?? EARLY_EXIT_WINDOW_MS);
    if (outcome === "not_started") {
      return { mode: "manual_command", manualCommand: plan.manualCommand, launchedAt: now().toISOString(), reason: "Không khởi chạy được trình mở terminal." };
    }
    if (outcome === "uncertain") {
      throw new DirectorLaunchError("launch_uncertain", "Trình mở terminal thoát lỗi ngay sau khi chạy; không rõ cửa sổ đã mở hay chưa. Không tự thử lại.", plan.manualCommand);
    }
    return { mode: "terminal_opened", manualCommand: plan.manualCommand, launchedAt: now().toISOString() };
  } finally { inFlight.delete(plan.cwd); }
}

function spawnTerminal(terminal: NonNullable<DirectorLaunchPlan["terminal"]>, plan: DirectorLaunchPlan, spawn: typeof nodeSpawn,
  windowMs: number): Promise<"opened" | "not_started" | "uncertain"> {
  return new Promise(resolve => {
    let started = false; let settled = false; let timer: NodeJS.Timeout | undefined;
    const settle = (value: "opened" | "not_started" | "uncertain") => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(value); };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawn(terminal.executable, [...terminal.args], { cwd: plan.cwd, env: { ...plan.env }, detached: true, stdio: "ignore", shell: false });
    } catch { settle("not_started"); return; }
    child.on("error", () => settle(started ? "uncertain" : "not_started"));
    child.once("spawn", () => {
      started = true;
      try { child.unref(); } catch {}
      timer = setTimeout(() => settle("opened"), windowMs);
    });
    child.once("exit", (code, signal) => {
      if (!started) { settle("not_started"); return; }
      settle(code === 0 && signal === null ? "opened" : "uncertain");
    });
  });
}

// ---------- bflow open ----------

export interface OpenArgs { readonly provider: DirectorLaunchProvider | undefined; readonly profileName?: string | undefined; readonly replaceActive: boolean; readonly json: boolean; readonly help: boolean }

export const OPEN_HELP = `Cách dùng: bflow open [--provider claude|codex|agy] [--profile NAME] [--replace-active] [--json]

Mở một cửa sổ terminal chạy CLI nhà cung cấp trong kho này với skill /bflow-start (giống nút "Khởi động phiên" trên Web).
Không mở được terminal (SSH, không có màn hình) thì in lệnh để bạn tự chạy. Phiên chỉ sẵn sàng khi Director đăng ký với host;
cửa sổ đã mở chưa chứng minh Director đã chạy. Director Codex/Claude bỏ sandbox/prompt quyền trong riêng phiên được mở;
Codex dùng --no-daemon để tách khỏi daemon chung. Quyền specialist và phê duyệt của Runtime vẫn theo chính sách Bflow.
Lệnh này không cấp token, không cài đặt, không đăng nhập và không sửa cấu hình provider toàn cục.
  --provider        Chọn CLI; mặc định là CLI sẵn sàng đầu tiên (claude, codex, agy)
  --profile NAME    Dùng profile ai-isolator đã có (cần --provider; hỗ trợ Codex/Claude)
  --replace-active  Xác nhận mở phiên mới khi Director hiện tại đang hoạt động/chờ (không dừng tiến trình cũ)
  --json            In một đối tượng JSON`;

export function parseOpenArgs(args: readonly string[]): { ok: true; value: OpenArgs } | { ok: false; message: string } {
  let provider: DirectorLaunchProvider | undefined; let profileName:string|undefined; let replaceActive = false; let json = false; let help = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json" || a === "-j") json = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--replace-active") replaceActive = true;
    else if(a==="--profile"){
      const name=args[++i];if(!name||!WebDirectorProfileNameSchema.safeParse(name).success)return {ok:false,message:"--profile phải là tên profile ai-isolator hợp lệ."};profileName=name;
    }
    else if (a === "--provider") {
      const v = args[++i];
      if (!DIRECTOR_LAUNCH_PROVIDERS.includes(v as DirectorLaunchProvider)) return { ok: false, message: "--provider phải là claude, codex hoặc agy." };
      provider = v as DirectorLaunchProvider;
    } else return { ok: false, message: `Tham số không hợp lệ cho 'bflow open': ${a}` };
  }
  if(profileName!==undefined&&provider===undefined)return {ok:false,message:"--profile cần --provider để chọn đúng loại profile."};
  return { ok: true, value: { provider, ...(profileName?{profileName}:{}), replaceActive, json, help } };
}

export interface DirectorOpenDeps {
  readonly cwd: string;
  readonly identify: (cwd: string) => Promise<{ readonly root: string; readonly projectId: string }>;
  /** Presence from the running host; read failure must be `unknown`, a stopped host `host_stopped`. */
  readonly readPresence: (repository: { readonly root: string; readonly projectId: string }) => Promise<DirectorLaunchPresence>;
  readonly launch: DirectorLaunchDeps;
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

export async function defaultDirectorOpenDeps(cwd: string): Promise<DirectorOpenDeps> {
  return {
    cwd,
    identify: async dir => {
      const [{ identifyRepository }, runtime] = await Promise.all([import("./repository.js"), import("@bflow/runtime")]);
      const repository = await identifyRepository(dir);
      return { root: repository.root, projectId: runtime.interactionProjectId(repository.root) };
    },
    readPresence: async repository => {
      try {
        const { EnvironmentLifecycle } = await import("./environment.js");
        const status = await new EnvironmentLifecycle(repository.root).status();
        if (status.server === "stopped") return "host_stopped";
        if (status.server !== "running") return "unknown";
        const { identifyRepository } = await import("./repository.js");
        const runtime = await import("@bflow/runtime");
        const { sessionName } = await identifyRepository(repository.root);
        const services = await runtime.openLocalDirectorServices({ repositoryPath: repository.root, sessionId: sessionName });
        const view = await services.readDirector(repository.projectId);
        return view.ok ? view.value.snapshot.director.presence : "unknown";
      } catch { return "unknown"; }
    },
    launch: { pathEntries: (await import("./gateway-repositories.js")).resolveSetupPlatform().pathEntries },
    stdout: process.stdout,
    stderr: process.stderr
  };
}

export async function runOpenCommand(args: OpenArgs, deps: DirectorOpenDeps): Promise<number> {
  if (args.help) { deps.stdout.write(`${OPEN_HELP}\n`); return 0; }
  const fail = (code: string, message: string, extra: Record<string, unknown> = {}): number => {
    // JSON results stay on stdout for machine readers; text-mode errors go to stderr like the CLI usage errors.
    if (args.json) deps.stdout.write(`${JSON.stringify({ ok: false, code, message, ...extra })}\n`);
    else deps.stderr.write(`${message}\n`);
    return CLI_EXIT_CODES.RUNTIME_ERROR;
  };
  try {
    const repository = await deps.identify(deps.cwd);
    const project = { projectId: repository.projectId, canonicalPath: repository.root };
    let provider = args.provider;
    if (provider === undefined) {
      const options = await inspectDirectorLaunchOptions(project, deps.launch);
      const pick = options.providers.find(p => p.state === "available") ?? options.providers.find(p => p.state === "unverified");
      if (!pick) return fail("provider_unavailable", `Không có CLI nhà cung cấp nào dùng được:\n${options.providers.map(p => `  ${p.provider}: ${p.reason ?? p.state}`).join("\n")}`);
      provider = pick.provider;
      // An automatically chosen provider that is only `unverified` is a guess: say why before acting on it.
      if (pick.state === "unverified") {
        deps.stderr.write(`Chọn ${pick.provider} dù chưa xác minh được${pick.reason ? `: ${pick.reason.replace(/\.$/, "")}` : ""}. Dùng --provider để chọn rõ.\n`);
      }
    }
    const launchDeps={...deps.launch,...(args.profileName?{profileName:args.profileName}:{})};
    const plan = await buildDirectorLaunchPlan(project, provider, launchDeps);
    const presence = await deps.readPresence(repository);
    const result = await launchDirectorPlan(plan, { presence, replaceActive: args.replaceActive, deps: launchDeps });
    if (args.json) deps.stdout.write(`${JSON.stringify({ ok: true, provider, ...(plan.profile?{profileName:plan.profile.name}:{}), ...result })}\n`);
    else if (result.mode === "terminal_opened") {
      deps.stdout.write(`Đã mở cửa sổ terminal chạy ${provider} với /bflow-start. Phiên chỉ sẵn sàng khi Director đăng ký; xem \`bflow progress\`.\n`);
    } else {
      deps.stdout.write(`Không mở được cửa sổ terminal${result.reason ? ` (${result.reason.replace(/\.$/, "")})` : ""}. Tự chạy lệnh sau trong terminal:\n\n  ${result.manualCommand}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof DirectorLaunchError) {
      const hint = error.code === "director_active" ? " Thêm --replace-active để xác nhận (tiến trình cũ không bị dừng)."
        : error.code === "launch_uncertain" ? " Kiểm tra màn hình trước khi tự chạy lệnh dưới đây." : "";
      return fail(error.code, `${error.message}${hint}${error.manualCommand && error.code === "launch_uncertain" ? `\n\n  ${error.manualCommand}` : ""}`,
        error.manualCommand ? { manualCommand: error.manualCommand } : {});
    }
    return fail("runtime_error", error instanceof Error ? error.message : String(error));
  }
}

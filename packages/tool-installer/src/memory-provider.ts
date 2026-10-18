import { join } from "node:path";
import { z } from "zod";
import { readRegular, sha256 } from "./files.js";
import type { ToolHost } from "./installer.js";

export type MemoryProviderMode = "auto" | "claude" | "codex" | "host";
export type SelectedMemoryProvider = Exclude<MemoryProviderMode, "auto">;
export interface MemoryProviderSelection { provider: SelectedMemoryProvider; settingsDigest: string }
/** The owner must complete a provider login; setup defers Claude-Mem instead of failing the machine. */
export const SUBSCRIPTION_LOGIN_REQUIRED = "subscription_login_required";
export class SubscriptionLoginRequiredError extends Error {
  readonly ownerAction = SUBSCRIPTION_LOGIN_REQUIRED;
}
/** Subscription discovery reads status/configuration only. It never logs in, refreshes tokens,
 * opens a model session, copies credentials, or falls back to an API key/subscription signup. */
export async function resolveMemoryProvider(options: { provider?: MemoryProviderMode; homeDirectory: string; dataDir: string;
  host: ToolHost; executables?: Partial<Record<"claude" | "codex", string>>;
  environment?: Readonly<Record<string, string>> }): Promise<MemoryProviderSelection> {
  let text = "", settings: Record<string, unknown> = {};
  try { text = await readRegular(join(options.dataDir, "settings.json")); settings = z.record(z.unknown()).parse(JSON.parse(text)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Existing Claude-Mem settings are invalid; inspect them before choosing a provider"); }
  const settingsDigest = sha256(text);
  const requested = z.enum(["auto", "claude", "codex", "host"]).parse(options.provider ?? "auto");
  let selected = requested === "auto" ? null : requested;
  if (!selected && typeof settings.CLAUDE_MEM_PROVIDER === "string" && settings.CLAUDE_MEM_PROVIDER !== "") {
    const saved = settings.CLAUDE_MEM_PROVIDER;
    if (saved === "claude" || saved === "codex") selected = saved;
    else throw Error("Existing Claude-Mem provider settings are preserved. Select an explicit --memory-provider route to approve changing them.");
    if (saved === "claude" && settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD && settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD !== "subscription")
      throw Error("Existing Claude-Mem Claude API/gateway settings are preserved; select --memory-provider claude explicitly to approve subscription use.");
  }
  if (selected === "host") return { provider: "host", settingsDigest };
  const claudeReady = async () => {
    try {
      const result = await options.host.run(options.executables?.claude ?? "claude", ["auth", "status", "--json"], {
        timeoutMs: 15_000, environment: { ...options.environment, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "" } });
      if (result.exitCode !== 0) return false;
      const auth = z.object({ loggedIn: z.boolean(), authMethod: z.string(), apiProvider: z.string().optional() }).passthrough().safeParse(JSON.parse(result.stdout));
      return auth.success && auth.data.loggedIn && ["claude.ai", "oauth"].includes(auth.data.authMethod) &&
        (!auth.data.apiProvider || auth.data.apiProvider === "firstParty");
    } catch { return false; }
  };
  const codexReady = async () => {
    try {
      // Codex login status has no JSON flag. Its structured auth file must establish
      // a file-backed ChatGPT session before the CLI's read-only status can confirm it.
      const codexHome = options.environment?.CODEX_HOME ?? join(options.homeDirectory, ".codex");
      const raw = JSON.parse(await readRegular(join(codexHome, "auth.json")));
      const auth = z.object({ auth_mode: z.literal("chatgpt").optional(), OPENAI_API_KEY: z.union([z.null(), z.literal("")]).optional(),
        tokens: z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), id_token: z.string().min(1) }).passthrough() }).passthrough().safeParse(raw);
      if (!auth.success) return false;
      const segment = auth.data.tokens.access_token.split(".")[1];
      if (segment) { const token = z.object({ exp: z.number().optional() }).passthrough().safeParse(JSON.parse(Buffer.from(segment, "base64url").toString()));
        if (!token.success || (token.data.exp !== undefined && token.data.exp * 1000 <= Date.now())) return false; }
      const result = await options.host.run(options.executables?.codex ?? "codex", ["login", "status"], {
        timeoutMs: 15_000, environment: { ...options.environment, CODEX_HOME: codexHome, OPENAI_API_KEY: "", CODEX_API_KEY: "", CODEX_ACCESS_TOKEN: "" } });
      return result.exitCode === 0 && /logged in using chatgpt/i.test(result.stdout + result.stderr);
    } catch { return false; }
  };
  if (selected === "claude") {
    if (!(await claudeReady())) throw new SubscriptionLoginRequiredError("Claude-Mem requires an existing Claude subscription login. Run claude auth login, then rerun setup; API-key/gateway authentication is not selected automatically.");
    return { provider: "claude", settingsDigest };
  }
  if (selected === "codex") {
    if (!(await codexReady())) throw new SubscriptionLoginRequiredError("Claude-Mem requires a file-backed ChatGPT login. Run codex login, then rerun setup; API-key/keychain-only authentication is not accepted.");
    return { provider: "codex", settingsDigest };
  }
  if (await claudeReady()) return { provider: "claude", settingsDigest };
  if (await codexReady()) return { provider: "codex", settingsDigest };
  throw new SubscriptionLoginRequiredError("Claude-Mem needs an existing subscription login: run claude auth login or codex login, then rerun setup. No host observer, new subscription or API key is created.");
}

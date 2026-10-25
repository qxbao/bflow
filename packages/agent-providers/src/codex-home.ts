import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { CODEX_CONFIG_HOOK_MAX_BYTES } from "./codex-hook-toml.js";

export type CodexInstructionHomeMode = "private" | "native_auth_compatible";

export interface PreparedCodexHome {
  readonly mode: CodexInstructionHomeMode;
  readonly BFLOW_INSTRUCTION_HOME: CodexInstructionHomeMode;
  readonly CODEX_HOME: string;
  readonly HOME: string;
  readonly codexHomeDirectory: string;
  readonly processHomeDirectory: string;
  readonly environment: {
    readonly BFLOW_INSTRUCTION_HOME: CodexInstructionHomeMode;
    readonly CODEX_HOME: string;
    readonly HOME: string;
  };
  readonly configFilePath?: string;
  readonly authFilePath?: string;
  readonly configDigest?: string;
  readonly diagnostic: string;
}

const ALLOWED_TOP_LEVEL_SCALAR_KEYS = [
  "model",
  "review_model",
  "model_provider",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity"
] as const;

const FORBIDDEN_PRIVATE_HOME_ENTRIES = [
  "AGENTS.md",
  "AGENTS.override.md",
  "RTK.md",
  "hooks.json",
  "skills",
  "plugins",
  "auth.json"
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSafeRegularFile(path: string, maxBytes: number): Promise<{
  readonly exists: boolean;
  readonly text?: string;
  readonly error?: string;
}> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || await realpath(path) !== resolve(path)) {
      return { exists: true, error: "not a regular non-symlink file" };
    }
    if (info.size > BigInt(maxBytes)) {
      return { exists: true, error: "exceeds size limit" };
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(maxBytes)) {
        return { exists: true, error: "not a regular bounded file" };
      }
      const buffer = Buffer.alloc(maxBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        total > maxBytes ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      ) {
        return { exists: true, error: "changed during inspection" };
      }
      return { exists: true, text: buffer.toString("utf8", 0, total) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    return { exists: true, error: error instanceof Error ? error.message : String(error) };
  }
}

async function writePrivateRegularFile(path: string, content: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

function sanitizeProviderTable(table: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table)) {
    if (key === "hooks" || key === "plugins" || key === "mcp_servers") continue;
    if (isPlainRecord(value)) {
      sanitized[key] = sanitizeProviderTable(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function buildSanitizedCodexConfig(parsed: Record<string, unknown>): string {
  const sanitized: Record<string, unknown> = {};
  for (const key of ALLOWED_TOP_LEVEL_SCALAR_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  const modelProviders = parsed["model_providers"];
  if (isPlainRecord(modelProviders)) {
    const activeProvider = typeof parsed["model_provider"] === "string" ? parsed["model_provider"].trim() : undefined;
    const sanitizedProviders: Record<string, unknown> = {};
    for (const [providerId, table] of Object.entries(modelProviders)) {
      if (!isPlainRecord(table)) continue;
      if (activeProvider === undefined || providerId === activeProvider) {
        sanitizedProviders[providerId] = sanitizeProviderTable(table);
      }
    }
    if (Object.keys(sanitizedProviders).length > 0) {
      sanitized["model_providers"] = sanitizedProviders;
    }
  }
  return Object.keys(sanitized).length === 0 ? "" : stringify(sanitized);
}

function fallbackCodexHome(
  sourceHome: string,
  sourceProcessHome: string,
  reason: string
): PreparedCodexHome {
  return {
    mode: "native_auth_compatible",
    BFLOW_INSTRUCTION_HOME: "native_auth_compatible",
    CODEX_HOME: sourceHome,
    HOME: sourceProcessHome,
    codexHomeDirectory: sourceHome,
    processHomeDirectory: sourceProcessHome,
    environment: {
      BFLOW_INSTRUCTION_HOME: "native_auth_compatible",
      CODEX_HOME: sourceHome,
      HOME: sourceProcessHome
    },
    diagnostic: `BFLOW_INSTRUCTION_HOME=native_auth_compatible: ${reason}; native HOME and CODEX_HOME are retained and global instruction home is not isolated.`
  };
}

/**
 * Prepares a private Codex instruction home when authentication can be safely isolated without
 * forking rotating OAuth refresh tokens or OS keyring state, or falls back to `native_auth_compatible`.
 */
export async function preparePrivateCodexHome(
  stateDirectory: string,
  sourceHome: string,
  sourceProcessHome?: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<PreparedCodexHome> {
  const resolvedSourceHome = resolve(sourceHome);
  const resolvedSourceProcessHome =
    sourceProcessHome !== undefined && sourceProcessHome.trim().length > 0
      ? resolve(sourceProcessHome)
      : env["HOME"]?.trim()
        ? resolve(env["HOME"].trim())
        : dirname(resolvedSourceHome) || homedir();

  const explicitMode = env["BFLOW_INSTRUCTION_HOME"]?.trim();
  if (explicitMode === "native_auth_compatible") {
    return fallbackCodexHome(
      resolvedSourceHome,
      resolvedSourceProcessHome,
      "explicitly configured via BFLOW_INSTRUCTION_HOME=native_auth_compatible"
    );
  }

  const configRead = await readSafeRegularFile(join(resolvedSourceHome, "config.toml"), CODEX_CONFIG_HOOK_MAX_BYTES);
  let parsedConfig: Record<string, unknown> = {};
  if (configRead.error !== undefined) {
    if (explicitMode !== "private") {
      return fallbackCodexHome(
        resolvedSourceHome,
        resolvedSourceProcessHome,
        `source config.toml cannot be safely inspected (${configRead.error})`
      );
    }
  } else if (configRead.text !== undefined) {
    try {
      const parsed = parse(configRead.text, { unsafeKeyBehaviour: "throw" });
      if (!isPlainRecord(parsed)) throw new Error("root is not a TOML table");
      parsedConfig = parsed;
    } catch {
      if (explicitMode !== "private") {
        return fallbackCodexHome(
          resolvedSourceHome,
          resolvedSourceProcessHome,
          "source config.toml contains malformed TOML"
        );
      }
    }
  }

  const authRead = await readSafeRegularFile(join(resolvedSourceHome, "auth.json"), CODEX_CONFIG_HOOK_MAX_BYTES);
  let parsedAuth: Record<string, unknown> | undefined;
  let authValid = false;
  if (authRead.error === undefined && authRead.text !== undefined) {
    try {
      const parsed = JSON.parse(authRead.text) as unknown;
      if (isPlainRecord(parsed)) {
        parsedAuth = parsed;
        authValid = true;
      }
    } catch {
      authValid = false;
    }
  }

  const modelProvider = typeof parsedConfig["model_provider"] === "string" ? parsedConfig["model_provider"].trim() : undefined;
  const modelProviders = isPlainRecord(parsedConfig["model_providers"]) ? parsedConfig["model_providers"] : undefined;
  const activeProviderTable =
    modelProvider && modelProviders && isPlainRecord(modelProviders[modelProvider])
      ? modelProviders[modelProvider]
      : undefined;
  const activeAuthTable =
    activeProviderTable && isPlainRecord(activeProviderTable["auth"])
      ? activeProviderTable["auth"]
      : undefined;
  const hasProviderAuthCommand =
    typeof activeAuthTable?.["command"] === "string" && activeAuthTable["command"].trim().length > 0;
  const requiresOpenaiAuth = activeProviderTable?.["requires_openai_auth"] !== false;
  const providerEnvKey =
    typeof activeProviderTable?.["env_key"] === "string" ? activeProviderTable["env_key"].trim() : undefined;
  const hasProviderEnvKeyAuth = Boolean(providerEnvKey && env[providerEnvKey]?.trim());
  const hasEnvApiKey = Boolean(
    env["OPENAI_API_KEY"]?.trim() ||
    env["CODEX_API_KEY"]?.trim() ||
    env["CODEX_ACCESS_TOKEN"]?.trim() ||
    hasProviderEnvKeyAuth
  );

  const authMode = typeof parsedAuth?.["auth_mode"] === "string" ? parsedAuth["auth_mode"].trim().toLowerCase() : undefined;
  const tokens = isPlainRecord(parsedAuth?.["tokens"]) ? parsedAuth["tokens"] : undefined;
  const hasRefreshToken = Boolean(
    (typeof tokens?.["refresh_token"] === "string" && tokens["refresh_token"].trim().length > 0) ||
    (typeof parsedAuth?.["refresh_token"] === "string" && parsedAuth["refresh_token"].trim().length > 0)
  );
  const isStaticApiKeyAuthJson =
    authValid &&
    parsedAuth !== undefined &&
    authMode !== "chatgpt" &&
    !hasRefreshToken &&
    (authMode === "apikey" ||
      authMode === "api_key" ||
      (typeof parsedAuth["OPENAI_API_KEY"] === "string" && parsedAuth["OPENAI_API_KEY"].trim().length > 0) ||
      (typeof parsedAuth["api_key"] === "string" && parsedAuth["api_key"].trim().length > 0));

  const canIsolate =
    explicitMode === "private" ||
    hasProviderAuthCommand ||
    !requiresOpenaiAuth ||
    hasEnvApiKey ||
    isStaticApiKeyAuthJson;

  if (!canIsolate) {
    return fallbackCodexHome(
      resolvedSourceHome,
      resolvedSourceProcessHome,
      "active provider requires non-isolatable OpenAI/ChatGPT OAuth or has no isolated credentials"
    );
  }

  const privateCodexHome = join(resolve(stateDirectory), "codex-home");
  const privateProcessHome = join(resolve(stateDirectory), "codex-process-home");
  await mkdir(privateCodexHome, { recursive: true, mode: 0o700 });
  await chmod(privateCodexHome, 0o700);
  await mkdir(privateProcessHome, { recursive: true, mode: 0o700 });
  await chmod(privateProcessHome, 0o700);

  for (const forbidden of FORBIDDEN_PRIVATE_HOME_ENTRIES) {
    await rm(join(privateCodexHome, forbidden), { recursive: true, force: true }).catch(() => undefined);
  }

  const sanitizedConfigText = buildSanitizedCodexConfig(parsedConfig);
  const configFilePath = join(privateCodexHome, "config.toml");
  await writePrivateRegularFile(configFilePath, sanitizedConfigText);
  const configDigest = createHash("sha256").update(sanitizedConfigText, "utf8").digest("hex");

  let authFilePath: string | undefined;
  if (isStaticApiKeyAuthJson && authRead.text !== undefined) {
    authFilePath = join(privateCodexHome, "auth.json");
    await writePrivateRegularFile(authFilePath, authRead.text);
  }

  return {
    mode: "private",
    BFLOW_INSTRUCTION_HOME: "private",
    CODEX_HOME: privateCodexHome,
    HOME: privateProcessHome,
    codexHomeDirectory: privateCodexHome,
    processHomeDirectory: privateProcessHome,
    environment: {
      BFLOW_INSTRUCTION_HOME: "private",
      CODEX_HOME: privateCodexHome,
      HOME: privateProcessHome
    },
    configFilePath,
    ...(authFilePath !== undefined ? { authFilePath } : {}),
    configDigest,
    diagnostic:
      "BFLOW_INSTRUCTION_HOME=private: isolated CODEX_HOME and process HOME prepared with sanitized config.toml (global instructions, hooks, plugins and MCP servers stripped)."
  };
}

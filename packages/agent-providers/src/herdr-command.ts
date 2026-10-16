import {
  type AgentLaunchProfile,
  AgentLaunchProfileSchema,
  IdentifierSchema
} from "@bflow/contracts";
import { buildProviderEnvironment } from "./environment.js";

const AGENT_NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;
const SECRET_TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]+/,
  /Bearer\s+[A-Za-z0-9._~+/-]+/i,
  /\bghp_[A-Za-z0-9]+/,
  /\bAIza[A-Za-z0-9_-]+/,
  /secret:\/\//
];

export interface HerdrAgentStartOptions {
  readonly agentName: string;
  readonly paneId: string;
  readonly timeoutMs?: number;
  readonly mcpEndpoints?: Readonly<Record<string, string>>;
  readonly mcpConfigPath?: string;
  readonly basePath?: string;
  readonly homeDir?: string;
}

export interface HerdrAgentStartCommand {
  readonly executable: "herdr";
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

export function buildHerdrAgentStartCommand(
  profile: AgentLaunchProfile,
  options: HerdrAgentStartOptions
): HerdrAgentStartCommand {
  const validatedProfile = AgentLaunchProfileSchema.parse(profile);

  if (!AGENT_NAME_REGEX.test(options.agentName)) {
    throw new Error(
      `Invalid agentName '${options.agentName}': must match /^[a-z][a-z0-9_-]{0,31}$/`
    );
  }

  const validatedPaneId = IdentifierSchema.parse(options.paneId);

  if (options.timeoutMs !== undefined) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000) {
      throw new Error(
        `Invalid timeoutMs '${options.timeoutMs}': must be an integer between 1 and 300000 ms`
      );
    }
  }

  for (const [index, arg] of validatedProfile.argv.entries()) {
    if (arg.includes("\0")) {
      throw new Error(`Argv at index ${index} contains forbidden NUL byte`);
    }
    if (arg.includes("\n") || arg.includes("\r")) {
      throw new Error(`Argv at index ${index} contains forbidden newline characters (Herdr rejects multiline args)`);
    }
    for (const pattern of SECRET_TOKEN_PATTERNS) {
      if (pattern.test(arg)) {
        throw new Error(`Argv at index ${index} contains forbidden secret token or reference`);
      }
    }
  }

  const args: string[] = [
    "agent",
    "start",
    options.agentName,
    "--kind",
    validatedProfile.environment.provider,
    "--pane",
    validatedPaneId
  ];

  if (options.timeoutMs !== undefined) {
    args.push("--timeout", String(options.timeoutMs));
  }

  args.push("--", ...validatedProfile.argv);

  const env = buildProviderEnvironment(validatedProfile.environment, options);

  return {
    executable: "herdr",
    args,
    env
  };
}

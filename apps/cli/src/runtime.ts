import type { OperationOptions, OperationResult } from "@bflow/contracts";
import {
  openWorkspaceRuntime,
  type ConcreteRuntimeService
} from "@bflow/runtime";
import { loadRepositoryConfig, resolveConfigPath } from "./config.js";
import type { BflowRepositoryConfig } from "./types.js";

export interface ComposeCliRuntimeOptions {
  readonly cwd?: string | undefined;
  readonly configPath?: string | undefined;
  readonly herdrBinary?: string | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly operationOptions?: OperationOptions | undefined;
}

export interface ComposedCliRuntime {
  readonly runtime: ConcreteRuntimeService;
  readonly config: BflowRepositoryConfig;
  readonly configPath: string;
  close(): Promise<void>;
}

export async function composeCliRuntime(
  options?: ComposeCliRuntimeOptions
): Promise<OperationResult<ComposedCliRuntime>> {
  const cwd = options?.cwd ?? process.cwd();
  const resolvedConfigPath = resolveConfigPath(cwd, options?.configPath);

  const configRes = await loadRepositoryConfig(resolvedConfigPath);
  if (!configRes.ok) {
    return configRes;
  }
  const config = configRes.value;

  const handleRes = await openWorkspaceRuntime({
    cwd,
    runtimeId: config.runtimeId,
    storage: config.storage,
    defaultWorkflow: config.defaultWorkflow,
    ...(options?.herdrBinary !== undefined ? { herdrBinary: options.herdrBinary } : {}),
    ...(options?.clock !== undefined ? { clock: options.clock } : {}),
    ...(options?.operationOptions !== undefined
      ? { operationOptions: options.operationOptions }
      : {})
  });

  if (!handleRes.ok) {
    return handleRes;
  }

  return {
    ok: true,
    value: {
      runtime: handleRes.value.runtime,
      config,
      configPath: resolvedConfigPath,
      close: () => handleRes.value.close()
    }
  };
}

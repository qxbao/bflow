import { probeConfiguredProviderModels, RolePreflightSummarySchema } from "@bflow/runtime";
import type { EnvironmentCompositionInput } from "./environment.js";
import { buildHostPlatformOptions, loadHostPlatformContext } from "./platform-options.js";
import type { OperationOptions } from "@bflow/contracts";

/** Reuses Runtime's trusted provider/profile composition; never starts the lifecycle host. */
export async function probeDoctorModels(input: EnvironmentCompositionInput, options?: OperationOptions) {
  const context = await loadHostPlatformContext();
  const platform = await buildHostPlatformOptions(input, { context });
  const results = await probeConfiguredProviderModels({
    platform, workspaceRoot: input.repository.root, sessionId: input.repository.sessionName, environment: input.env
  }, options);
  return results.map(result => RolePreflightSummarySchema.parse(result));
}

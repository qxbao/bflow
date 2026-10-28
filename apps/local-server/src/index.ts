/** W00 composition types only. HTTP/bootstrap/registry implementation belongs to W03. */
export type { LocalWorkspaceServices, UserInteractionClient } from "@bflow/contracts/web";
export interface LocalServerOptions {
  readonly workspaceServices: import("@bflow/contracts/web").LocalWorkspaceServices;
  readonly interactionClient: import("@bflow/contracts/web").UserInteractionClient;
  readonly assetsDirectory: string;
}

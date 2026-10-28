import { fileURLToPath } from "node:url";
/** Static assets are data. Import only @bflow/web/assets in Node composition. */
export function getWebAssetDirectory(): string {
  return fileURLToPath(new URL("../client/", import.meta.url));
}

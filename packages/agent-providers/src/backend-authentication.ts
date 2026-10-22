import { z } from "zod";
import type { OperationOptions } from "@bflow/contracts";
import type { ProviderCommandOutcome } from "./types.js";

const ModelSchema = z.object({ id: z.string().min(1).optional(), slug: z.string().min(1).optional() })
  .passthrough().refine(model => model.id !== undefined || model.slug !== undefined);
const CatalogSchema = z.union([
  z.object({ models: z.array(ModelSchema) }).passthrough(),
  z.object({ data: z.array(ModelSchema) }).passthrough()
]);

/** A catalog GET validates linked-backend access without creating a response or spending inference tokens. */
export async function checkCodexBackendAuthentication(
  backendUrl: string, apiKey: string | undefined, options?: OperationOptions
): Promise<ProviderCommandOutcome> {
  const failed = (message: string): ProviderCommandOutcome => ({ exitCode: 1, started: true, stdout: "", stderr: message });
  const remaining = options?.deadline === undefined ? Infinity : Date.parse(options.deadline) - Date.now();
  const timeout = Math.min(8_000, options?.timeoutMs ?? 8_000, remaining);
  if (!Number.isFinite(timeout) || timeout <= 0) return failed("Linked backend authentication deadline expired");
  const signal = options?.signal === undefined ? AbortSignal.timeout(timeout)
    : AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]);
  try {
    const url = new URL(backendUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return failed("Linked backend authentication URL is invalid");
    const response = await fetch(backendUrl.replace(/\/+$/, "") + "/models", {
      method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", "x-openai-actor-authorization": "codex-lb",
        ...(apiKey?.trim() ? { Authorization: `Bearer ${apiKey}` } : {}) }
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failed(`Linked backend authentication failed (HTTP ${response.status}); a non-inference model catalog is required`);
    }
    if (response.body === null) return failed("Linked backend authentication returned no model catalog");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); return failed("Linked backend model catalog exceeded its size limit"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    if (!CatalogSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).success)
      return failed("Linked backend authentication returned an invalid model catalog");
    return { exitCode: 0, started: true, stdout: "Logged in to linked backend; model catalog access verified without inference.", stderr: "" };
  } catch {
    return failed(signal.aborted ? "Linked backend authentication timed out or was cancelled" : "Linked backend authentication could not verify model catalog access");
  }
}

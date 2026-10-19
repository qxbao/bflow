import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** The Gateway daemon rewrites this file every ten seconds while it is healthy (see setup-gateway.ts). */
export const GATEWAY_READY_FILE = "setup-gateway-ready.json";
const MAX_AGE_MS = 60_000;

const ReadyReceiptSchema = z.object({
  schemaVersion: z.literal(3),
  pid: z.number().int().positive(),
  endpoint: z.string().url(),
  observedAt: z.string().datetime(),
  observations: z.array(z.object({
    serviceId: z.string(),
    status: z.string(),
    discoveredTools: z.array(z.string()),
    diagnosticCode: z.string().optional()
  }).passthrough())
}).passthrough();

export interface ServiceReadiness {
  /** `running`: fresh receipt from a live daemon. `stale`: receipt exists but is old or its daemon is gone. `absent`: no receipt. */
  readonly gateway: "running" | "stale" | "absent" | "unreadable";
  /** Status the Gateway reports for the service; `missing` when the Gateway does not list it. */
  readonly status: "ready" | "blocked" | "missing" | "unknown";
  readonly discoveredTools: readonly string[];
  readonly diagnosticCode?: string;
  readonly observedAt?: string;
  readonly ageMs?: number;
  readonly endpoint?: string;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Reads what the running Gateway last reported about one service. Never contacts the service and never throws. */
export async function readGatewayReadiness(stateDirectory: string, serviceId: string, now: () => number = Date.now): Promise<ServiceReadiness> {
  const path = join(stateDirectory, GATEWAY_READY_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) return { gateway: "unreadable", status: "unknown", discoveredTools: [] };
  } catch (error) {
    return { gateway: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable", status: "unknown", discoveredTools: [] };
  }
  let receipt: z.infer<typeof ReadyReceiptSchema>;
  try { receipt = ReadyReceiptSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch { return { gateway: "unreadable", status: "unknown", discoveredTools: [] }; }
  const ageMs = now() - Date.parse(receipt.observedAt);
  const running = ageMs <= MAX_AGE_MS && ageMs >= -1000 && alive(receipt.pid);
  const entry = receipt.observations.find(item => item.serviceId === serviceId);
  const base = { discoveredTools: entry?.discoveredTools ?? [], observedAt: receipt.observedAt, ageMs, endpoint: receipt.endpoint,
    ...(entry?.diagnosticCode ? { diagnosticCode: entry.diagnosticCode } : {}) };
  if (!running) return { gateway: "stale", status: "unknown", ...base };
  if (!entry) return { gateway: "running", status: "missing", ...base };
  return { gateway: "running", status: entry.status === "ready" ? "ready" : "blocked", ...base };
}

import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GatewayMetricsSnapshot, ServiceMetricsSnapshot, UpstreamHttpEvent } from "./types.js";
import { UPSTREAM_HTTP_EVENTS } from "./types.js";

/**
 * Legacy exported name retained for compatibility. Linux uses procfs; macOS uses bounded system ps.
 * Returns 0 when a measurement is unavailable, never a fabricated RSS estimate.
 */
export async function readLinuxProcessRssBytes(pid: number): Promise<number> {
  if (pid <= 0 || !Number.isSafeInteger(pid)) {
    return 0;
  }
  try {
    if (process.platform === "darwin") {
      const { stdout } = await promisify(execFile)("/bin/ps", ["-o", "rss=", "-p", String(pid)],
        { timeout: 1000, maxBuffer: 1024, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
      const kib = /^\s*\d+\s*$/.test(stdout) ? Number(stdout.trim()) : NaN;
      return Number.isSafeInteger(kib * 1024) ? kib * 1024 : 0;
    }
    const status = await fs.promises.readFile(`/proc/${pid}/status`, "utf8");
    const match = status.match(/VmRSS:\s+(\d+)\s+kB/i);
    if (match && match[1]) {
      return parseInt(match[1], 10) * 1024;
    }
    const statm = await fs.promises.readFile(`/proc/${pid}/statm`, "utf8");
    const parts = statm.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1]) {
      return parseInt(parts[1], 10) * 4096;
    }
  } catch {
    return 0;
  }
  return 0;
}

interface MutableServiceMetrics {
  serviceId: string;
  activeInstances: Set<string>;
  activeProcesses: Set<number>;
  instanceMemory: Map<string, number>;
  activeClients: number;
  activeCalls: number;
  queuedCalls: number;
  totalCalls: number;
  failedCalls: number;
  timedOutCalls: number;
  cancelledCalls: number;
  unknownCalls: number;
  backpressureRejections: number;
  restartCount: number;
  latencies: number[];
  upstreamHttp: Map<UpstreamHttpEvent, number>;
}

export interface GatewayMetricsCollectorOptions {
  readonly maxProcessCount?: number;
  readonly maxMemoryBytes?: number;
}

function computeLatencyStats(latencies: readonly number[]): {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
} {
  const count = latencies.length;
  if (count === 0) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += sorted[i]!;
  }

  const minMs = sorted[0]!;
  const maxMs = sorted[count - 1]!;
  const avgMs = Math.round((sum / count) * 100) / 100;
  const p50Ms = sorted[Math.min(Math.floor(0.5 * count), count - 1)]!;
  const p95Ms = sorted[Math.min(Math.floor(0.95 * count), count - 1)]!;
  const p99Ms = sorted[Math.min(Math.floor(0.99 * count), count - 1)]!;

  return {
    count,
    minMs,
    maxMs,
    avgMs,
    p50Ms,
    p95Ms,
    p99Ms
  };
}

/**
 * Collects runtime operational metrics for the Gateway, tracking processes,
 * client connections, queues, tool calls, latencies, and memory consumption.
 */
export class GatewayMetricsCollector {
  readonly maxProcessCount: number;
  readonly maxMemoryBytes: number;

  private processLimitRejections = 0;
  private memoryLimitTerminations = 0;
  private activeClientConnections = 0;
  private activeSessions = 0;
  private activeToolCalls = 0;
  private queuedToolCalls = 0;
  private backpressureRejections = 0;
  private totalToolCalls = 0;
  private failedToolCalls = 0;
  private timedOutToolCalls = 0;
  private cancelledToolCalls = 0;
  private unknownToolCalls = 0;
  private readonly latencies: number[] = [];

  private readonly services = new Map<string, MutableServiceMetrics>();
  private readonly instanceToPid = new Map<string, number>();

  constructor(options?: GatewayMetricsCollectorOptions) {
    this.maxProcessCount = options?.maxProcessCount ?? 64;
    this.maxMemoryBytes = options?.maxMemoryBytes ?? 4 * 1024 * 1024 * 1024;
  }

  private getOrCreateService(serviceId: string): MutableServiceMetrics {
    let service = this.services.get(serviceId);
    if (!service) {
      service = {
        serviceId,
        activeInstances: new Set(),
        activeProcesses: new Set(),
        instanceMemory: new Map(),
        activeClients: 0,
        activeCalls: 0,
        queuedCalls: 0,
        totalCalls: 0,
        failedCalls: 0,
        timedOutCalls: 0,
        cancelledCalls: 0,
        unknownCalls: 0,
        backpressureRejections: 0,
        restartCount: 0,
        latencies: [],
        upstreamHttp: new Map()
      };
      this.services.set(serviceId, service);
    }
    return service;
  }

  canSpawnProcess(_serviceId?: string): boolean {
    let currentProcessCount = 0;
    for (const s of this.services.values()) {
      currentProcessCount +=
        s.activeProcesses.size > 0 ? s.activeProcesses.size : s.activeInstances.size;
    }
    if (currentProcessCount >= this.maxProcessCount) {
      this.processLimitRejections++;
      return false;
    }
    return true;
  }

  recordProcessStart(serviceId: string, instanceId: string, pid?: number): void {
    const service = this.getOrCreateService(serviceId);
    service.activeInstances.add(instanceId);
    if (pid !== undefined && pid > 0) {
      service.activeProcesses.add(pid);
      this.instanceToPid.set(instanceId, pid);
    }
  }

  recordProcessStop(serviceId: string, instanceId: string): void {
    const service = this.services.get(serviceId);
    if (service) {
      service.activeInstances.delete(instanceId);
      const pid = this.instanceToPid.get(instanceId);
      if (pid !== undefined) {
        service.activeProcesses.delete(pid);
        this.instanceToPid.delete(instanceId);
      }
      service.instanceMemory.delete(instanceId);
    }
  }

  updateProcessMemory(serviceId: string, instanceId: string, rssBytes: number): void {
    const service = this.getOrCreateService(serviceId);
    service.instanceMemory.set(instanceId, Math.max(0, rssBytes));
  }

  recordClientConnect(serviceId?: string): void {
    this.activeClientConnections++;
    if (serviceId) {
      const service = this.getOrCreateService(serviceId);
      service.activeClients++;
    }
  }

  recordClientDisconnect(serviceId?: string): void {
    this.activeClientConnections = Math.max(0, this.activeClientConnections - 1);
    if (serviceId) {
      const service = this.services.get(serviceId);
      if (service) {
        service.activeClients = Math.max(0, service.activeClients - 1);
      }
    }
  }

  setActiveSessions(count: number): void {
    this.activeSessions = Math.max(0, count);
  }

  recordQueueEnter(serviceId: string): void {
    this.queuedToolCalls++;
    const service = this.getOrCreateService(serviceId);
    service.queuedCalls++;
  }

  recordQueueExit(serviceId: string): void {
    this.queuedToolCalls = Math.max(0, this.queuedToolCalls - 1);
    const service = this.services.get(serviceId);
    if (service) {
      service.queuedCalls = Math.max(0, service.queuedCalls - 1);
    }
  }

  recordBackpressureRejection(serviceId: string): void {
    this.backpressureRejections++;
    const service = this.getOrCreateService(serviceId);
    service.backpressureRejections++;
  }

  recordCallStart(serviceId: string): void {
    this.activeToolCalls++;
    this.totalToolCalls++;
    const service = this.getOrCreateService(serviceId);
    service.activeCalls++;
    service.totalCalls++;
  }

  recordCallEnd(
    serviceId: string,
    outcome: "completed" | "failed" | "timeout" | "cancelled" | "unknown",
    durationMs: number
  ): void {
    this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
    const service = this.getOrCreateService(serviceId);
    service.activeCalls = Math.max(0, service.activeCalls - 1);

    switch (outcome) {
      case "completed":
        break;
      case "failed":
        this.failedToolCalls++;
        service.failedCalls++;
        break;
      case "timeout":
        this.timedOutToolCalls++;
        service.timedOutCalls++;
        break;
      case "cancelled":
        this.cancelledToolCalls++;
        service.cancelledCalls++;
        break;
      case "unknown":
        this.unknownToolCalls++;
        service.unknownCalls++;
        break;
    }

    const duration = Math.max(0, durationMs);
    this.latencies.push(duration);
    service.latencies.push(duration);
  }

  recordMutatingTimeoutOrCancel(kind: "timeout" | "cancelled", serviceId: string): void {
    const service = this.getOrCreateService(serviceId);
    if (kind === "timeout") {
      this.timedOutToolCalls++;
      service.timedOutCalls++;
    } else {
      this.cancelledToolCalls++;
      service.cancelledCalls++;
    }
  }

  /** Counts one HTTP client event for a remote upstream; see `UpstreamHttpEvent`. */
  recordUpstreamHttp(serviceId: string, event: UpstreamHttpEvent): void {
    const service = this.getOrCreateService(serviceId);
    service.upstreamHttp.set(event, (service.upstreamHttp.get(event) ?? 0) + 1);
  }

  recordRestart(serviceId: string): void {
    const service = this.getOrCreateService(serviceId);
    service.restartCount++;
  }

  recordMemoryLimitTermination(): void {
    this.memoryLimitTerminations++;
  }

  snapshot(): GatewayMetricsSnapshot {
    let totalProcessCount = 0;
    let totalMemoryRssBytes = 0;
    const perService: Record<string, ServiceMetricsSnapshot> = {};

    for (const [serviceId, s] of this.services.entries()) {
      let serviceMemory = 0;
      for (const mem of s.instanceMemory.values()) {
        serviceMemory += mem;
      }
      totalMemoryRssBytes += serviceMemory;
      const processCount =
        s.activeProcesses.size > 0 ? s.activeProcesses.size : s.activeInstances.size;
      totalProcessCount += processCount;

      perService[serviceId] = {
        serviceId,
        activeInstances: s.activeInstances.size,
        activeProcesses: processCount,
        memoryRssBytes: serviceMemory,
        activeClients: s.activeClients,
        activeCalls: s.activeCalls,
        queuedCalls: s.queuedCalls,
        totalCalls: s.totalCalls,
        failedCalls: s.failedCalls,
        timedOutCalls: s.timedOutCalls,
        cancelledCalls: s.cancelledCalls,
        unknownCalls: s.unknownCalls,
        backpressureRejections: s.backpressureRejections,
        restartCount: s.restartCount,
        latency: computeLatencyStats(s.latencies),
        ...(s.upstreamHttp.size > 0
          ? { upstreamHttp: Object.fromEntries(UPSTREAM_HTTP_EVENTS.map(event => [event, s.upstreamHttp.get(event) ?? 0])) as Record<UpstreamHttpEvent, number> }
          : {})
      };
    }

    return {
      activeProcessCount: totalProcessCount,
      maxProcessCount: this.maxProcessCount,
      processLimitRejections: this.processLimitRejections,
      totalMemoryRssBytes,
      maxMemoryBytes: this.maxMemoryBytes,
      memoryLimitTerminations: this.memoryLimitTerminations,
      activeClientConnections: this.activeClientConnections,
      activeSessions: this.activeSessions,
      activeToolCalls: this.activeToolCalls,
      queuedToolCalls: this.queuedToolCalls,
      backpressureRejections: this.backpressureRejections,
      totalToolCalls: this.totalToolCalls,
      failedToolCalls: this.failedToolCalls,
      timedOutToolCalls: this.timedOutToolCalls,
      cancelledToolCalls: this.cancelledToolCalls,
      unknownToolCalls: this.unknownToolCalls,
      latency: computeLatencyStats(this.latencies),
      perService
    };
  }
}

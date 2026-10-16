import { createHash } from "node:crypto";
import {
  type JsonValue,
  type MCPServiceDefinition,
  type OperationResult,
  MCPServiceDefinitionSchema,
  canonicalReceiptJson
} from "@bflow/contracts";
import type {
  MCPBackendSharingPolicy,
  RegisteredMCPServiceEntry
} from "./types.js";
import { err, ok } from "./types.js";
import { checkSchemaVersion } from "./security.js";

/**
 * Computes deterministic SHA-256 digest of service definition using canonical JSON.
 */
export function computeServiceConfigDigest(service: MCPServiceDefinition): string {
  const json = canonicalReceiptJson(service as unknown as JsonValue);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * Creates default sharing policy for an MCP service definition, enforcing appropriate
 * isolation boundaries depending on whether the service is stdio, shared worker, or exclusive.
 */
export function createDefaultSharingPolicy(
  service: MCPServiceDefinition,
  overrides?: Partial<MCPBackendSharingPolicy>
): MCPBackendSharingPolicy {
  let base: MCPBackendSharingPolicy;

  if (service.tool.resource.sharing === "exclusive") {
    base = {
      transportCapabilities: {
        streamableHttp: service.connection.kind !== "stdio_mcp",
        stdio: service.connection.kind === "stdio_mcp",
        supportsCancellation: true,
        maxFrameBytes: 4 * 1024 * 1024
      },
      concurrencyModel: "exclusive_lease",
      sessionIsolationPolicy:
        service.scope.kind === "machine" ? "protocol_session" : "repository_partition",
      sharedStatePolicy: "mutable_shared_exclusive",
      resourceOwnership: "exclusive_lease_bound",
      reconnectBehavior: "quarantine_on_disconnect",
      browserAffecting: true
    };
  } else if (service.connection.kind === "stdio_mcp") {
    base = {
      transportCapabilities: {
        streamableHttp: false,
        stdio: true,
        supportsCancellation: true,
        maxFrameBytes: 4 * 1024 * 1024
      },
      concurrencyModel: "multiplexed",
      sessionIsolationPolicy: "repository_partition",
      sharedStatePolicy: "partitioned_by_repo",
      resourceOwnership: "bflow_managed",
      reconnectBehavior: "reinitialize_session"
    };
  } else if (service.connection.kind === "existing_shared_worker") {
    base = {
      transportCapabilities: {
        streamableHttp: true,
        stdio: false,
        sse: true,
        supportsCancellation: true
      },
      concurrencyModel: "multiplexed",
      sessionIsolationPolicy: "protocol_session",
      sharedStatePolicy:
        service.scope.kind === "machine" ? "stateless" : "partitioned_by_repo",
      resourceOwnership: "external_adopted",
      reconnectBehavior: "stateless_retry"
    };
  } else {
    base = {
      transportCapabilities: {
        streamableHttp: true,
        stdio: false,
        sse: true,
        supportsCancellation: true
      },
      concurrencyModel: "multiplexed",
      sessionIsolationPolicy: "protocol_session",
      sharedStatePolicy:
        service.scope.kind === "machine" ? "stateless" : "partitioned_by_repo",
      resourceOwnership: "external_remote",
      reconnectBehavior: "stateless_retry"
    };
  }

  if (!overrides) {
    return base;
  }

  const mergedCapabilities = overrides.transportCapabilities
    ? { ...base.transportCapabilities, ...overrides.transportCapabilities }
    : base.transportCapabilities;

  const result: MCPBackendSharingPolicy = {
    ...base,
    ...overrides,
    transportCapabilities: mergedCapabilities
  };

  return result;
}

/**
 * In-memory registry for MCP services with revision checking and policy binding.
 */
export class MCPServiceRegistry {
  private readonly services = new Map<string, RegisteredMCPServiceEntry>();

  registerService(
    service: unknown,
    policyOverrides?: Partial<MCPBackendSharingPolicy>
  ): OperationResult<RegisteredMCPServiceEntry> {
    const versionRes = checkSchemaVersion(service);
    if (!versionRes.ok) {
      return err(versionRes.error);
    }

    const parseResult = MCPServiceDefinitionSchema.safeParse(service);
    if (!parseResult.success) {
      return err({
        code: "validation",
        retryable: false,
        message: `Invalid MCPServiceDefinition: ${parseResult.error.message}`,
        details: { issues: parseResult.error.issues } as unknown as JsonValue
      });
    }

    const definition = parseResult.data;
    const configDigest = computeServiceConfigDigest(definition);
    const existing = this.services.get(definition.serviceId);

    if (existing) {
      if (existing.definition.revision === definition.revision) {
        if (existing.configDigest !== configDigest) {
          return err({
            code: "conflict",
            retryable: true,
            message: `Service '${definition.serviceId}' revision ${definition.revision} has conflicting configuration digest`,
            details: {
              existingDigest: existing.configDigest,
              newDigest: configDigest
            } as unknown as JsonValue
          });
        }
        return ok(existing);
      }
      if (definition.revision < existing.definition.revision) {
        return err({
          code: "conflict",
          retryable: true,
          message: `Service '${definition.serviceId}' cannot register older revision ${definition.revision} over current ${existing.definition.revision}`,
          details: {
            currentRevision: existing.definition.revision,
            requestedRevision: definition.revision
          } as unknown as JsonValue
        });
      }
    }

    const policy = createDefaultSharingPolicy(definition, policyOverrides);
    const entry: RegisteredMCPServiceEntry = {
      definition,
      policy,
      configDigest,
      registeredAt: new Date().toISOString()
    };

    this.services.set(definition.serviceId, entry);
    return ok(entry);
  }

  getService(serviceId: string): RegisteredMCPServiceEntry | undefined {
    return this.services.get(serviceId);
  }

  listServices(): readonly RegisteredMCPServiceEntry[] {
    return Array.from(this.services.values());
  }

  unregisterService(serviceId: string): boolean {
    return this.services.delete(serviceId);
  }
}

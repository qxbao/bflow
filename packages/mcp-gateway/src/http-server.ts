import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { MCPToolCall, OperationOptions } from "@bflow/contracts";
import { DEFAULT_MCP_PROTOCOL_VERSION } from "./types.js";
import { computePartitionKey, validateLoopbackHost, validateRequestOrigin } from "./security.js";
import type { BflowSharedMCPGateway } from "./gateway.js";

export interface StreamableHttpGatewayServerOptions {
  readonly gateway: BflowSharedMCPGateway;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly allowNonLoopbackTls?: boolean | undefined;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly maxBodyBytes?: number | undefined;
}

export class StreamableHttpGatewayServer {
  readonly gateway: BflowSharedMCPGateway;
  readonly host: string;
  private port: number;
  readonly allowNonLoopbackTls: boolean;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly maxBodyBytes: number;

  private server?: Server | undefined;
  private readonly inFlightRequests = new Map<string, AbortController>();
  private readonly sockets = new Set<Socket>();

  constructor(options: StreamableHttpGatewayServerOptions) {
    this.gateway = options.gateway;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.allowNonLoopbackTls = options.allowNonLoopbackTls ?? false;
    this.allowedHosts = options.allowedHosts;
    this.allowedOrigins = options.allowedOrigins;
    this.maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
  }

  async start(): Promise<string> {
    if (this.server) {
      return this.getUrl();
    }

    if (
      this.host !== "127.0.0.1" &&
      this.host !== "localhost" &&
      this.host !== "::1" &&
      !this.allowNonLoopbackTls
    ) {
      throw new Error("Binding to non-loopback host requires allowNonLoopbackTls: true");
    }

    return new Promise<string>((resolve, reject) => {
      const srv = createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: err instanceof Error ? err.message : String(err)
                }
              })
            );
          }
        });
      });

      srv.on("connection", socket => {
        this.sockets.add(socket);
        socket.on("close", () => {
          this.sockets.delete(socket);
        });
      });

      srv.on("error", reject);
      srv.listen(this.port, this.host, () => {
        this.server = srv;
        const addr = srv.address();
        if (typeof addr === "object" && addr !== null) {
          this.port = addr.port;
        }
        resolve(this.getUrl());
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const ctrl of this.inFlightRequests.values()) {
      ctrl.abort(new Error("Gateway HTTP server stopping"));
    }
    this.inFlightRequests.clear();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    return new Promise<void>((resolve, reject) => {
      this.server!.close(err => {
        this.server = undefined;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  getUrl(): string {
    const host = this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host;
    return `http://${host}:${this.port}`;
  }

  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let rejected = false;

      const onData = (chunk: Buffer | string) => {
        if (rejected) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.byteLength;
        if (totalBytes > this.maxBodyBytes) {
          rejected = true;
          req.removeListener("data", onData);
          req.resume();
          reject(new Error("payload_too_large"));
          return;
        }
        chunks.push(buf);
      };

      req.on("data", onData);
      req.on("end", () => {
        if (!rejected) {
          resolve(Buffer.concat(chunks).toString("utf8"));
        }
      });
      req.on("error", (err) => {
        if (!rejected) {
          reject(err);
        }
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!validateLoopbackHost(req.headers.host, this.allowedHosts)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Forbidden: invalid host header" }
        })
      );
      return;
    }

    if (!validateRequestOrigin(req.headers.origin, this.allowedOrigins)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Forbidden: invalid origin header" }
        })
      );
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Missing or invalid Authorization header" }
        })
      );
      return;
    }

    const token = authHeader.slice("Bearer ".length).trim();
    const authRes = this.gateway.authenticateToken(token);
    if (!authRes.ok) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: authRes.error.message }
        })
      );
      return;
    }
    const clientReg = authRes.value;

    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase();

    if (pathname === "/health" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
      return;
    }

    if (pathname === "/metrics" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.gateway.getMetrics()));
      return;
    }

    if (pathname === "/mcp") {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId =
        typeof sessionIdHeader === "string" ? sessionIdHeader.trim() : undefined;

      if (sessionId) {
        const existingSession = this.gateway.getSession(sessionId);
        if (existingSession && existingSession.registrationId !== clientReg.registrationId) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Forbidden: session belongs to another client" }
            })
          );
          return;
        }
      }

      if (method === "GET") {
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Missing Mcp-Session-Id header" }
            })
          );
          return;
        }

        const session = this.gateway.getSession(sessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Session not found" }
            })
          );
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        });
        res.write(": keepalive\n\n");

        req.on("close", () => {
          this.gateway.disconnectSession(sessionId);
        });
        return;
      }

      if (method === "DELETE") {
        if (sessionId) {
          this.gateway.disconnectSession(sessionId);
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === "POST") {
        let bodyText: string;
        try {
          bodyText = await this.readRequestBody(req);
        } catch (readErr: any) {
          if (readErr?.message === "payload_too_large") {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32000, message: "Payload Too Large" }
              })
            );
            return;
          }
          throw readErr;
        }

        let body: any;
        try {
          body = JSON.parse(bodyText);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" }
            })
          );
          return;
        }

        const jsonrpcMethod = body?.method;
        const id = body?.id ?? null;

        if (jsonrpcMethod === "initialize") {
          const sessionRes = this.gateway.openSession(clientReg.registrationId);
          if (!sessionRes.ok) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: -32000, message: sessionRes.error.message }
              })
            );
            return;
          }
          const session = sessionRes.value;
          res.setHeader("Mcp-Session-Id", session.sessionId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: "bflow-mcp-gateway", version: "0.1.0" },
                sessionId: session.sessionId
              }
            })
          );
          return;
        }

        if (jsonrpcMethod === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }

        if (jsonrpcMethod === "ping") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
          return;
        }

        if (jsonrpcMethod === "tools/list") {
          const listRes = await this.gateway.listToolsForClient(
            clientReg.registrationId,
            sessionId
          );
          if (!listRes.ok) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: -32000, message: listRes.error.message }
              })
            );
            return;
          }
          // MCP Tool shape: name, title?, description?, inputSchema, outputSchema?, annotations?.
          // definitions are normalized upstream data (only MCP Tool fields); serviceId is a gateway extension.
          const tools = listRes.value.map(t => ({
            ...t.definition,
            name: t.tool,
            serviceId: t.serviceId
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools } }));
          return;
        }

        if (jsonrpcMethod === "tools/call") {
          const params = body?.params as Record<string, unknown> | undefined;
          const toolName = (params?.name ?? params?.tool) as string;
          const toolArgs = (params?.arguments ?? params?.input ?? {}) as any;
          let serviceId = params?.serviceId as string | undefined;

          if (!serviceId) {
            if (clientReg.serviceIds.length > 1 && typeof toolName === "string" && toolName.length > 0) {
              const matchingServices = clientReg.serviceIds.filter(sid => {
                const svc = this.gateway.registry.getService(sid);
                if (!svc) return false;
                if (svc.definition.tool.operations.includes(toolName)) return true;
                const partRes = computePartitionKey(svc.definition, svc.policy, clientReg.scope);
                if (!partRes.ok) return false;
                const part = this.gateway.serviceManager.getPartitionState(partRes.value);
                return part?.discoveredTools.includes(toolName) ?? false;
              });
              if (matchingServices.length > 1) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    error: {
                      code: -32602,
                      message: `Ambiguous tool '${toolName}' across multiple registered services; specify serviceId explicitly`
                    }
                  })
                );
                return;
              }
              serviceId = matchingServices[0] ?? clientReg.serviceIds[0];
            } else {
              serviceId = clientReg.serviceIds[0];
            }
          }

          const callId = (params?.callId as string) ?? `call-${randomUUID()}`;
          const idempotencyKey = (params?.idempotencyKey as string) ?? callId;
          const resourceLease = params?.resourceLease as any;
          const timeoutMs =
            typeof params?.timeoutMs === "number" ? params.timeoutMs : undefined;

          const toolCall: MCPToolCall = {
            schemaVersion: 3,
            callId,
            registrationId: clientReg.registrationId,
            serviceId: serviceId!,
            tool: toolName,
            input: toolArgs,
            ...(resourceLease !== undefined ? { resourceLease } : {}),
            idempotencyKey
          };

          const reqKey = String(id ?? callId);
          const abortCtrl = new AbortController();
          this.inFlightRequests.set(reqKey, abortCtrl);

          const socket = req.socket;
          const onDisconnect = () => {
            if (!res.writableEnded && !res.writableFinished) {
              abortCtrl.abort(new Error("HTTP client disconnected"));
            }
          };
          req.on("aborted", onDisconnect);
          res.on("close", onDisconnect);
          socket?.on("close", onDisconnect);
          if ((res.destroyed || socket?.destroyed) && !res.writableEnded) {
            abortCtrl.abort(new Error("HTTP client disconnected"));
          }

          const callOptions: OperationOptions = {
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            signal: abortCtrl.signal
          };
          let callRes: Awaited<ReturnType<BflowSharedMCPGateway["call"]>>;
          try {
            callRes = await this.gateway.call(toolCall, callOptions);
          } finally {
            this.inFlightRequests.delete(reqKey);
            req.removeListener("aborted", onDisconnect);
            res.removeListener("close", onDisconnect);
            socket?.removeListener("close", onDisconnect);
          }

          if (res.destroyed || res.writableEnded) {
            return;
          }

          const acceptHeader = req.headers.accept ?? "";
          if (acceptHeader.includes("text/event-stream")) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive"
            });
            const payload = {
              jsonrpc: "2.0",
              id,
              result: callRes.ok ? callRes.value : undefined,
              error: !callRes.ok
                ? { code: -32000, message: callRes.error.message, data: callRes.error }
                : undefined
            };
            res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: callRes.ok ? callRes.value : undefined,
                error: !callRes.ok
                  ? { code: -32000, message: callRes.error.message, data: callRes.error }
                  : undefined
              })
            );
          }
          return;
        }

        if (jsonrpcMethod === "notifications/cancelled") {
          const cancelReqId = String(body.params?.requestId ?? "");
          const ctrl = this.inFlightRequests.get(cancelReqId);
          if (ctrl) {
            ctrl.abort();
          }
          res.writeHead(202);
          res.end();
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${jsonrpcMethod}` }
          })
        );
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
}

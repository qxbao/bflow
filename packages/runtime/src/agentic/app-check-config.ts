import { z } from "zod";
import { JsonValueSchema, QualityGateDefinitionSchema, type QualityGateDefinition } from "@bflow/contracts";

/**
 * Owner-configured real-app checks (`appChecks` in `.bflow/verification.json`). The owner names an executable and argv
 * for a web app, a Chrome binary for UI checks and the expected UI/API behavior. Trusted owner input: never accepted
 * from a role message. Each suite becomes one host-app-<suiteId> gate; each check is identified as app:<suite>:<check>.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const FORBIDDEN_ENV = new Set(["PATH", "HOME", "PORT", "HOST", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"]);
const UNSTABLE_SELECTOR_PARTS = [":nth-child", ":nth-of-type", ":nth-last-", ":first-child", ":last-child"];
const IDENTITY = /^app:([A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9][A-Za-z0-9._-]*)$/;
/** Aggregate of all suite timeouts must fit the host's verification deadline (same budget as mutation checks). */
const AGGREGATE_BUDGET_MS = 540_000;
/** Budget reserved for readiness-independent setup and cleanup inside one suite (mirrors the runner allowance). */
const SUITE_ALLOWANCE_MS = 10_000;

const noNul = (value: string) => !value.includes("\0");
const cleanAbsolute = (value: string) => value.startsWith("/") && noNul(value) &&
  value.slice(1).split("/").every(part => part !== "" && part !== "." && part !== "..");
const routePath = z.string().max(2048, "path must be at most 2048 characters")
  .refine(value => value.startsWith("/") && !value.includes("//") && !value.includes("://") && !value.includes("\\") && noNul(value),
    "path must be an origin-relative path starting with / (no scheme, no //, no backslash)");
const absolutePath = (label: string) => z.string().max(4096).refine(cleanAbsolute, `${label} must be an absolute path without traversal segments`);
const safeId = (label: string) => z.string().regex(SAFE_ID, `${label} id must be safe: letters, digits, dot, underscore or hyphen`);
const bounded = (label: string, min: number, max: number) => z.number()
  .int(`${label} must be an integer from ${min} to ${max}`).min(min, `${label} must be an integer from ${min} to ${max}`).max(max, `${label} must be an integer from ${min} to ${max}`);

const EnvSchema = z.record(z.string().max(4096).refine(noNul, "env values must not contain NUL")).superRefine((env, ctx) => {
  for (const key of Object.keys(env)) {
    if (!ENV_KEY.test(key)) ctx.addIssue({ code: "custom", message: `env key ${key} must match ^[A-Z_][A-Z0-9_]*$` });
    else if (FORBIDDEN_ENV.has(key)) ctx.addIssue({ code: "custom", message: `env key ${key} is not allowed: the driver owns it` });
    else if (key.startsWith("BFLOW_")) ctx.addIssue({ code: "custom", message: `env key ${key} is not allowed: BFLOW_ keys are reserved` });
  }
});

const AppSchema = z.object({
  executable: absolutePath("app.executable"),
  args: z.array(z.string().max(4096).refine(noNul, "app.args must not contain NUL")).max(64).default([]),
  port: bounded("app.port", 1024, 65535),
  readyPath: routePath.default("/"),
  startTimeoutMs: bounded("app.startTimeoutMs", 1000, 60000).default(20000),
  env: EnvSchema.default({}),
  dependencyRoots: z.array(absolutePath("dependencyRoots entry").refine(value => value.endsWith("/node_modules"),
    "dependencyRoots must name node_modules directories")).max(16).default([])
}).strict();

const BrowserSchema = z.object({
  executable: absolutePath("browser.executable"),
  resourceKey: safeId("browser.resourceKey").default("app-check-browser")
}).strict();

const ContractSchema = z.object({ kind: z.literal("openapi"), path: routePath }).strict();

const selector = z.string().min(1).max(512, "selector must be at most 512 characters")
  .refine(value => !value.startsWith("/") && !value.startsWith("xpath=") && !UNSTABLE_SELECTOR_PARTS.some(part => value.includes(part)),
    "selector is not a stable locator: positional, XPath and nth-child selectors are rejected");
const visibleText = z.string().min(1).max(512, "expect.text entries must be at most 512 characters");

const UiCheckSchema = z.object({
  id: safeId("check"),
  kind: z.literal("ui"),
  path: routePath,
  viewport: z.object({
    width: bounded("viewport.width", 200, 3840),
    height: bounded("viewport.height", 200, 2160),
    mobile: z.boolean().optional(),
    deviceScaleFactor: z.number().min(1, "viewport.deviceScaleFactor must be 1-3").max(3, "viewport.deviceScaleFactor must be 1-3").optional()
  }).strict(),
  expect: z.object({
    selectors: z.array(selector).max(32).default([]),
    text: z.array(visibleText).max(32).default([])
  }).strict().refine(value => value.selectors.length + value.text.length > 0, "ui check needs at least one selector or text"),
  noHorizontalOverflow: z.boolean().default(false),
  screenshot: z.boolean().default(false),
  timeoutMs: bounded("check timeoutMs", 1000, 60000).default(15000)
}).strict();

const JsonAssertionSchema = z.object({
  pointer: z.string().max(2048).refine(value => value === "" || value.startsWith("/"), "pointer must be an RFC 6901 JSON pointer (empty or starting with /)"),
  equals: JsonValueSchema.optional(),
  exists: z.boolean().optional(),
  type: z.enum(["string", "number", "boolean", "object", "array", "null"]).optional(),
  minItems: z.number().int().min(0).max(100000).optional()
}).strict().superRefine((value, ctx) => {
  const modes = [value.equals !== undefined, value.exists !== undefined, value.type !== undefined].filter(Boolean).length;
  if (modes !== 1) ctx.addIssue({ code: "custom", message: "json assertion needs exactly one of equals, exists or type" });
  if (value.minItems !== undefined && value.type !== "array") ctx.addIssue({ code: "custom", message: "json minItems requires type array" });
});

const headerExpectation = z.object({ equals: z.string().max(4096).optional(), contains: z.string().max(4096).optional() }).strict()
  .refine(value => (value.equals === undefined) !== (value.contains === undefined), "header expectation needs exactly one of equals or contains");

const ApiCheckSchema = z.object({
  id: safeId("check"),
  kind: z.literal("api"),
  request: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
    path: routePath,
    headers: z.record(z.string().max(4096).refine(noNul, "header values must not contain NUL")).default({})
      .superRefine((headers, ctx) => {
        for (const name of Object.keys(headers)) if (!HEADER_NAME.test(name)) ctx.addIssue({ code: "custom", message: `header name ${name} must match ^[A-Za-z0-9-]+$` });
      }),
    body: JsonValueSchema.optional()
  }).strict().superRefine((request, ctx) => {
    if (request.body !== undefined && (request.method === "GET" || request.method === "HEAD")) ctx.addIssue({ code: "custom", message: `${request.method} requests cannot carry a body` });
  }),
  expect: z.object({
    status: bounded("expect.status", 100, 599),
    headers: z.record(headerExpectation).optional().superRefine((headers, ctx) => {
      for (const name of Object.keys(headers ?? {})) if (!HEADER_NAME.test(name)) ctx.addIssue({ code: "custom", message: `header name ${name} must match ^[A-Za-z0-9-]+$` });
    }),
    json: z.array(JsonAssertionSchema).max(64).optional(),
    bodyContains: z.array(z.string().min(1).max(4096)).max(32).optional()
  }).strict().refine(value => (value.json?.length ?? 0) + Object.keys(value.headers ?? {}).length + (value.bodyContains?.length ?? 0) > 0,
    "API check needs a behavioral assertion besides status"),
  timeoutMs: bounded("check timeoutMs", 1000, 60000).default(5000)
}).strict();

const SuiteSchema = z.object({
  id: safeId("suite"),
  app: AppSchema,
  browser: BrowserSchema.optional(),
  contract: ContractSchema.optional(),
  timeoutMs: bounded("suite timeoutMs", 10000, 300000).default(120000),
  checks: z.array(z.unknown()).min(1, "suite needs at least one check").max(50, "suite may configure at most 50 checks")
}).strict();

export type AppCheckUi = z.infer<typeof UiCheckSchema>;
export type AppCheckApi = z.infer<typeof ApiCheckSchema>;
export type AppCheck = AppCheckUi | AppCheckApi;
export type AppCheckSuite = Omit<z.infer<typeof SuiteSchema>, "checks"> & { checks: AppCheck[] };
export type AppCheckJsonAssertion = z.infer<typeof JsonAssertionSchema>;

function parseCheck(raw: unknown): AppCheck {
  const kind = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).kind : undefined;
  if (kind === "ui") return UiCheckSchema.parse(raw);
  if (kind === "api") return ApiCheckSchema.parse(raw);
  throw new Error("check kind must be ui or api");
}

/** Parses owner `appChecks` (absent means none). Rejects unknown keys, unsafe paths/env, weak assertions and budgets. */
export function parseAppChecks(input: unknown): AppCheckSuite[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("appChecks must be an array");
  const suites = input.map((raw): AppCheckSuite => {
    const parsed = SuiteSchema.parse(raw);
    const checks = parsed.checks.map(parseCheck);
    const checkIds = checks.map(check => check.id);
    if (new Set(checkIds).size !== checkIds.length) throw new Error(`Duplicate check identity in suite ${parsed.id}`);
    if (checks.some(check => check.kind === "ui") && parsed.browser === undefined) throw new Error(`browser is required for ui checks in suite ${parsed.id}`);
    if (parsed.browser !== undefined && !checks.some(check => check.kind === "ui")) throw new Error(`browser is only used by ui checks (suite ${parsed.id})`);
    const required = parsed.app.startTimeoutMs + checks.reduce((total, check) => total + check.timeoutMs, 0) + SUITE_ALLOWANCE_MS;
    if (parsed.timeoutMs < required) throw new Error(`suite ${parsed.id} timeoutMs ${parsed.timeoutMs} is below its budget of ${required}`);
    return { ...parsed, checks };
  });
  if (new Set(suites.map(suite => suite.id)).size !== suites.length) throw new Error("Duplicate suite identity in appChecks");
  if (suites.reduce((total, suite) => total + suite.timeoutMs, 0) > AGGREGATE_BUDGET_MS) throw new Error("real-app suites aggregate timeout exceeds the host deadline");
  return suites;
}

export function appCheckIdentity(suiteId: string, checkId: string): string {
  return `app:${suiteId}:${checkId}`;
}

/** Recognizes only `app:<suite>:<check>` names; any other test name is not a real-app identity. */
export function parseAppCheckIdentity(name: string): { suiteId: string; checkId: string } | undefined {
  const match = IDENTITY.exec(name);
  return match ? { suiteId: match[1]!, checkId: match[2]! } : undefined;
}

/**
 * One blocking, e2e-level quality gate per suite. Metadata binds the gate to accepted criteria and the owner test identities,
 * exactly like owner mutation gates; automatic runners never receive these identities (see runtime verificationPlan).
 */
export function appCheckDefinitions(suites: readonly AppCheckSuite[]): QualityGateDefinition[] {
  return suites.map(suite => QualityGateDefinitionSchema.parse({
    id: `host-app-${suite.id}`,
    name: `Real-app checks ${suite.id}`,
    evaluator: "host-app-check",
    required: true,
    timeout: { executionTimeoutMs: suite.timeoutMs + 60_000, onTimeout: "block" },
    metadata: { bindAcceptedCriteria: true, bindMethodTestNames: true, boundRunnerIdentities: true },
    configuration: {
      kind: "deterministic", method: "e2e_test", command: `app:${suite.id}`, criterionIds: [],
      testNames: suite.checks.map(check => appCheckIdentity(suite.id, check.id)), role: "quality_gate", levels: ["e2e"]
    }
  }));
}

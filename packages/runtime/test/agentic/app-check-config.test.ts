import { describe, expect, it } from "vitest";
import { QualityGateDefinitionSchema } from "@bflow/contracts";
import { appCheckDefinitions, appCheckIdentity, parseAppCheckIdentity, parseAppChecks } from "../../src/agentic/app-check-config.js";

const uiCheck = (overrides: Record<string, unknown> = {}) => ({ id: "home", kind: "ui", path: "/",
  viewport: { width: 1280, height: 800 }, expect: { selectors: ["[data-testid=title]"], text: ["Welcome"] }, ...overrides });
const apiCheck = (overrides: Record<string, unknown> = {}) => ({ id: "items-api", kind: "api",
  request: { method: "GET", path: "/api/items" }, expect: { status: 200, json: [{ pointer: "/0/name", equals: "apple" }] }, ...overrides });
const suite = (overrides: Record<string, unknown> = {}) => ({ id: "web",
  app: { executable: "/usr/bin/node", args: ["server.js"], port: 4173, readyPath: "/health", startTimeoutMs: 20000, env: { NODE_ENV: "test" }, dependencyRoots: ["/abs/repo/node_modules"] },
  browser: { executable: "/opt/google/chrome/chrome", resourceKey: "app-check-browser" },
  contract: { kind: "openapi", path: "/openapi.json" }, timeoutMs: 120000,
  checks: [uiCheck(), apiCheck()], ...overrides });
const config = (suites: unknown[] = [suite()]) => ({ schemaVersion: 1, behavioralCommands: [], appChecks: suites });

describe("parseAppChecks", () => {
  it("parses the documented example and applies defaults", () => {
    const [parsed] = parseAppChecks(config().appChecks);
    expect(parsed!.id).toBe("web");
    expect(parsed!.browser).toEqual({ executable: "/opt/google/chrome/chrome", resourceKey: "app-check-browser" });
    expect(parsed!.checks[0]).toMatchObject({ kind: "ui", timeoutMs: 15000, screenshot: false, noHorizontalOverflow: false });
    expect(parsed!.checks[1]).toMatchObject({ kind: "api", timeoutMs: 5000 });
  });
  it("returns [] when absent", () => {
    expect(parseAppChecks(undefined)).toEqual([]);
  });
  it("rejects a non-array root", () => {
    expect(() => parseAppChecks({})).toThrow(/appChecks must be an array/);
  });
  it.each([
    ["unknown suite key", () => suite({ extra: true }), /unrecognized_keys|Unrecognized key/i],
    ["unknown app key", () => suite({ app: { ...suite().app, shell: "sh" } }), /Unrecognized key/i],
    ["unknown check key", () => suite({ checks: [uiCheck({ click: "#x" })] }), /Unrecognized key/i],
    ["relative executable", () => suite({ app: { ...suite().app, executable: "node" } }), /absolute path/],
    ["relative browser executable", () => suite({ browser: { executable: "chrome" } }), /absolute path/],
    ["dependency root not node_modules", () => suite({ app: { ...suite().app, dependencyRoots: ["/abs/repo/src"] } }), /node_modules/],
    ["dependency root with traversal", () => suite({ app: { ...suite().app, dependencyRoots: ["/abs/../node_modules"] } }), /absolute path/],
    ["forbidden env key PATH", () => suite({ app: { ...suite().app, env: { PATH: "/tmp" } } }), /not allowed/],
    ["forbidden env key NODE_OPTIONS", () => suite({ app: { ...suite().app, env: { NODE_OPTIONS: "--require x" } } }), /not allowed/],
    ["forbidden env key PORT", () => suite({ app: { ...suite().app, env: { PORT: "1" } } }), /not allowed/],
    ["BFLOW_ env key", () => suite({ app: { ...suite().app, env: { BFLOW_TOKEN: "x" } } }), /BFLOW_/],
    ["lowercase env key", () => suite({ app: { ...suite().app, env: { node_env: "test" } } }), /env key/],
    ["port below 1024", () => suite({ app: { ...suite().app, port: 80 } }), /port/],
    ["readyPath without slash", () => suite({ app: { ...suite().app, readyPath: "health" } }), /path/],
    ["path with scheme", () => suite({ checks: [uiCheck({ path: "http://evil/" })] }), /path/],
    ["path with double slash", () => suite({ checks: [uiCheck({ path: "//evil/" })] }), /path/],
    ["ui without browser", () => suite({ browser: undefined }), /browser is required for ui checks/],
    ["browser without ui checks", () => suite({ checks: [apiCheck()] }), /browser is only used by ui checks/],
    ["bad resourceKey", () => suite({ browser: { executable: "/opt/google/chrome/chrome", resourceKey: "bad key" } }), /id must be safe/],
    ["ui check timeout below 1000", () => suite({ checks: [uiCheck({ timeoutMs: 999 })] }), /timeoutMs/],
    ["startTimeout above 60000", () => suite({ app: { ...suite().app, startTimeoutMs: 60001 } }), /startTimeoutMs/],
    ["suite budget too small", () => suite({ timeoutMs: 10000, app: { ...suite().app, startTimeoutMs: 20000 } }), /budget/],
    ["duplicate check ids", () => suite({ checks: [uiCheck(), uiCheck()] }), /Duplicate check/],
    ["unsafe suite id", () => suite({ id: "../web" }), /id must be safe/],
    ["ui viewport too narrow", () => suite({ checks: [uiCheck({ viewport: { width: 100, height: 800 } })] }), /viewport/],
    ["selector nth-child", () => suite({ checks: [uiCheck({ expect: { selectors: ["li:nth-child(2)"], text: [] } })] }), /stable locator/],
    ["selector nth-of-type", () => suite({ checks: [uiCheck({ expect: { selectors: ["p:nth-of-type(1)"], text: [] } })] }), /stable locator/],
    ["selector nth-last", () => suite({ checks: [uiCheck({ expect: { selectors: ["p:nth-last-child(1)"], text: [] } })] }), /stable locator/],
    ["selector first-child", () => suite({ checks: [uiCheck({ expect: { selectors: ["p:first-child"], text: [] } })] }), /stable locator/],
    ["selector last-child", () => suite({ checks: [uiCheck({ expect: { selectors: ["p:last-child"], text: [] } })] }), /stable locator/],
    ["xpath selector", () => suite({ checks: [uiCheck({ expect: { selectors: ["xpath=//div"], text: [] } })] }), /stable locator/],
    ["absolute xpath selector", () => suite({ checks: [uiCheck({ expect: { selectors: ["//div"], text: [] } })] }), /stable locator/],
    ["ui check without expectations", () => suite({ checks: [uiCheck({ expect: { selectors: [], text: [] } })] }), /at least one selector or text/],
    ["oversized selector", () => suite({ checks: [uiCheck({ expect: { selectors: ["a".repeat(513)], text: [] } })] }), /512/],
    ["api status only", () => suite({ checks: [apiCheck({ expect: { status: 200 } })] }), /behavioral assertion besides status/],
    ["api bad method", () => suite({ checks: [apiCheck({ request: { method: "TRACE", path: "/api/items" } })] }), /method/],
    ["api GET with body", () => suite({ checks: [apiCheck({ request: { method: "GET", path: "/api/items", body: { a: 1 } } })] }), /body/],
    ["api bad status", () => suite({ checks: [apiCheck({ expect: { status: 99, json: [{ pointer: "", type: "array" }] } })] }), /status/],
    ["api bad header name", () => suite({ checks: [apiCheck({ request: { method: "GET", path: "/api/items", headers: { "x y": "1" } } })] }), /header/],
    ["api bad response header name", () => suite({ checks: [apiCheck({ expect: { status: 200, headers: { "content type": { contains: "json" } } } })] }), /header name/],
    ["api header expectation with two modes", () => suite({ checks: [apiCheck({ expect: { status: 200, headers: { "content-type": { equals: "a", contains: "a" } } } })] }), /exactly one of equals or contains/],
    ["json pointer without slash", () => suite({ checks: [apiCheck({ expect: { status: 200, json: [{ pointer: "name", equals: "x" }] } })] }), /pointer/],
    ["json assertion with two modes", () => suite({ checks: [apiCheck({ expect: { status: 200, json: [{ pointer: "", equals: 1, exists: true }] } })] }), /exactly one of equals/],
    ["minItems without array type", () => suite({ checks: [apiCheck({ expect: { status: 200, json: [{ pointer: "/a", type: "string", minItems: 1 }] } })] }), /minItems/],
    ["contract of unknown kind", () => suite({ contract: { kind: "graphql", path: "/g" } }), /kind/],
    ["zero checks", () => suite({ checks: [] }), /at least one check/],
  ])("rejects %s", (_label, build, pattern) => {
    expect(() => parseAppChecks([build()])).toThrow(pattern);
  });
  it("rejects duplicate suite ids", () => {
    expect(() => parseAppChecks([suite(), suite()])).toThrow(/Duplicate suite/);
  });
  it("rejects suites whose aggregate timeout exceeds the host deadline", () => {
    expect(() => parseAppChecks(Array.from({ length: 5 }, (_, index) => suite({ id: `s${index}`, timeoutMs: 120000 })))).toThrow(/aggregate/);
  });
});

describe("app check identities", () => {
  it("round-trips identity names", () => {
    expect(appCheckIdentity("web", "items-api")).toBe("app:web:items-api");
    expect(parseAppCheckIdentity("app:web:items-api")).toEqual({ suiteId: "web", checkId: "items-api" });
    expect(parseAppCheckIdentity("tests/bucket.test.cjs > ac-1")).toBeUndefined();
    expect(parseAppCheckIdentity("app:web")).toBeUndefined();
  });
});

describe("appCheckDefinitions", () => {
  it("builds one blocking e2e quality gate per suite with binding metadata and identities", () => {
    const parsed = parseAppChecks(config().appChecks);
    const [definition] = appCheckDefinitions(parsed);
    expect(definition).toEqual(QualityGateDefinitionSchema.parse(definition));
    expect(definition).toMatchObject({
      id: "host-app-web", name: "Real-app checks web", evaluator: "host-app-check", required: true,
      timeout: { executionTimeoutMs: 120000 + 60000, onTimeout: "block" },
      metadata: { bindAcceptedCriteria: true, bindMethodTestNames: true, boundRunnerIdentities: true },
      configuration: { kind: "deterministic", method: "e2e_test", command: "app:web", criterionIds: [],
        testNames: ["app:web:home", "app:web:items-api"], role: "quality_gate", levels: ["e2e"] }
    });
  });
  it("returns [] for no suites", () => {
    expect(appCheckDefinitions([])).toEqual([]);
  });
});

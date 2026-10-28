import type { JsonValue } from "@bflow/contracts";
import type { QaAction, QaIntake, QaStep } from "./model.js";

/** Raised for any action outside the approved target, workspace or role authority. Recorded as a denial, never bypassed. */
export class QaScopeDenied extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "QaScopeDenied"; }
}

/** The action a step performs; HTTP authority follows the method, never the declared intent of the test. */
export function actionOf(step: QaStep): QaAction {
  if (step.kind === "http") return step.method === "GET" || step.method === "HEAD" ? "http_read" : "http_mutate";
  return step.op === "click" || step.op === "fill" ? "browser_interact" : "browser_navigate";
}

const PLACEHOLDER = /\$\{([A-Za-z][A-Za-z0-9_]*)\}/g;

export function placeholders(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === "string") for (const match of item.matchAll(PLACEHOLDER)) names.add(match[1]!);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
  return [...names];
}

export class QaUnresolvedVariable extends Error {
  constructor(readonly variable: string) { super(`Unresolved test variable \${${variable}}`); this.name = "QaUnresolvedVariable"; }
}

/** Substitutes `${name}` in every string of a JSON value; an unknown name is an error, never an empty string. */
export function substitute<T extends JsonValue | undefined>(value: T, vars: Readonly<Record<string, string>>): T {
  if (typeof value === "string") return value.replace(PLACEHOLDER, (_all, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new QaUnresolvedVariable(name);
    return vars[name]!;
  }) as T;
  if (Array.isArray(value)) return value.map(item => substitute(item, vars)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, vars)])) as T;
  return value;
}

/**
 * Resolves a test URL against the approved origins. Origin-relative paths use the primary origin; absolute URLs must
 * match an approved origin exactly. Placeholders are substituted first, so a variable can never move the request elsewhere.
 */
export function resolveTargetUrl(raw: string, intake: QaIntake, vars: Readonly<Record<string, string>>): URL {
  const text = substitute(raw, vars);
  let url: URL;
  if (text.startsWith("/") && !text.startsWith("//") && !text.includes("\\")) url = new URL(text, intake.target.origins[0]);
  else {
    try { url = new URL(text); } catch { throw new QaScopeDenied("invalid_url", `Invalid test URL: ${raw}`); }
  }
  assertApprovedOrigin(url, intake);
  if (url.username || url.password) throw new QaScopeDenied("invalid_url", "Test URLs cannot carry credentials");
  return url;
}

export function assertApprovedOrigin(url: URL, intake: QaIntake): void {
  if (!intake.target.origins.includes(url.origin))
    throw new QaScopeDenied("origin_not_approved", `Origin ${url.origin} is not an approved target origin`);
}

/** Design-time check of a URL shape: placeholders are replaced with a neutral token that cannot form an origin. */
export function checkDesignUrl(raw: string, intake: QaIntake): { ok: true } | { ok: false; code: "origin_not_approved" | "invalid_url"; message: string } {
  const probe = raw.replace(PLACEHOLDER, "x");
  const hostPart = /^[a-z]+:\/\/[^/]*/i.exec(raw)?.[0];
  if (hostPart?.includes("${")) return { ok: false, code: "invalid_url", message: "Placeholders cannot select the origin" };
  try {
    resolveTargetUrl(probe, intake, {});
    return { ok: true };
  } catch (error) {
    if (error instanceof QaScopeDenied) return { ok: false, code: error.code === "origin_not_approved" ? "origin_not_approved" : "invalid_url", message: error.message };
    throw error;
  }
}

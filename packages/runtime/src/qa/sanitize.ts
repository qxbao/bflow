import type { QaIntake } from "./model.js";

const DEFAULT_HEADERS = ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token"];
const DEFAULT_KEYS = ["password", "passwd", "secret", "token", "accesstoken", "refreshtoken", "apikey", "api_key", "authorization", "cookie", "session", "ssn", "creditcard", "cardnumber"];
export const REDACTED = "[REDACTED]";
const TEXT_LIMIT = 4096;

/**
 * Evidence sanitizer of one run. Credential headers and sensitive JSON keys are redacted; every secret value seen
 * (account credentials, redacted fields) is also scrubbed from free text, so later evidence cannot leak it either.
 */
export class QaSanitizer {
  private readonly headers: Set<string>;
  private readonly keys: Set<string>;
  private readonly secrets = new Set<string>();

  constructor(intake: QaIntake) {
    this.headers = new Set([...DEFAULT_HEADERS, ...intake.dataPolicy.redactHeaders.map(item => item.toLowerCase())]);
    this.keys = new Set([...DEFAULT_KEYS, ...intake.dataPolicy.redactKeys.map(item => item.toLowerCase())]);
  }

  addSecret(value: string): void {
    if (value.length >= 4) this.secrets.add(value);
  }

  headersOf(input: Readonly<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(input)) {
      if (this.headers.has(name.toLowerCase())) { this.addSecret(value); out[name] = REDACTED; }
      else out[name] = this.text(value);
    }
    return out;
  }

  json(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map(item => this.json(item));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (this.keys.has(key.toLowerCase())) {
          if (typeof item === "string") this.addSecret(item);
          out[key] = REDACTED;
        } else out[key] = this.json(item);
      }
      return out;
    }
    return value;
  }

  /** Response or request body: JSON is sanitized structurally, other text by secret scrubbing; always bounded. */
  body(text: string): string {
    let result: string;
    try { result = JSON.stringify(this.json(JSON.parse(text))); }
    catch { result = this.text(text); }
    return result.length > TEXT_LIMIT ? `${result.slice(0, TEXT_LIMIT - 3)}...` : result;
  }

  text(value: string): string {
    let out = value;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    return out;
  }

  /** Deep scrub of an already-built evidence document. */
  scrub<T>(value: T): T {
    if (typeof value === "string") return this.text(value) as T;
    if (Array.isArray(value)) return value.map(item => this.scrub(item)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.scrub(item)])) as T;
    return value;
  }
}

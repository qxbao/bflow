export const DEFAULT_REDACTED_PLACEHOLDER = "[REDACTED]";

export interface RedactionOptions {
  readonly placeholder?: string | undefined;
  readonly additionalKeyPatterns?: readonly RegExp[] | undefined;
  readonly additionalValuePatterns?: readonly RegExp[] | undefined;
  readonly customSecrets?: readonly string[] | undefined;
}

/**
 * Whitelist of domain token counters, identifiers, and schema properties
 * that MUST NOT be redacted even if they contain the word "token".
 */
const NON_SECRET_KEYS = new Set([
  "fencingtoken",
  "totaltokens",
  "inputtokens",
  "outputtokens",
  "maxtokens",
  "prompttokens",
  "completiontokens",
  "canceltoken",
  "nextpagetoken",
  "schemaversion"
]);

/**
 * Normalized (lowercased without underscores/hyphens) sensitive key names.
 */
const SENSITIVE_KEY_NAMES = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "clientsecret",
  "sessionsecret",
  "webhooksecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "herdrtoken",
  "githubtoken",
  "gitlabtoken",
  "apikey",
  "openaiapikey",
  "anthropicapikey",
  "geminiapikey",
  "privatekey",
  "signingkey",
  "encryptionkey",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "xapikey",
  "credentials",
  "connectionstring",
  "databaseurl"
]);

/**
 * Suffix/segment sensitive patterns (e.g. user_password, custom_api_key).
 */
const SENSITIVE_KEY_REGEX = /(?:^|[_-])(?:password|passwd|pwd|secret|client_secret|session_secret|webhook_secret|token|access_token|refresh_token|id_token|auth_token|herdr_token|github_token|gitlab_token|api_key|apikey|openai_api_key|anthropic_api_key|gemini_api_key|private_key|privatekey|signing_key|encryption_key|authorization|proxy_authorization|cookie|set_cookie|x_api_key|credentials|connection_string|database_url)(?:$|[_-])/i;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function isWhitelistedKey(key: string): boolean {
  return NON_SECRET_KEYS.has(normalizeKey(key));
}

export function isSensitiveKey(key: string, additionalPatterns?: readonly RegExp[]): boolean {
  if (isWhitelistedKey(key)) {
    return false;
  }
  if (additionalPatterns && additionalPatterns.some((pattern) => pattern.test(key))) {
    return true;
  }
  const normalized = normalizeKey(key);
  if (SENSITIVE_KEY_NAMES.has(normalized)) {
    return true;
  }
  return SENSITIVE_KEY_REGEX.test(key);
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactString(input: string, options?: RedactionOptions): string {
  if (!input) {
    return input;
  }
  const placeholder = options?.placeholder ?? DEFAULT_REDACTED_PLACEHOLDER;
  let result = input;

  // 1. PEM private keys
  result = result.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    placeholder
  );

  // 2. Authorization header values
  result = result.replace(/\b(Bearer\s+)[^\s,;'"]+/gi, `$1${placeholder}`);
  result = result.replace(/\b(Basic\s+)[^\s,;'"]+/gi, `$1${placeholder}`);
  result = result.replace(
    /\b(Authorization\s*:\s*)(?!Bearer\b|Basic\b)[^\s,;'"]+/gi,
    `$1${placeholder}`
  );

  // 3. URL user:password credentials
  result = result.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\\@\s]*:)([^@\s/]+)(@)/g,
    `$1${placeholder}$3`
  );

  // 4. Known token prefixes
  // sk-..., ghp_..., gho_..., ghs_..., github_pat_..., xox[baprs]-..., AIza..., JWT
  result = result.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, placeholder);
  result = result.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, placeholder);
  result = result.replace(/\bgho_[A-Za-z0-9]{20,}\b/g, placeholder);
  result = result.replace(/\bghs_[A-Za-z0-9]{20,}\b/g, placeholder);
  result = result.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, placeholder);
  result = result.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, placeholder);
  result = result.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, placeholder);
  result = result.replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, placeholder);

  // 5. Query / CLI / env assignments like --token=..., --api-key=..., OPENAI_API_KEY=..., HERDR_TOKEN=..., password=...
  result = result.replace(
    /((?:--|-)?)(\b[a-zA-Z0-9_-]+)\s*(=)\s*("[^"]*"|'[^']*'|[^\s&"'>]+)/g,
    (fullMatch, prefix: string, keyMatch: string, sep: string, valMatch: string) => {
      if (isWhitelistedKey(keyMatch)) {
        return fullMatch;
      }
      if (isSensitiveKey(keyMatch, options?.additionalKeyPatterns)) {
        const hasQuotes =
          (valMatch.startsWith('"') && valMatch.endsWith('"')) ||
          (valMatch.startsWith("'") && valMatch.endsWith("'"));
        const quotedPlaceholder = hasQuotes
          ? `${valMatch[0]}${placeholder}${valMatch[valMatch.length - 1]}`
          : placeholder;
        return `${prefix}${keyMatch}${sep}${quotedPlaceholder}`;
      }
      return fullMatch;
    }
  );

  // JSON key assignments: "password": "..."
  result = result.replace(
    /"([a-zA-Z0-9_-]+)"\s*:\s*("(?:\\"|[^"])*"|[^\s,{}]+)/g,
    (fullMatch, keyMatch: string, valMatch: string) => {
      if (isWhitelistedKey(keyMatch)) {
        return fullMatch;
      }
      if (isSensitiveKey(keyMatch, options?.additionalKeyPatterns)) {
        const hasQuotes = valMatch.startsWith('"') && valMatch.endsWith('"');
        const quotedPlaceholder = hasQuotes ? `"${placeholder}"` : placeholder;
        return `"${keyMatch}": ${quotedPlaceholder}`;
      }
      return fullMatch;
    }
  );

  // 6. Custom secrets literals (length >= 4)
  if (options?.customSecrets && options.customSecrets.length > 0) {
    const sortedSecrets = [...options.customSecrets]
      .filter((s) => typeof s === "string" && s.length >= 4)
      .sort((a, b) => b.length - a.length);

    for (const secret of sortedSecrets) {
      const regex = new RegExp(escapeRegExp(secret), "g");
      result = result.replace(regex, placeholder);
    }
  }

  // 7. Additional value patterns
  if (options?.additionalValuePatterns && options.additionalValuePatterns.length > 0) {
    for (const pattern of options.additionalValuePatterns) {
      result = result.replace(pattern, placeholder);
    }
  }

  return result;
}

export function redactSecrets<T = unknown>(value: T, options?: RedactionOptions): T {
  const seen = new WeakSet<object>();

  function redactInternal(current: unknown): unknown {
    if (current === null || current === undefined) {
      return current;
    }

    if (typeof current === "string") {
      return redactString(current, options);
    }

    if (
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "symbol" ||
      typeof current === "bigint"
    ) {
      return current;
    }

    if (typeof current === "function") {
      return current;
    }

    if (current instanceof Date || current instanceof RegExp) {
      return current;
    }

    if (ArrayBuffer.isView(current)) {
      return current;
    }

    if (typeof current === "object") {
      if (seen.has(current)) {
        return "[Circular]";
      }
      seen.add(current);

      if (current instanceof Error) {
        const clonedError = Object.create(Object.getPrototypeOf(current)) as Error;
        clonedError.name = current.name;
        clonedError.message = redactString(current.message, options);
        if (typeof current.stack === "string") {
          clonedError.stack = redactString(current.stack, options);
        }
        if ("cause" in current && (current as { cause?: unknown }).cause !== undefined) {
          (clonedError as { cause?: unknown }).cause = redactInternal((current as { cause?: unknown }).cause);
        }

        const customKeys = Object.keys(current);
        for (const k of customKeys) {
          if (k === "name" || k === "message" || k === "stack" || k === "cause") {
            continue;
          }
          if (isSensitiveKey(k, options?.additionalKeyPatterns)) {
            (clonedError as unknown as Record<string, unknown>)[k] = options?.placeholder ?? DEFAULT_REDACTED_PLACEHOLDER;
          } else {
            (clonedError as unknown as Record<string, unknown>)[k] = redactInternal((current as unknown as Record<string, unknown>)[k]);
          }
        }
        return clonedError;
      }

      if (Array.isArray(current)) {
        return current.map((item) => redactInternal(item));
      }

      if (current instanceof Map) {
        const clonedMap = new Map<unknown, unknown>();
        for (const [k, v] of current.entries()) {
          const isSens = typeof k === "string" && isSensitiveKey(k, options?.additionalKeyPatterns);
          clonedMap.set(
            k,
            isSens ? (options?.placeholder ?? DEFAULT_REDACTED_PLACEHOLDER) : redactInternal(v)
          );
        }
        return clonedMap;
      }

      if (current instanceof Set) {
        const clonedSet = new Set<unknown>();
        for (const item of current.values()) {
          clonedSet.add(redactInternal(item));
        }
        return clonedSet;
      }

      const copy: Record<string, unknown> = {};
      const entries = Object.entries(current);
      for (const [k, val] of entries) {
        if (isSensitiveKey(k, options?.additionalKeyPatterns)) {
          copy[k] = options?.placeholder ?? DEFAULT_REDACTED_PLACEHOLDER;
        } else {
          copy[k] = redactInternal(val);
        }
      }
      return copy;
    }

    return current;
  }

  return redactInternal(value) as T;
}

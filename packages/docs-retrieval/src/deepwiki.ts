/** The only repository the built-in health probe asks about: a well-known public project. */
export const DEEPWIKI_PROBE_REPO = "facebook/react";
export const DEEPWIKI_SERVICE = "deepwiki";
export const DEEPWIKI_TOOL_NAMES = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"] as const;
export const MAX_QUESTION_LENGTH = 2000;

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/;

/** Patterns of credentials that must never leave the machine inside a question. Matching text is never echoed back. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{20,}/, /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i, /ctx7sk[-_A-Za-z0-9]{8,}/, /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{8,}/i
];

/**
 * Well-known libraries whose public repository is unambiguous. This is the only "mapping": an exact (case-insensitive) name
 * match. Nothing is guessed from a near match, from a Git remote or from the shape of an owner/repo string.
 */
const PUBLIC_REPOSITORY_MAPPING: Readonly<Record<string, string>> = {
  react: "facebook/react", "react-dom": "facebook/react", next: "vercel/next.js", "next.js": "vercel/next.js", nextjs: "vercel/next.js",
  vue: "vuejs/core", vite: "vitejs/vite", vitest: "vitest-dev/vitest", typescript: "microsoft/TypeScript", lodash: "lodash/lodash",
  express: "expressjs/express", django: "django/django", flask: "pallets/flask", pydantic: "pydantic/pydantic", gin: "gin-gonic/gin", serde: "serde-rs/serde"
};

export type InputCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** `owner/repo` exactly as DeepWiki names a public repository. A URL, a Git remote or a path is not a repository name. */
export function checkRepoName(value: unknown): InputCheck {
  if (typeof value !== "string" || !REPO_NAME.test(value) || value.split("/").some(part => part === "." || part === "..") || value.endsWith(".git"))
    return { ok: false, message: "The repository must be given as owner/repo (for example facebook/react), not as a URL, Git remote or path." };
  return { ok: true };
}

/**
 * Only an explicit declaration that the repository is public allows a lookup. Visibility is never inferred from a Git
 * remote or from the shape of owner/repo, so anything else, including silence, is refused.
 */
export function checkVisibility(value: unknown): InputCheck {
  return value === "public" ? { ok: true } : { ok: false, message: "DeepWiki is queried only for a repository explicitly declared public; this one was not." };
}

/** A question is prose about a public project: no credentials, no pasted source, bounded length. */
export function checkQuestion(value: unknown): InputCheck {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, message: "A non-empty question is required." };
  if (value.length > MAX_QUESTION_LENGTH) return { ok: false, message: `The question must be 1-${MAX_QUESTION_LENGTH} characters; source and file contents are never sent.` };
  if (SECRET_PATTERNS.some(pattern => pattern.test(value))) return { ok: false, message: "The question appears to contain a credential, so it was not sent." };
  if (value.includes("```") || value.split("\n").length > 8) return { ok: false, message: "The question appears to contain source code or file contents, so it was not sent." };
  return { ok: true };
}

export type RepositoryResolution =
  | { readonly status: "resolved"; readonly repoName: string; readonly source: "explicit" | "mapping" }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "no_match"; readonly message: string };

/**
 * Decides which public repository a request names. An explicit `repoName` must be owner/repo and declared public; otherwise a
 * library name must match the built-in mapping exactly. Anything else is refused or reported as unmatched, never guessed.
 */
export function resolveRepository(input: { readonly repoName?: unknown; readonly library?: unknown; readonly visibility?: unknown }): RepositoryResolution {
  if (input.repoName !== undefined) {
    for (const check of [checkRepoName(input.repoName), checkVisibility(input.visibility)]) if (!check.ok) return { status: "refused", message: check.message };
    return { status: "resolved", repoName: input.repoName as string, source: "explicit" };
  }
  if (typeof input.library === "string" && input.library.trim()) {
    const mapped = Object.hasOwn(PUBLIC_REPOSITORY_MAPPING, input.library.trim().toLowerCase()) ? PUBLIC_REPOSITORY_MAPPING[input.library.trim().toLowerCase()] : undefined;
    return mapped ? { status: "resolved", repoName: mapped, source: "mapping" }
      : { status: "no_match", message: `No public repository is mapped to "${input.library.trim().slice(0, 80)}"; give it as owner/repo and declare it public.` };
  }
  return { status: "refused", message: "Give a public repository as owner/repo, declared public." };
}

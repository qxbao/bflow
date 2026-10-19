/** A library Context7 offered for a name, parsed from the text of `resolve-library-id`. */
export interface LibraryCandidate {
  /** Context7-compatible id such as `/reactjs/react.dev` (never includes a version suffix). */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly codeSnippets?: number;
  readonly reputation?: string;
  readonly benchmarkScore?: number;
  /** Versions as listed by Context7, for example `v18.2.0`. Branch entries (`__branch__v18`) are kept verbatim. */
  readonly versions: readonly string[];
}

/**
 * Parses the human-readable result of `resolve-library-id`. The format was observed on the hosted server on
 * 2026-10-19: blocks separated by `----------`, one `- Label: value` line per field. Unknown lines are ignored, so a
 * wording change degrades to fewer fields rather than wrong data. A block without an id is dropped.
 */
export function parseResolveResult(text: string): LibraryCandidate[] {
  const candidates: LibraryCandidate[] = [];
  for (const block of text.split(/^-{5,}\s*$/m)) {
    const field = (label: string): string | undefined => {
      const match = new RegExp(`^\\s*-\\s*${label}\\s*:\\s*(.+?)\\s*$`, "im").exec(block);
      return match?.[1];
    };
    const id = field("Context7-compatible library ID");
    if (!id || !/^\/[^\s/]+\/[^\s]+/.test(id)) continue;
    const title = field("Title") ?? id;
    const versions = (field("Versions") ?? "").split(",").map(item => item.trim()).filter(Boolean);
    const snippets = Number(field("Code Snippets"));
    const score = Number(field("Benchmark Score"));
    const description = field("Description");
    const reputation = field("Source Reputation");
    candidates.push({ id, title, versions,
      ...(description ? { description } : {}),
      ...(Number.isFinite(snippets) && field("Code Snippets") !== undefined ? { codeSnippets: snippets } : {}),
      ...(reputation ? { reputation } : {}),
      ...(Number.isFinite(score) && field("Benchmark Score") !== undefined ? { benchmarkScore: score } : {}) });
  }
  return candidates;
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
const REPUTATION_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, unknown: 0 };

export interface LibrarySelection {
  readonly status: "selected" | "ambiguous" | "no_match";
  readonly library?: LibraryCandidate;
  /** The other plausible matches, best first. */
  readonly alternatives: readonly LibraryCandidate[];
}

const MATCH_RANK: Record<VersionChoice["match"], number> = { exact: 3, minor: 2, major: 1, none: 0, unrequested: 0 };

/**
 * Context7 answers an unknown name with the nearest unrelated libraries, so a result is not evidence that the library
 * exists. A candidate qualifies only when its title or id contains the requested name. Among qualifying candidates an
 * exact name beats a partial one; then, when the caller knows the version the project uses, a candidate that offers
 * that version (exact, then same minor, then same major) beats one that does not; then reputation, benchmark score and
 * snippet count decide. When the runner-up is equal on every signal the selection is `ambiguous`.
 */
export function selectLibrary(candidates: readonly LibraryCandidate[], libraryName: string, requestedVersion?: string | null): LibrarySelection {
  const wanted = normalize(libraryName.replace(/^\//, ""));
  if (!wanted) return { status: "no_match", alternatives: [] };
  const scored = candidates.map(candidate => {
    const title = normalize(candidate.title);
    const idTail = normalize(candidate.id.split("/").slice(1).join("/"));
    const repo = normalize(candidate.id.split("/")[2] ?? "");
    const exact = title === wanted || repo === wanted || normalize(candidate.id) === wanted;
    const contains = exact || title.includes(wanted) || idTail.includes(wanted);
    const reputation = REPUTATION_RANK[(candidate.reputation ?? "unknown").toLowerCase()] ?? 0;
    const version = requestedVersion ? MATCH_RANK[selectVersion(candidate, requestedVersion).match] : 0;
    return { candidate, exact, contains, reputation, version };
  }).filter(item => item.contains);
  if (scored.length === 0) return { status: "no_match", alternatives: [] };
  scored.sort((a, b) => Number(b.exact) - Number(a.exact) || b.version - a.version || b.reputation - a.reputation ||
    (b.candidate.benchmarkScore ?? 0) - (a.candidate.benchmarkScore ?? 0) || (b.candidate.codeSnippets ?? 0) - (a.candidate.codeSnippets ?? 0));
  const [best, second] = scored as [typeof scored[number], typeof scored[number] | undefined];
  const tie = second !== undefined && second.exact === best.exact && second.version === best.version && second.reputation === best.reputation &&
    (second.candidate.benchmarkScore ?? 0) === (best.candidate.benchmarkScore ?? 0) &&
    (second.candidate.codeSnippets ?? 0) === (best.candidate.codeSnippets ?? 0);
  return { status: tie ? "ambiguous" : "selected", library: best.candidate, alternatives: scored.slice(1).map(item => item.candidate) };
}

export interface VersionChoice {
  /** Id to query: the library id with `/<version>` appended when a matching version was found. */
  readonly libraryId: string;
  /** The version selected, as Context7 spells it, or null when none matched and the unversioned id is used. */
  readonly versionUsed: string | null;
  readonly requestedVersion: string | null;
  /**
   * exact: the requested version is offered. minor/major: the nearest offered version at or below it within the same
   * minor/major line. none: nothing suitable is offered. unrequested: the caller gave no version.
   */
  readonly match: "exact" | "minor" | "major" | "none" | "unrequested";
  readonly availableVersions: readonly string[];
}

interface Parsed { readonly raw: string; readonly numbers: readonly [number, number, number]; readonly pre: boolean }

function parseVersion(value: string): Parsed | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/.exec(value.trim());
  if (!match || value.startsWith("__branch__")) return null;
  return { raw: value, numbers: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)], pre: /^[-+]/.test(match[4] ?? "") };
}

const compare = (a: Parsed, b: Parsed) => a.numbers[0] - b.numbers[0] || a.numbers[1] - b.numbers[1] || a.numbers[2] - b.numbers[2];

/**
 * Chooses the documentation version for the version the project uses. Never silently moves to a newer release: when the
 * exact version is not offered, only versions at or below it in the same minor, then the same major line qualify. When
 * none does, the unversioned library id is returned with `match: "none"` and the full list so the caller can report it.
 */
export function selectVersion(library: Pick<LibraryCandidate, "id" | "versions">, requested: string | null | undefined): VersionChoice {
  const available = library.versions;
  if (!requested) return { libraryId: library.id, versionUsed: null, requestedVersion: null, match: "unrequested", availableVersions: available };
  const want = parseVersion(requested);
  const offered = available.map(parseVersion).filter((item): item is Parsed => item !== null && !item.pre);
  const withVersion = (parsed: Parsed, match: VersionChoice["match"]): VersionChoice =>
    ({ libraryId: `${library.id}/${parsed.raw}`, versionUsed: parsed.raw, requestedVersion: requested, match, availableVersions: available });
  if (!want) return { libraryId: library.id, versionUsed: null, requestedVersion: requested, match: "none", availableVersions: available };
  const exact = offered.find(item => compare(item, want) === 0);
  if (exact) return withVersion(exact, "exact");
  const atOrBelow = offered.filter(item => compare(item, want) <= 0).sort((a, b) => compare(b, a));
  const sameMinor = atOrBelow.find(item => item.numbers[0] === want.numbers[0] && item.numbers[1] === want.numbers[1]);
  if (sameMinor) return withVersion(sameMinor, "minor");
  const sameMajor = atOrBelow.find(item => item.numbers[0] === want.numbers[0]);
  if (sameMajor) return withVersion(sameMajor, "major");
  return { libraryId: library.id, versionUsed: null, requestedVersion: requested, match: "none", availableVersions: available };
}

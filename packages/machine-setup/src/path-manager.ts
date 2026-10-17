import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { digest } from "./canonical.js";
import type { SetupStateStore } from "./state-store.js";
import type {
  ComponentDesiredState,
  ComponentObservation,
  PlatformProfile,
  SetupComponent,
  SetupContext
} from "./types.js";
import type { ToolObservation } from "./tools.js";

export const PATH_BLOCK_START = "# >>> bflow managed PATH >>>";
export const PATH_BLOCK_END = "# <<< bflow managed PATH <<<";
const LAUNCHER_HEADER = "#!/bin/sh\n# bflow managed launcher v1\n";
const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

/** Interface only: Windows user PATH editing is designed but not verified. */
export interface WindowsPathEditor {
  readUserPath(): Promise<string[]>;
  writeUserPath(entries: string[]): Promise<void>;
}

export interface PathComponentOptions {
  platform: PlatformProfile;
  store: SetupStateStore;
  observations: readonly Pick<ToolObservation, "pathMissingDir">[];
  env: Record<string, string | undefined>;
  launcher?: { nodeBinary: string; entrypoint: string };
}

interface ParsedFile {
  exists: boolean;
  content: string;
  mode: number | null;
  lines: string[];
  blocks: { start: number; end: number }[];
  /** Marker lines that are not part of a well-formed block (stray end, nested/unterminated start). */
  dangling: number[];
}

const POSIX_DIR_LINE = /^case ":\$\{PATH\}:" in \*:'([^']*)':\*\) ;; \*\) PATH='([^']*)':"\$PATH" ;; esac$/;
const FISH_DIR_LINE = /^contains -- '([^']*)' \$PATH; or set -gx PATH '([^']*)' \$PATH$/;
const POSIX_BODY_LINE = (l: string): boolean => POSIX_DIR_LINE.test(l) || l === "export PATH";
const FISH_BODY_LINE = (l: string): boolean => FISH_DIR_LINE.test(l);
const dirOf = (re: RegExp, l: string): string | null => {
  const m = re.exec(l);
  return m && m[1] === m[2] ? m[1]! : null;
};

export class PathComponent implements SetupComponent {
  readonly componentId = "path";
  readonly action = "configure" as const;
  readonly rollback = "restore_owned_config" as const;

  private readonly platform: PlatformProfile;
  private readonly store: SetupStateStore;
  private readonly env: Record<string, string | undefined>;
  private dirs: string[];
  private readonly managed: string;
  private readonly fresh: string[];
  private readonly launcher: PathComponentOptions["launcher"];

  constructor(options: PathComponentOptions) {
    this.platform = options.platform;
    this.store = options.store;
    this.env = options.env;
    this.launcher = options.launcher;
    const onPath = new Set(options.platform.pathEntries);
    const managed = options.platform.paths.managedBin;
    const out: string[] = [];
    const add = (d: string): void => {
      if (!out.includes(d)) out.push(d);
    };
    add(managed);
    for (const o of options.observations) {
      const d = o.pathMissingDir;
      if (d !== null && d !== managed && !onPath.has(d)) add(d);
    }
    this.dirs = out;
    this.managed = managed;
    this.fresh = out.slice(1);
  }

  /** Desired directories in block order. */
  async desiredDirs(): Promise<string[]> {
    await this.refresh();
    return [...this.dirs];
  }

  /** managedBin + dirs of the existing well-formed block (kept, in order) + new dirs; deduplicated. */
  private async refresh(): Promise<void> {
    const out = [this.managed];
    const file = this.targetFile();
    if (file !== null) {
      const parsed = await this.parse(file);
      if (!("error" in parsed) && parsed.blocks.length === 1 && parsed.dangling.length === 0) {
        const re = this.isFish() ? FISH_DIR_LINE : POSIX_DIR_LINE;
        const b = parsed.blocks[0]!;
        for (const l of parsed.lines.slice(b.start + 1, b.end)) {
          const d = dirOf(re, l);
          if (d !== null && this.dirError(d) === null && !out.includes(d)) out.push(d);
        }
      }
    }
    for (const d of this.fresh) if (!out.includes(d)) out.push(d);
    this.dirs = out;
  }

  private dirError(d: string): string | null {
    if (!path.posix.isAbsolute(d)) return `PATH directory is not absolute: ${JSON.stringify(d)}`;
    if (/['\n\r\0:]/.test(d) || (this.isFish() && d.includes("\\")))
      return `PATH directory contains a forbidden character: ${JSON.stringify(d)}`;
    return null;
  }

  private unsupported(): boolean {
    const p = this.platform;
    return p.os === "win32" || p.shell === "pwsh" || p.shell === "cmd";
  }

  private isFish(): boolean {
    return this.platform.shell === "fish";
  }

  /** Target rc file, or null when the platform is not handled. */
  targetFile(): string | null {
    if (this.unsupported()) return null;
    const home = this.platform.homeDir;
    switch (this.platform.shell) {
      case "zsh":
        return path.join(this.env["ZDOTDIR"] && path.isAbsolute(this.env["ZDOTDIR"]) ? this.env["ZDOTDIR"] : home, ".zshrc");
      case "bash":
        return path.join(home, this.platform.os === "darwin" ? ".bash_profile" : ".bashrc");
      case "fish": {
        const x = this.env["XDG_CONFIG_HOME"];
        const base = x && path.isAbsolute(x) ? x : path.join(home, ".config");
        return path.join(base, "fish", "conf.d", "bflow.fish");
      }
      default:
        return path.join(home, ".profile");
    }
  }

  private validationErrors(): string[] {
    const errs: string[] = [];
    if (this.launcher) {
      for (const [name, value] of Object.entries(this.launcher)) {
        if (!path.posix.isAbsolute(value) || /[\r\n\0]/.test(value)) errs.push(`launcher ${name} must be an absolute single-line path`);
      }
    }
    for (const d of this.dirs) {
      const e = this.dirError(d);
      if (e !== null) errs.push(e);
    }
    return errs;
  }

  private bodyLines(): string[] {
    if (this.isFish()) {
      return this.dirs.map((d) => `contains -- '${d}' $PATH; or set -gx PATH '${d}' $PATH`);
    }
    const lines = this.dirs.map((d) => `case ":\${PATH}:" in *:'${d}':*) ;; *) PATH='${d}':"$PATH" ;; esac`);
    lines.push("export PATH");
    return lines;
  }

  private bodyText(): string {
    return this.bodyLines().join("\n");
  }

  private blockLines(): string[] {
    return [PATH_BLOCK_START, ...this.bodyLines(), PATH_BLOCK_END];
  }

  private async parse(file: string): Promise<ParsedFile | { error: string }> {
    let content: string;
    let mode: number;
    try {
      const st = await stat(file);
      if (!st.isFile()) return { error: `${file} is not a regular file` };
      mode = st.mode & 0o7777;
      content = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, content: "", mode: null, lines: [], blocks: [], dangling: [] };
      }
      return { error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` };
    }
    const lines = content.split("\n");
    const blocks: { start: number; end: number }[] = [];
    const dangling: number[] = [];
    let open: number | null = null;
    lines.forEach((l, i) => {
      if (l === PATH_BLOCK_START) {
        if (open !== null) dangling.push(open);
        open = i;
      } else if (l === PATH_BLOCK_END) {
        if (open === null) dangling.push(i);
        else {
          blocks.push({ start: open, end: i });
          open = null;
        }
      }
    });
    if (open !== null) dangling.push(open);
    return { exists: true, content, mode, lines, blocks, dangling };
  }

  private isWellFormed(p: ParsedFile): boolean {
    return p.blocks.length <= 1 && p.dangling.length === 0;
  }

  private blockBody(p: ParsedFile): string {
    const b = p.blocks[0]!;
    return p.lines.slice(b.start + 1, b.end).join("\n");
  }

  private launcherFiles(): string[] {
    const files = [path.join(this.managed, "bflow")];
    const userBin = path.join(this.platform.homeDir, ".local", "bin");
    if (userBin !== this.managed && this.platform.pathEntries.includes(userBin)) files.push(path.join(userBin, "bflow"));
    return files;
  }

  private launcherContent(): string {
    const launcher = this.launcher!;
    return `${LAUNCHER_HEADER}exec ${shellQuote(launcher.nodeBinary)} ${shellQuote(launcher.entrypoint)} "$@"\n`;
  }

  private stateDigest(body: string, launcher: unknown): string {
    return this.launcher ? digest({ path: body, launcher }) : digest(body);
  }

  private async observeLauncher(file: string): Promise<{ content: string; mode: number; error?: string } | null> {
    if (!this.launcher) return null;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || (this.platform.uid !== null && info.uid !== this.platform.uid)) {
        return { content: "", mode: 0, error: `launcher is not an owned regular file: ${file}` };
      }
      const content = await readFile(file, "utf8");
      if (!content.startsWith(LAUNCHER_HEADER)) return { content, mode: info.mode & 0o777, error: `refusing to replace launcher without Bflow ownership: ${file}` };
      return { content, mode: info.mode & 0o777 };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { content: "", mode: 0, error: `cannot inspect launcher: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async applyLauncher(): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    if (!this.launcher) return { ownedPaths: [], diagnostics: [] };
    const candidates = await Promise.all(this.launcherFiles().map(async (file) => ({ file, observed: await this.observeLauncher(file) })));
    const error = candidates.find((candidate) => candidate.observed?.error)?.observed?.error;
    if (error) return { ownedPaths: [], diagnostics: [error] };
    const ownedPaths: string[] = [];
    const content = this.launcherContent();
    for (const { file, observed } of candidates) {
      if (observed?.content !== content || observed.mode !== 0o755) {
        if (observed) {
          const backup = await this.store.backupFile(file);
          if (!backup.ok) return { ownedPaths, diagnostics: [`launcher backup failed: ${backup.error.message}`] };
        }
        const written = await this.store.writeFileAtomic(file, content, 0o755);
        if (!written.ok) return { ownedPaths, diagnostics: [`launcher write failed: ${written.error.message}`] };
      }
      ownedPaths.push(file);
    }
    return { ownedPaths, diagnostics: [] };
  }

  async observe(_ctx: SetupContext): Promise<ComponentObservation> {
    await this.refresh();
    if (this.unsupported()) {
      return { stateDigest: null, valid: true, diagnostics: ["windows support not verified"] };
    }
    const file = this.targetFile()!;
    const diagnostics = this.validationErrors();
    const launcher = this.launcher ? await Promise.all(this.launcherFiles().map(async (file) => ({
      file, ...(await this.observeLauncher(file) ?? { content: null, mode: null })
    }))) : null;
    for (const observed of launcher ?? []) if ("error" in observed && observed.error) diagnostics.push(observed.error);
    const parsed = await this.parse(file);
    if ("error" in parsed) return { stateDigest: null, valid: false, diagnostics: [...diagnostics, parsed.error] };
    if (!this.isWellFormed(parsed)) {
      diagnostics.push(
        `PATH block malformed in ${file} (${parsed.blocks.length} block(s), ${parsed.dangling.length} dangling marker(s))`
      );
      return { stateDigest: null, valid: false, diagnostics };
    }
    if (parsed.blocks.length === 0) return { stateDigest: null, valid: diagnostics.length === 0, diagnostics };
    return { stateDigest: this.stateDigest(this.blockBody(parsed), launcher), valid: diagnostics.length === 0, diagnostics };
  }

  async desired(_ctx: SetupContext): Promise<ComponentDesiredState> {
    await this.refresh();
    if (this.unsupported()) {
      return {
        digest: digest("windows-unsupported"),
        summary: "PATH management on Windows is not verified",
        targets: [],
        machineWide: false,
        repairNeeded: false
      };
    }
    const file = this.targetFile()!;
    const parsed = await this.parse(file);
    const repairNeeded = !("error" in parsed) && !this.isWellFormed(parsed);
    return {
      digest: this.stateDigest(this.bodyText(), this.launcher ? this.launcherFiles().map((file) => ({ file, content: this.launcherContent(), mode: 0o755 })) : null),
      summary: `Ensure ${this.dirs.length} director${this.dirs.length === 1 ? "y is" : "ies are"} on PATH via ${file}`,
      targets: [file, ...(this.launcher ? this.launcherFiles() : [])],
      machineWide: false,
      repairNeeded
    };
  }

  async apply(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    if (this.unsupported()) return { ownedPaths: [], diagnostics: ["windows support not verified"] };
    await this.refresh();
    if (ctx.mode === "check" || ctx.mode === "dry_run") {
      return { ownedPaths: [], diagnostics: [`PATH apply skipped in ${ctx.mode} mode; nothing written`] };
    }
    const errs = this.validationErrors();
    if (errs.length > 0) return { ownedPaths: [], diagnostics: errs };

    let file = this.targetFile()!;
    try {
      file = await realpath(file);
    } catch {
      // missing file: use the computed path
    }
    const parsed = await this.parse(file);
    if ("error" in parsed) return { ownedPaths: [], diagnostics: [parsed.error] };
    const repair = ctx.mode === "repair";
    if (!this.isWellFormed(parsed) && !repair) {
      return { ownedPaths: [], diagnostics: ["PATH block malformed; run setup --repair"] };
    }

    const launcher = await this.applyLauncher();
    if (launcher.diagnostics.length > 0) return launcher;
    const next = this.nextContent(parsed);
    if (parsed.exists && next === parsed.content) return { ownedPaths: [...launcher.ownedPaths, file], diagnostics: [] };

    if (parsed.exists) {
      const b = await this.store.backupFile(file);
      if (!b.ok) return { ownedPaths: [], diagnostics: [`backup failed: ${b.error.message}`] };
    } else if (this.isFish()) {
      try {
        await mkdir(path.dirname(file), { recursive: true });
      } catch (e) {
        return { ownedPaths: [], diagnostics: [`cannot create ${path.dirname(file)}: ${e instanceof Error ? e.message : String(e)}`] };
      }
    }
    const w = await this.store.writeFileAtomic(file, next, parsed.mode ?? 0o644);
    if (!w.ok) return { ownedPaths: [], diagnostics: [`PATH write failed: ${w.error.message}`] };
    return { ownedPaths: [...launcher.ownedPaths, file], diagnostics: [] };
  }

  private nextContent(p: ParsedFile): string {
    const block = this.blockLines();
    if (this.isFish()) return `${block.join("\n")}\n`;
    if (!p.exists || p.content === "") return `${block.join("\n")}\n`;
    if (p.blocks.length === 1 && p.dangling.length === 0) {
      const b = p.blocks[0]!;
      return [...p.lines.slice(0, b.start), ...block, ...p.lines.slice(b.end + 1)].join("\n");
    }
    if (p.blocks.length === 0 && p.dangling.length === 0) {
      const base = p.content.endsWith("\n") ? p.content : `${p.content}\n`;
      return `${base}\n${block.join("\n")}\n`;
    }
    return this.repairedContent(p, block);
  }

  /** Removes every bflow block and dangling marker, then inserts one block at the first removed position. */
  private repairedContent(p: ParsedFile, block: string[]): string {
    const remove = new Set<number>();
    for (const b of p.blocks) for (let i = b.start; i <= b.end; i++) remove.add(i);
    const bodyRe = this.isFish() ? FISH_BODY_LINE : POSIX_BODY_LINE;
    for (const i of p.dangling) {
      remove.add(i);
      if (p.lines[i] === PATH_BLOCK_START) {
        // Also drop the orphaned generated body that follows an unterminated start marker.
        for (let j = i + 1; j < p.lines.length && bodyRe(p.lines[j]!); j++) remove.add(j);
      }
    }
    const first = Math.min(...remove);
    const out: string[] = [];
    p.lines.forEach((l, i) => {
      if (i === first) out.push(...block);
      if (!remove.has(i)) out.push(l);
    });
    return out.join("\n");
  }
}

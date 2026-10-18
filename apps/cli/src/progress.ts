import { dim, formatProgressStep, humanLine } from "./presentation.js";
import type { CliIo } from "./types.js";

export interface ProgressOptions {
  readonly enabled: boolean;
  readonly color?: boolean | undefined;
  readonly io?: CliIo | undefined;
  readonly animate?: boolean | undefined;
  readonly columns?: (() => number) | undefined;
}

/** Observations only. A completed animation never establishes command success. */
export class CliProgress {
  private number = 0;
  private detailText = "";
  private waiting = false;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private liveLine = false;
  private stopped = false;
  private eventLabel: string | undefined;
  private readonly deferredUpdates: { kind: "step" | "detail" | "event"; message: string }[] = [];
  private omittedUpdates = 0;
  private readonly raw: ((chunk: string) => void) | undefined;

  constructor(private readonly options: ProgressOptions) {
    this.raw = options.animate === false ? undefined : options.io?.stderrRaw?.bind(options.io) ??
      (options.io === undefined ? chunk => { process.stderr.write(chunk); } : undefined);
  }

  private safely(action: () => void): void {
    try { action(); } catch { /* presentation must never affect execution */ }
  }

  private line(text: string): void {
    this.safely(() => {
      if (this.options.io?.progress) this.options.io.progress(text);
      else if (this.options.io) this.options.io.stderr(text);
      else process.stderr.write(`${text}\n`);
    });
  }

  private clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.liveLine) this.safely(() => this.raw?.("\r\x1b[2K"));
    this.liveLine = false;
  }

  private draw(): void {
    // ASCII skeleton works without color and across terminal font sets.
    const frames = ["=     ", "==    ", " ===  ", "  === ", "    ==", "     ="];
    const skeleton = `[${frames[this.frame++ % frames.length]}]`;
    const label = this.waiting ? "Waiting for your confirmation" : "Working";
    const columns = Math.max(2, (this.options.columns?.() ?? process.stderr.columns) || 80);
    // Keep the one mutable line from wrapping, including in narrow terminals.
    const text = `    ${skeleton} ${label} · ${this.detailText}`;
    const width = columns - 1;
    let clipped = "";
    let used = 0;
    for (const char of text) {
      // Conservative width for wide/combining characters and emoji.
      const size = char.codePointAt(0)! > 0x7e ? 2 : 1;
      if (used + size > width) break;
      clipped += char;
      used += size;
    }
    this.safely(() => this.raw?.(`\r\x1b[2K${dim(clipped, Boolean(this.options.color))}`));
    this.liveLine = true;
  }

  private start(): void {
    if (!this.raw) return;
    this.draw();
    this.timer = setInterval(() => this.draw(), 100);
    this.timer.unref();
  }

  private defer(kind: "step" | "detail" | "event", message: string): boolean {
    if (!this.waiting) return false;
    // A slow human response must not create an unbounded log buffer.
    if (this.deferredUpdates.length === 50) {
      this.deferredUpdates.shift();
      this.omittedUpdates++;
    }
    this.deferredUpdates.push({ kind, message: humanLine(message, 240) });
    return true;
  }

  step(message: string): void {
    if (!this.options.enabled || this.stopped) return;
    if (this.defer("step", message)) return;
    this.clear();
    this.eventLabel = undefined;
    this.number++;
    this.line(formatProgressStep(message, this.options.color, this.number));
    this.detailText = "Waiting for the current operation";
    this.line(dim(`    ${this.detailText}`, Boolean(this.options.color)));
    this.start();
  }

  detail(message: string): void {
    if (!this.options.enabled || this.stopped) return;
    if (this.defer("detail", message)) return;
    this.clear();
    this.detailText = humanLine(message, 240);
    this.line(dim(`    ${this.detailText}`, Boolean(this.options.color)));
    this.start();
  }

  event(message: string): void {
    if (!this.options.enabled || this.stopped) return;
    if (this.defer("event", message)) return;
    const match = /^(.*): (starting|checking|complete|failed|succeeded|reused|blocked|skipped)$/.exec(message);
    const label = match?.[1] ?? message;
    if (!match || this.eventLabel !== label) this.step(label);
    this.eventLabel = label;
    if (match && match[2] !== "starting" && match[2] !== "checking") {
      this.detail(message);
      this.clear();
      this.eventLabel = undefined;
    }
  }

  /** The prompt owns terminal input; never redraw over readline's input line. */
  async confirmation<T>(action: () => Promise<T>): Promise<T> {
    if (!this.options.enabled || this.stopped || this.waiting) return action();
    this.clear();
    this.waiting = true;
    this.number++;
    this.line(formatProgressStep("Waiting for your confirmation", this.options.color, this.number));
    this.line(dim("    Review the setup plan below; enter y to approve or N to decline.", Boolean(this.options.color)));
    // Skeleton above the prompt remains static while the user types.
    this.line(dim("    [      ] Awaiting input", Boolean(this.options.color)));
    try { return await action(); }
    finally {
      this.waiting = false;
      const updates = this.deferredUpdates.splice(0);
      const omitted = this.omittedUpdates;
      this.omittedUpdates = 0;
      if (!this.stopped) {
        if (omitted) this.detail(`${omitted} progress updates omitted while awaiting input`);
        for (const update of updates) this[update.kind](update.message);
      }
    }
  }

  stop(): void {
    this.clear();
    this.stopped = true;
    this.deferredUpdates.length = 0;
    this.omittedUpdates = 0;
  }
}

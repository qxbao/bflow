import { redactSecrets, redactString, type RedactionOptions } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogEntry {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly message: string;
  readonly component: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export interface StructuredLogContext {
  readonly component?: string | undefined;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export interface StructuredLoggerOptions {
  readonly component?: string | undefined;
  readonly minLevel?: LogLevel | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly maxEntries?: number | undefined;
  readonly redaction?: RedactionOptions | undefined;
  readonly sink?: ((entry: StructuredLogEntry) => void) | undefined;
  readonly baseContext?: StructuredLogContext | undefined;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class StructuredLogger {
  private readonly _entries: StructuredLogEntry[];
  private readonly _maxEntries: number;
  private readonly _minLevel: LogLevel;
  private readonly _clock: () => Date;
  private readonly _redaction?: RedactionOptions | undefined;
  private readonly _sink?: ((entry: StructuredLogEntry) => void) | undefined;
  private readonly _context: StructuredLogContext;

  constructor(options?: StructuredLoggerOptions, sharedEntries?: StructuredLogEntry[]) {
    this._entries = sharedEntries ?? [];
    this._maxEntries = options?.maxEntries !== undefined && options.maxEntries > 0 ? options.maxEntries : 1000;
    this._minLevel = options?.minLevel ?? "debug";
    this._clock = options?.clock ?? (() => new Date());
    this._redaction = options?.redaction;
    this._sink = options?.sink;

    const base = options?.baseContext;
    this._context = {
      ...(base?.component !== undefined || options?.component !== undefined
        ? { component: base?.component ?? options?.component }
        : {}),
      ...(base?.runId !== undefined ? { runId: base.runId } : {}),
      ...(base?.taskId !== undefined ? { taskId: base.taskId } : {}),
      ...(base?.attemptId !== undefined ? { attemptId: base.attemptId } : {}),
      ...(base?.correlationId !== undefined ? { correlationId: base.correlationId } : {}),
      ...(base?.details !== undefined ? { details: base.details } : {})
    };
  }

  public child(context: StructuredLogContext): StructuredLogger {
    const mergedDetails =
      this._context.details !== undefined || context.details !== undefined
        ? { ...(this._context.details ?? {}), ...(context.details ?? {}) }
        : undefined;

    const mergedContext: StructuredLogContext = {
      component: context.component ?? this._context.component,
      ...(context.runId !== undefined || this._context.runId !== undefined
        ? { runId: context.runId ?? this._context.runId }
        : {}),
      ...(context.taskId !== undefined || this._context.taskId !== undefined
        ? { taskId: context.taskId ?? this._context.taskId }
        : {}),
      ...(context.attemptId !== undefined || this._context.attemptId !== undefined
        ? { attemptId: context.attemptId ?? this._context.attemptId }
        : {}),
      ...(context.correlationId !== undefined || this._context.correlationId !== undefined
        ? { correlationId: context.correlationId ?? this._context.correlationId }
        : {}),
      ...(mergedDetails !== undefined ? { details: mergedDetails } : {})
    };

    return new StructuredLogger(
      {
        minLevel: this._minLevel,
        clock: this._clock,
        maxEntries: this._maxEntries,
        ...(this._redaction !== undefined ? { redaction: this._redaction } : {}),
        ...(this._sink !== undefined ? { sink: this._sink } : {}),
        baseContext: mergedContext
      },
      this._entries
    );
  }

  public log(
    level: LogLevel,
    event: string,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined
  ): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this._minLevel]) {
      return;
    }

    const timestamp = this._clock().toISOString();
    const redactedMessage = redactString(message, this._redaction);

    const mergedDetails =
      this._context.details !== undefined || details !== undefined
        ? { ...(this._context.details ?? {}), ...(details ?? {}) }
        : undefined;

    let durationMs: number | undefined;
    if (details !== undefined && typeof details["durationMs"] === "number") {
      durationMs = details["durationMs"];
    } else if (
      this._context.details !== undefined &&
      typeof this._context.details["durationMs"] === "number"
    ) {
      durationMs = this._context.details["durationMs"];
    }

    const sanitizedDetails =
      mergedDetails !== undefined
        ? (redactSecrets(mergedDetails, this._redaction) as Readonly<Record<string, unknown>>)
        : undefined;

    const entry: StructuredLogEntry = {
      schemaVersion: 1,
      timestamp,
      level,
      event: redactString(event, this._redaction),
      message: redactedMessage,
      component: redactString(this._context.component ?? "runtime", this._redaction),
      ...(this._context.runId !== undefined ? { runId: redactString(this._context.runId, this._redaction) } : {}),
      ...(this._context.taskId !== undefined ? { taskId: redactString(this._context.taskId, this._redaction) } : {}),
      ...(this._context.attemptId !== undefined ? { attemptId: redactString(this._context.attemptId, this._redaction) } : {}),
      ...(this._context.correlationId !== undefined ? { correlationId: redactString(this._context.correlationId, this._redaction) } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(sanitizedDetails !== undefined ? { details: sanitizedDetails } : {})
    };

    this._entries.push(entry);
    if (this._entries.length > this._maxEntries) {
      this._entries.shift();
    }

    if (this._sink) {
      this._sink(entry);
    }
  }

  public debug(
    event: string,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined
  ): void {
    this.log("debug", event, message, details);
  }

  public info(
    event: string,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined
  ): void {
    this.log("info", event, message, details);
  }

  public warn(
    event: string,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined
  ): void {
    this.log("warn", event, message, details);
  }

  public error(
    event: string,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined
  ): void {
    this.log("error", event, message, details);
  }

  public getEntries(filter?: {
    readonly level?: LogLevel | undefined;
    readonly runId?: string | undefined;
    readonly taskId?: string | undefined;
    readonly event?: string | undefined;
  }): readonly StructuredLogEntry[] {
    if (!filter) {
      return [...this._entries];
    }
    return this._entries.filter((e) => {
      if (filter.level !== undefined && e.level !== filter.level) {
        return false;
      }
      if (filter.runId !== undefined && e.runId !== filter.runId) {
        return false;
      }
      if (filter.taskId !== undefined && e.taskId !== filter.taskId) {
        return false;
      }
      if (filter.event !== undefined && e.event !== filter.event) {
        return false;
      }
      return true;
    });
  }

  public toJsonLines(): string {
    return this._entries.map((entry) => JSON.stringify(entry)).join("\n");
  }

  public clear(): void {
    this._entries.length = 0;
  }
}

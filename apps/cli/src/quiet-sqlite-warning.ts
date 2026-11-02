// Node 22 prints "SQLite is an experimental feature" on stderr when node:sqlite loads, which corrupts machine-readable
// CLI output. This module must be the first import of the entrypoint so it runs before any module reaches node:sqlite.
const emitWarning = process.emitWarning.bind(process) as (warning: string | Error, ...args: unknown[]) => void;
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const type = typeof args[0] === "string" ? args[0] : (args[0] as { type?: string } | undefined)?.type;
  const text = typeof warning === "string" ? warning : warning.message;
  if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
  emitWarning(warning, ...args);
}) as typeof process.emitWarning;

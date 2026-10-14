import { createRequire } from "node:module";

// Keep native SQLite usable with the workspace's Vite 5 test transformer.
export const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

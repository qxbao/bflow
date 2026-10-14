import { createRequire } from "node:module";

// Vite 5's built-in list predates node:sqlite. Load the actual Node module, not a replacement driver.
export const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

import { AsyncLocalStorage } from "node:async_hooks";
/** Shared open-file-description is inherited by every Git child, including after parent death. */
export const repositoryLock = new AsyncLocalStorage<number>();

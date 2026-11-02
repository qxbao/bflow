import { resolve } from "node:path";

/** Agent worktrees stay inside the checkout even when private host authority is relocated. */
export function managedWorktreeRoot(repositoryPath: string): string {
  return resolve(repositoryPath, ".bflow", "state", "worktrees");
}

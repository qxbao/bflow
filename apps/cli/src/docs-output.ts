import type { DocsFailure } from "@bflow/docs-retrieval";

/** Read-only diagnosis first; nothing here changes configuration. */
export function docsFailureRemediation(failure: DocsFailure): string {
  switch (failure.kind) {
    case "auth_missing":
    case "auth_invalid": return "DeepWiki needs no credential; run 'bflow setup --repair' to rewrite the service definition.";
    case "version_not_found":
    case "library_not_found": return "Check that the repository is public, spelled owner/repo, and already indexed by DeepWiki; run 'bflow docs structure --repo <owner/repo> --public' to inspect it.";
    case "permission_denied": return "Ask the operator to review the role's documentation grant; inspect 'bflow docs status' before requesting access.";
    case "rate_limited": return failure.retryAfterMs ? `Wait at least ${Math.ceil(failure.retryAfterMs / 1000)}s before another documentation request.` : "Wait for the provider limit to reset, then retry the documentation request.";
    case "no_documentation": return "Ask a more specific question about the repository.";
    case "invalid_arguments": return "Run 'bflow docs --help' and check the repository (owner/repo, declared with --public) and the question; source code and secrets are never sent.";
    case "network":
    case "timeout": return "Check the network connection and run 'bflow docs status' to diagnose the Gateway and documentation provider.";
    default: return "Run 'bflow docs status' to inspect the Gateway and documentation provider before retrying.";
  }
}

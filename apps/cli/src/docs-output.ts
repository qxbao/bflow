import type { DocsFailure } from "@bflow/docs-retrieval";

/** Read-only diagnosis first; credential updates still use the setup approval flow. */
export function docsFailureRemediation(failure: DocsFailure): string {
  switch (failure.kind) {
    case "auth_missing":
    case "auth_invalid": return "Review 'bflow setup --plan'; configure the Context7 key securely with 'bflow setup --apply --context7-api-key-stdin'.";
    case "version_not_found": return "Choose one of the available versions with --version, or run 'bflow docs search <library>' to inspect matching documentation.";
    case "library_not_found": return "Run 'bflow docs search <library>' and choose a matching library ID.";
    case "permission_denied": return "Ask the operator to review the role's documentation grant; inspect 'bflow docs status' before requesting access.";
    case "rate_limited": return failure.retryAfterMs ? `Wait at least ${Math.ceil(failure.retryAfterMs / 1000)}s before another documentation request.` : "Wait for the provider limit to reset, then retry the documentation request.";
    case "no_documentation": return "Use a more specific query or select another documented version with --version.";
    case "invalid_arguments": return "Run 'bflow docs --help' and check the library ID, query and version.";
    case "network":
    case "timeout": return "Check the network connection and run 'bflow docs status' to diagnose the Gateway and documentation provider.";
    default: return "Run 'bflow docs status' to inspect the Gateway and documentation provider before retrying.";
  }
}

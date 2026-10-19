import { parseAllDocuments, stringify } from "yaml";

const MAX_CONFIG_ALIASES = 32;

/** Parses the YAML 1.2 configuration subset used by Bflow, rejecting ambiguous documents. */
export function parseConfigYaml(content: string): unknown {
  const documents = parseAllDocuments(content, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    strict: true
  });
  if (documents.length !== 1) throw new Error("Configuration must contain exactly one YAML document.");
  const document = documents[0]!;
  if (document.errors.length) throw new Error(`Invalid YAML configuration: ${document.errors[0]!.message}`);
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if ("tag" in node && (node as { tag?: unknown }).tag !== undefined)
      throw new Error("Explicit YAML tags are not supported in configuration.");
    if ("items" in node && Array.isArray((node as { items?: unknown }).items)) {
      for (const item of (node as { items: unknown[] }).items) {
        if (item && typeof item === "object" && "key" in item && "value" in item) {
          const keyNode = (item as { key: unknown }).key;
          if (!keyNode || typeof keyNode !== "object" || !("value" in keyNode) || typeof (keyNode as { value: unknown }).value !== "string")
            throw new Error("Configuration mapping keys must be strings.");
          if ((keyNode as { value: string }).value === "<<") throw new Error("YAML merge keys are not supported in configuration.");
          visit(keyNode);
          visit((item as { value: unknown }).value);
        } else visit(item);
      }
    }
    if ("value" in node) visit((node as { value: unknown }).value);
  };
  visit(document.contents);
  try {
    const value = document.toJS({ maxAliasCount: MAX_CONFIG_ALIASES });
    const assertAcyclic = (current: unknown, stack: Set<object>): void => {
      if (current === null || typeof current !== "object") return;
      if (stack.has(current)) throw new Error("Cyclic YAML aliases are not supported in configuration.");
      stack.add(current);
      for (const child of Array.isArray(current) ? current : Object.values(current)) assertAcyclic(child, stack);
      stack.delete(current);
    };
    assertAcyclic(value, new Set());
    return value;
  } catch (error) {
    throw new Error(`Invalid YAML configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Renders a human-editable YAML config with frequently changed role choices first. */
export function stringifyConfigYaml(value: unknown): string {
  const data = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : value;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Configuration must be an object.");
  const root = data as Record<string, unknown>;
  const env = root["environment"] && typeof root["environment"] === "object" && !Array.isArray(root["environment"])
    ? root["environment"] as Record<string, unknown>
    : undefined;
  const ordered: Record<string, unknown> = {};
  if (env) {
    const envOrdered: Record<string, unknown> = {};
    if (Array.isArray(env["roles"])) envOrdered["roles"] = env["roles"];
    const envOrder = ["sdd", "tdd", "verification", "concurrency", "startupTimeoutMs", "shutdownTimeoutMs", "allowProviderFallback", "permissions", "requiredMcpServices", "requiredTools", "context7", "skills", "repositoryId", "workspaceRoot", "sessionName", "herdrBinary"];
    for (const key of envOrder) if (key in env) envOrdered[key] = env[key];
    for (const [key, item] of Object.entries(env)) if (!(key in envOrdered) && key !== "roles") envOrdered[key] = item;
    ordered["environment"] = envOrdered;
  }
  for (const [key, item] of Object.entries(root)) if (key !== "environment") ordered[key] = item;
  return stringify(ordered, { lineWidth: 100, aliasDuplicateObjects: false, sortMapEntries: false });
}

export function renderEnvironmentConfigYaml(value: unknown): string {
  const serialized = stringifyConfigYaml(value)
    .replace(/^environment:\n  roles:\n/m, "environment:\n  # Pick a CLI and optional model per role. Omit model to use the provider default.\n  # Example override:\n  # - role: developer\n  #   cli: codex\n  #   model: <provider-specific-model>\n  #   effort: high\n  roles:\n")
    .replace(/^  sdd:\n/m, "  # SDLC policy and runtime limits are usually left at their defaults.\n  sdd:\n")
    .replace(/^projectName:/m, "# Storage paths and repository identity live below the frequently edited agent choices.\nprojectName:");
  return [
    "# Bflow repository configuration. Change agent choices first; the provider default model is used when omitted.",
    "# A dynamically spawned Developer role without an explicit entry inherits the Coordinator's provider/model/effort.",
    "# effort is optional (minimal, low, medium, high, xhigh, max); valid values depend on the provider.",
    "# Agy encodes effort in the model name, so do not set effort for an agy role.",
    "",
    serialized
  ].join("\n");
}

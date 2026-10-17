import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import {
  AgentProviderIdSchema,
  AgentRoleSchema,
  SkillDefinitionSchema,
  SkillPinSchema,
  type SkillDefinition,
} from "@bflow/contracts";
import { bundleDigest, canonical, type BundleFiles } from "./storage.js";
export { canonical } from "./storage.js";

export const SKILL_SECTIONS = [
  "Supported roles",
  "Prerequisites",
  "Trigger conditions",
  "Required inputs",
  "Expected outputs",
  "Procedure",
  "Bflow commands",
  "Verification requirements",
  "Error handling",
  "Escalation rules",
  "Concrete examples",
] as const;
export const SupportedCommandsSchema = z.array(
  z.string().regex(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/),
);
/** Exact executable command prefixes, supplied by host from its actual command inventory. */
export const BASELINE_COMMANDS = [
  "help",
  "version",
  "init",
  "up",
  "down",
  "attach",
  "status",
  "doctor",
  "recover",
  "run",
  "approve",
  "resume",
  "cancel",
] as const;
const MetadataSchema = z
  .object({
    version: z.string().min(1),
    allowedRoles: z.array(AgentRoleSchema).min(1),
    supportedProviders: z.array(AgentProviderIdSchema).min(1),
    requiredCapabilityIds: z.array(z.string().min(1)),
    requiredToolIds: z.array(z.string().min(1)),
    dependencies: z.array(SkillPinSchema),
  })
  .strict();
const SourceSchema = z.enum(["builtin", "operator", "repository"]);
export type SkillSource = z.infer<typeof SourceSchema>;
/** Locale-independent ordering for reproducible pins and manifests. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function scalar(raw: string): string {
  if (raw.startsWith('"')) return z.string().parse(JSON.parse(raw));
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'")) throw new Error("Invalid frontmatter scalar");
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (!raw.trim() || /[:#\n]/.test(raw))
    throw new Error("Use a quoted single-line frontmatter value");
  return raw.trim();
}
function metadata(text: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(text);
  if (!match?.[1]) throw new Error("Missing SKILL.md frontmatter");
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([a-z-]+):\s*(.+)$/.exec(line);
    if (!pair?.[1] || !pair[2] || fields[pair[1]] !== undefined)
      throw new Error("Malformed/duplicate frontmatter metadata");
    fields[pair[1]] = scalar(pair[2]);
  }
  return z
    .object({
      name: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(64),
      description: z.string().trim().min(1).max(1024),
    })
    .strict()
    .parse(fields);
}
function reference(target: string, from: string, files: BundleFiles): void {
  if (target.startsWith("#")) return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split("#")[0] ?? "");
  } catch {
    throw new Error("Malformed resource reference");
  }
  if (
    !decoded ||
    /[:?\\\0]/.test(decoded) ||
    decoded.startsWith("/") ||
    decoded.split("/").includes("..")
  )
    throw new Error(`Unsafe or unfetched resource reference in ${from}`);
  const path = posix.normalize(posix.join(posix.dirname(from), decoded));
  if (!Object.hasOwn(files, path))
    throw new Error(`Missing skill reference: ${path}`);
}
function resources(text: string, from: string, files: BundleFiles): void {
  // Conservatively reject HTML so dynamic/embedded remote resources cannot escape the inventory.
  if (
    /<[A-Za-z][\w+.-]*:[^>]*>/.test(text) ||
    /\b(?:https?|ftp|file|secret):\/\//.test(text)
  )
    throw new Error(`Unfetched remote resource reference in ${from}`);
  if (/<(?:img|script|iframe|a|link|object|embed|source)\b/i.test(text))
    throw new Error(`Unsupported HTML resource reference in ${from}`);
  const refs = new Map<string, string>();
  for (const match of text.matchAll(/^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) {
    refs.set(match[1]!.toLowerCase(), match[2]!);
    reference(match[2]!, from, files);
  }
  for (const match of text.matchAll(
    /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*["'])?\s*\)/g,
  ))
    reference((match[1] ?? match[2])!, from, files);
  for (const match of text.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const key = (match[2] || match[1])!.toLowerCase();
    if (!refs.has(key))
      throw new Error(`Missing named resource reference in ${from}`);
  }
  // Explicit file references in code spans are references too; plain command code stays inert.
  for (const match of text.matchAll(
    /`((?:\.{0,2}\/)?[\w./-]+\.(?:md|txt|json|ya?ml|png|svg|py|sh|ts|js))`/g,
  ))
    reference(match[1]!, from, files);
}
function commands(text: string, supported: readonly string[]): void {
  // Only documented literal invocations are allowed. Dynamic/option-first commands
  // need an explicit host command adapter, not a guessed shell parser in skill content.
  for (const match of text.matchAll(/(?<![\w-])bflow[ \t]+([^`\n;|&]+)/g)) {
    const invocation = match[1]!.trim();
    if (invocation.startsWith("-") || !/^[a-z]/.test(invocation))
      throw new Error("Unsupported Bflow command syntax");
    const words = /^([a-z][a-z0-9-]*(?:[ \t]+[a-z][a-z0-9-]*)*)/.exec(
      invocation,
    )?.[1];
    if (!words) throw new Error("Unsupported Bflow command syntax");
    const command = words.replace(/[ \t]+/g, " ");
    const family = command.split(" ")[0]!;
    const nested = supported.filter((id) => id.startsWith(family + " "));
    const candidates = nested.length ? nested : supported;
    if (
      !candidates.some((id) => command === id || command.startsWith(id + " "))
    )
      throw new Error(`Unsupported Bflow command: ${command}`);
  }
}
export function validateSkill(
  files: BundleFiles,
  options: { source: SkillSource; supportedCommands: readonly string[] },
): SkillDefinition {
  const source = SourceSchema.parse(options.source);
  const supported = SupportedCommandsSchema.parse(options.supportedCommands);
  // Digest helper validates canonical names/size independently of source location.
  const digest = bundleDigest(files);
  const text = files["SKILL.md"];
  if (!text || !files["skill.json"])
    throw new Error("SKILL.md and skill.json metadata are required");
  const fm = metadata(text);
  for (const heading of SKILL_SECTIONS) {
    const section = new RegExp(
      `^## ${heading}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
      "m",
    ).exec(text);
    if (!section?.[1]?.trim())
      throw new Error(`Missing skill metadata section: ${heading}`);
  }
  const details = MetadataSchema.parse(JSON.parse(files["skill.json"]));
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith(".md")) resources(content, path, files);
    commands(content, supported);
  }
  return SkillDefinitionSchema.parse({
    schemaVersion: 3,
    skillId: fm.name,
    description: fm.description,
    ...details,
    digest,
    source,
    entrypoint: "SKILL.md",
    instructionOnly: true,
  });
}

import { z } from "zod";
import { SkillManager, type InstallSkillOptions } from "./manager.js";
import { SkillFileStore } from "./storage.js";
import { compareText, digestJson } from "./validation.js";

const PlanEntrySchema = z
  .object({
    root: z.string().min(1),
    source: z.enum(["builtin", "operator", "repository"]),
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SkillsSetupEntry = z.infer<typeof PlanEntrySchema>;
/** Structural P26 port; leaf packages do not import one another. */
interface SetupContext {
  mode: "check" | "dry_run" | "apply" | "repair";
  signal?: AbortSignal;
}
function abort(ctx: SetupContext): void {
  if (ctx.signal?.aborted) throw new Error("Skills setup aborted");
}
export class SkillsSetupSynchronizer {
  private readonly entries: SkillsSetupEntry[];
  constructor(
    private readonly manager: SkillManager,
    private readonly store: SkillFileStore,
    entries: SkillsSetupEntry[],
  ) {
    this.entries = z.array(PlanEntrySchema).parse(entries);
    if (
      new Set(this.entries.map((e) => e.expectedDigest)).size !==
      this.entries.length
    )
      throw new Error("Duplicate setup skill pin");
  }
  private async desiredEntries(ctx: SetupContext) {
    const result = [];
    for (const entry of this.entries) {
      abort(ctx);
      const definition = await this.manager.validate(entry.root, entry.source);
      if (definition.digest !== entry.expectedDigest)
        throw new Error("Setup skill source changed from approved pin");
      result.push(definition);
    }
    if (
      new Set(result.map((d) => `${d.skillId}\0${d.version}`)).size !==
      result.length
    )
      throw new Error("Duplicate setup skill name/version");
    return result.sort((a, b) => compareText(a.skillId, b.skillId));
  }
  async observe(ctx: SetupContext): Promise<{
    stateDigest: string | null;
    valid: boolean;
    diagnostics: string[];
  }> {
    try {
      abort(ctx);
      const desired = await this.desiredEntries(ctx);
      const actual = await this.manager.list();
      if (
        !desired.every((d) =>
          actual.some((a) => digestJson(a) === digestJson(d)),
        )
      )
        return {
          stateDigest: null,
          valid: false,
          diagnostics: ["Pinned skills are missing or require synchronization"],
        };
      return { stateDigest: digestJson(desired), valid: true, diagnostics: [] };
    } catch {
      return {
        stateDigest: null,
        valid: false,
        diagnostics: ["Skill catalog integrity or source validation failed"],
      };
    }
  }
  async desired(ctx: SetupContext): Promise<{
    digest: string;
    summary: string;
    targets: string[];
    machineWide: boolean;
    repairNeeded: boolean;
  }> {
    const definitions = await this.desiredEntries(ctx);
    const observed = await this.observe(ctx);
    const corrupted =
      !observed.valid &&
      observed.diagnostics.some((d) => d.includes("integrity"));
    return {
      digest: digestJson(definitions),
      summary: `Install ${definitions.length} pinned instruction-only skills`,
      targets: definitions.map((d) => `${this.store.root}/bundles/${d.digest}`),
      machineWide: true,
      repairNeeded: corrupted,
    };
  }
  async sync(
    ctx: SetupContext,
  ): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    abort(ctx);
    if (ctx.mode === "check" || ctx.mode === "dry_run")
      return {
        ownedPaths: [],
        diagnostics: [`Skills setup ${ctx.mode}: nothing written`],
      };
    await this.desiredEntries(ctx); // Validate the entire plan before the first side effect.
    for (const entry of this.entries) {
      abort(ctx);
      const options: InstallSkillOptions = {
        source: entry.source,
        expectedDigest: entry.expectedDigest,
      };
      await this.manager.install(entry.root, options);
    }
    const observed = await this.observe(ctx);
    if (!observed.valid)
      throw new Error("Skill setup read-back failed; reconcile before retry");
    return {
      ownedPaths: this.entries.flatMap((e) => [
        `${this.store.root}/bundles/${e.expectedDigest}`,
        `${this.store.root}/docs/entry-${e.expectedDigest}.json`,
      ]),
      diagnostics: [],
    };
  }
}

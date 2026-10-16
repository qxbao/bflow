import { z } from "zod";
import type {
  ComponentDesiredState,
  ComponentObservation,
  SetupComponent,
  SetupContext
} from "./types.js";

export const SKILLS_NOT_CONFIGURED = "skills synchronizer not configured";

/** Port implemented by P28; setup never fabricates a result for it. */
export interface SkillsSynchronizer {
  observe(ctx: SetupContext): Promise<ComponentObservation>;
  desired(ctx: SetupContext): Promise<ComponentDesiredState>;
  sync(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }>;
}

const ObservationSchema = z
  .object({ stateDigest: z.string().nullable(), valid: z.boolean(), diagnostics: z.array(z.string()) })
  .strict();
const DesiredSchema = z
  .object({
    digest: z.string(),
    summary: z.string(),
    targets: z.array(z.string()),
    machineWide: z.boolean(),
    repairNeeded: z.boolean()
  })
  .strict();
const SyncSchema = z.object({ ownedPaths: z.array(z.string()), diagnostics: z.array(z.string()) }).strict();

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class SkillsComponent implements SetupComponent {
  readonly componentId = "role-skills";
  readonly action = "resolve_skills" as const;
  readonly rollback = "manual" as const;

  constructor(private readonly synchronizer: SkillsSynchronizer) {}

  async observe(ctx: SetupContext): Promise<ComponentObservation> {
    try {
      const r = ObservationSchema.safeParse(await this.synchronizer.observe(ctx));
      if (r.success) return r.data;
      return { stateDigest: null, valid: false, diagnostics: ["skills synchronizer returned an invalid observation"] };
    } catch (e) {
      return { stateDigest: null, valid: false, diagnostics: [`skills synchronizer observe failed: ${msg(e)}`] };
    }
  }

  async desired(ctx: SetupContext): Promise<ComponentDesiredState> {
    try {
      const r = DesiredSchema.safeParse(await this.synchronizer.desired(ctx));
      if (r.success) return r.data;
    } catch {
      // fall through to the invalid-output state
    }
    return {
      digest: "invalid-skills-desired",
      summary: "skills synchronizer returned invalid desired state",
      targets: [],
      machineWide: false,
      repairNeeded: false
    };
  }

  async apply(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    if (ctx.mode === "check" || ctx.mode === "dry_run") {
      return { ownedPaths: [], diagnostics: [`skills sync skipped in ${ctx.mode} mode; nothing written`] };
    }
    try {
      const r = SyncSchema.safeParse(await this.synchronizer.sync(ctx));
      if (r.success) return r.data;
      return { ownedPaths: [], diagnostics: ["skills synchronizer returned an invalid sync result"] };
    } catch (e) {
      return { ownedPaths: [], diagnostics: [`skills sync failed: ${msg(e)}`] };
    }
  }
}

/** Without a synchronizer the component is omitted from the plan with a diagnostic. */
export function createSkillsComponent(synchronizer: SkillsSynchronizer | undefined): {
  component: SkillsComponent | null;
  diagnostics: string[];
} {
  if (synchronizer === undefined) return { component: null, diagnostics: [SKILLS_NOT_CONFIGURED] };
  return { component: new SkillsComponent(synchronizer), diagnostics: [] };
}

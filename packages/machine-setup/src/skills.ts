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

export class SkillsComponent implements SetupComponent {
  readonly componentId = "role-skills";
  readonly action = "resolve_skills" as const;
  readonly rollback = "manual" as const;

  constructor(private readonly synchronizer: SkillsSynchronizer) {}

  async observe(ctx: SetupContext): Promise<ComponentObservation> {
    return ObservationSchema.parse(await this.synchronizer.observe(ctx));
  }

  async desired(ctx: SetupContext): Promise<ComponentDesiredState> {
    return DesiredSchema.parse(await this.synchronizer.desired(ctx));
  }

  async apply(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }> {
    if (ctx.mode === "check" || ctx.mode === "dry_run") {
      return { ownedPaths: [], diagnostics: [`skills sync skipped in ${ctx.mode} mode; nothing written`] };
    }
    return SyncSchema.parse(await this.synchronizer.sync(ctx));
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

import { z } from "zod";
export const ProjectMemoryConfigSchema = z.object({ schemaVersion: z.literal(3), endpoint: z.string().url(), project: z.string().min(1),
  projectRoot: z.string().min(1), serverDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

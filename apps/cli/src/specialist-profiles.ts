import { resolve, relative, isAbsolute } from 'node:path';
import { CustomRoleProfileSchema, RoleProfileCatalogSchema, ResolvedRoleProfileSnapshotSchema, ROLE_PROFILE_FEATURE,
  pinRoleProfile, sameRoleProfilePin, type ResolvedRoleProfileSnapshot } from '@bflow/contracts';
import { baseRolePolicyDigest } from '@bflow/runtime';
import type { EnvironmentCompositionInput } from './environment.js';
import { readPreviewFile } from './preview-files.js';

/** Read-only repository input. Native ai-isolator profiles use a different selector and loader. */
export async function loadSpecialistProfiles(input: EnvironmentCompositionInput): Promise<ResolvedRoleProfileSnapshot[]> {
  const entries = input.config.environment.specialistProfiles ?? [];
  if (entries.length > 128) throw new Error('Specialist profile catalog exceeds limit');
  const snapshots: ResolvedRoleProfileSnapshot[] = [];
  for (const entry of entries) {
    try {
      const path = specialistProfilePath(input.repository.root, entry.path);
      const definition = CustomRoleProfileSchema.parse(JSON.parse(await readPreviewFile(path, 262144)));
      if (!sameRoleProfilePin(entry.pin, pinRoleProfile(definition))) throw new Error('pin');
      snapshots.push(ResolvedRoleProfileSnapshotSchema.parse({ schemaVersion: 3, pin: entry.pin, definition,
        baseRolePolicyDigest: baseRolePolicyDigest(definition.baseRole), resolutionPolicyVersion: ROLE_PROFILE_FEATURE }));
    } catch {
      // Validation internals can contain raw instruction bytes. Expose only a fixed rule and safe identity.
      throw new Error('Specialist profile source is unavailable, unsafe, malformed or differs from its exact pin');
    }
  }
  const result = RoleProfileCatalogSchema.safeParse(snapshots);
  if (!result.success) throw new Error('Specialist profile catalog contains duplicate or conflicting identities');
  return result.data;
}

export function specialistProfilePath(root: string, source: string): string {
  const path = resolve(root, source);
  const rel = relative(root, path);
  if (isAbsolute(source) || !rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || source.includes('\\') ||
      source.split('/').some(segment => segment === '..' || segment === '.' || segment === ''))
    throw new Error('Specialist profile source must be a safe repository-relative file');
  return path;
}

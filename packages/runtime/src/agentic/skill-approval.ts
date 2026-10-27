import { lstat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { SkillApprovalRequestSchema, SkillApprovalStoreSchema } from '@bflow/contracts';
import { canonicalPlanDigest } from '../planning/index.js';
import { readResolutionFile } from './execution-binding.js';

/** Caller selects the path from trusted machine state, never repository configuration. */
export async function readSkillApproval(path: string, input: unknown, clock: () => Date = () => new Date()): Promise<boolean> {
  try {
    const request = SkillApprovalRequestSchema.parse(input);
    const absolute = resolve(path);
    if (absolute !== path) return false;
    const uid = process.getuid?.();
    let parent = parse(absolute).root;
    let privateEnclosure = false;
    for (const part of dirname(absolute).slice(parent.length).split('/').filter(Boolean)) {
      parent = join(parent, part);
      const stats = await lstat(parent);
      const stickyRoot = stats.uid === 0 && (stats.mode & 0o1000) !== 0;
      if (!stats.isDirectory() || stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid && stats.uid !== 0)) return false;
      if (!privateEnclosure && (stats.mode & 0o022) !== 0 && !stickyRoot) return false;
      // An owner-private ancestor shields isolator descendants whose inherited mode permits group writes.
      privateEnclosure ||= uid !== undefined && stats.uid === uid && (stats.mode & 0o077) === 0;
    }
    const directory = await lstat(dirname(absolute));
    const file = await lstat(absolute);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || (directory.mode & 0o077) !== 0 ||
        (uid !== undefined && (file.uid !== uid || directory.uid !== uid))) return false;
    const bytes = await readResolutionFile(absolute, 1024 * 1024);
    const store = SkillApprovalStoreSchema.parse(JSON.parse(bytes.toString('utf8')));
    const receipt = store.receipts.find(candidate => candidate.approvalReceiptId === request.approvalReceiptId);
    if (!receipt) return false;
    const now = clock().getTime();
    if (Date.parse(receipt.approvedAt) > now || receipt.expiresAt && Date.parse(receipt.expiresAt) <= now) return false;
    const pins = (value: typeof receipt.dependencies) => [...value].sort((a, b) => a.skillId.localeCompare(b.skillId));
    return receipt.skillId === request.skillId && receipt.version === request.version && receipt.digest === request.digest &&
      receipt.repositoryId === request.repositoryId && receipt.sessionId === request.sessionId &&
      receipt.roles.includes(request.role) && receipt.providers.includes(request.provider) &&
      canonicalPlanDigest(pins(receipt.dependencies)) === canonicalPlanDigest(pins(request.dependencies));
  } catch {
    return false;
  }
}

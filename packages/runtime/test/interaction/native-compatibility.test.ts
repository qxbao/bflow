import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { ApprovalDecisionSchema } from "@bflow/contracts";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { digest } from "../../src/agentic/journal.js";

it("replays W00 native-v1 fixtures through the real journal without rewriting bytes", async () => {
  // Test data only, never a module load across package paths or physical hook.
  const fixtures = z.array(z.object({ decision: ApprovalDecisionSchema,
    nativeReceipt: z.object({ version: z.literal(1), repository: z.string(), sessionId: z.string(), id: z.string() }).passthrough(),
  })).parse(JSON.parse(await readFile(new URL("../../../contracts/test/fixtures/local-web/approval-bundle.json", import.meta.url), "utf8")));
  const directory = await mkdtemp(join(tmpdir(), "web-native-compat-"));
  try {
    for (const fixture of fixtures) {
      const receipt = fixture.nativeReceipt;
      const journal = new HostReceiptJournal(directory, receipt.repository, receipt.sessionId);
      const file = join(directory, `human-${digest(receipt.id)}.json`), bytes = JSON.stringify(receipt);
      await writeFile(file, bytes, { mode: 0o600 });
      expect(await journal.authenticateHuman(fixture.decision)).toBe(true);
      expect(await journal.humanDecisions()).toContainEqual(fixture.decision);
      expect(await readFile(file, "utf8")).toBe(bytes);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

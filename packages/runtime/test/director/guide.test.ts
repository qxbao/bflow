import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DIRECTOR_GUIDE_MAX_BYTES,
  DIRECTOR_GUIDE_SOURCE,
  DIRECTOR_TOOLS,
  DirectorEndpoint,
  DirectorStore,
  DirectorTools,
  createDirectorGuideSource,
  readDirectorGuide
} from "../../src/director/index.js";

// These tests prove the guide text exists, stays bounded and is wired to the right session layout.
// They cannot prove that a model obeys it; that belongs to the scoped live evaluation (Task 10).

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "director-guide-"));
  dirs.push(dir);
  return dir;
}

describe("Director guide asset", () => {
  it("loads the installed guide within 16 KiB with a logical source name", async () => {
    const guide = await readDirectorGuide();
    expect(guide.framing).toBe("director");
    expect(guide.source).toBe(DIRECTOR_GUIDE_SOURCE);
    expect(guide.source.startsWith("/")).toBe(false);
    expect(DIRECTOR_GUIDE_MAX_BYTES).toBe(16384);
    expect(Buffer.byteLength(guide.prompt, "utf8")).toBeLessThanOrEqual(16384);
  });

  it("rejects an oversized, empty or symlinked guide", async () => {
    const dir = await temp();
    const big = path.join(dir, "big.md");
    await fs.writeFile(big, "x".repeat(DIRECTOR_GUIDE_MAX_BYTES + 1));
    await expect(readDirectorGuide(pathToFileURL(big))).rejects.toThrow(/Cannot load the Director guide/);
    const empty = path.join(dir, "empty.md");
    await fs.writeFile(empty, " \n");
    await expect(readDirectorGuide(pathToFileURL(empty))).rejects.toThrow(/empty/);
    const ok = path.join(dir, "ok.md");
    await fs.writeFile(ok, "guide");
    const link = path.join(dir, "link.md");
    await fs.symlink(ok, link);
    await expect(readDirectorGuide(pathToFileURL(link))).rejects.toThrow(/Cannot load the Director guide/);
    await expect(readDirectorGuide(pathToFileURL(path.join(dir, "missing.md")))).rejects.toThrow(/Cannot load the Director guide/);
  });
});

describe("Director guide instruction coverage", () => {
  const load = async () => (await readDirectorGuide()).prompt;

  it("keeps the Director out of code editing, evidence and approval", async () => {
    const text = await load();
    expect(text).toMatch(/never edit source code/i);
    expect(text).toMatch(/one-line fix/);
    expect(text).toMatch(/Developer/);
    expect(text).toMatch(/never write evidence/i);
    expect(text).toMatch(/cannot approve/i);
    expect(text).toMatch(/not an approval/);
    expect(text).toContain("! bflow approve '#n'");
    expect(text).toMatch(/Bflow Web/);
  });

  it("delegates the 'sửa nhanh 1 dòng' request to a Developer run and exposes no approval or evidence tool", async () => {
    const text = await load();
    const fastEdit = text.slice(text.indexOf("sửa nhanh 1 dòng") - 200, text.indexOf("sửa nhanh 1 dòng") + 600);
    expect(fastEdit).toContain("start_work");
    expect(fastEdit).toMatch(/Developer will make it/);
    expect(fastEdit).toMatch(/do not open an editor/i);
    const names = DIRECTOR_TOOLS.map(tool => tool.name);
    expect(names.filter(name => /approve|approval|evidence|gate/i.test(name))).toEqual([]);
  });

  it("covers the loop: idle wait for Web, message-level updates, absence, errors, issue queue and bounded context", async () => {
    const text = await load();
    expect(text).toContain("director_wait");
    expect(text).toMatch(/Idle means wait, not stop/);
    expect(text).toMatch(/Bflow Web at any time/);
    expect(text).toMatch(/no token streaming/i);
    expect(text).toMatch(/invalidation events/);
    expect(text).toMatch(/user may be absent/i);
    expect(text).toMatch(/tool error is information/i);
    expect(text).toMatch(/identical failing call/);
    expect(text).toContain("list_issues");
    expect(text).toContain("set_issue_status");
    expect(text).toMatch(/parked tasks as \*\*not fully done\*\*/);
    expect(text).toMatch(/Bounded context/);
    expect(text).toMatch(/Never invent or edit a cursor/);
    expect(text).toContain("reconcile_delivery");
    expect(text).toMatch(/Herdr "done"/);
  });

  it("only names tools that exist in the Director tool list", async () => {
    const text = await load();
    const known = new Set(DIRECTOR_TOOLS.map(tool => tool.name));
    const identifiers = [...new Set([...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(match => match[1]!))];
    // `user_decision_pending` is a ParkedIssue kind, not a tool.
    expect(identifiers.filter(name => !known.has(name) && name !== "user_decision_pending")).toEqual([]);
    for (const required of ["director_wait", "director_say", "start_work", "planning_reference", "read_coordinator_guide", "reconcile_delivery"]) {
      expect(identifiers).toContain(required);
    }
  });

  it("does not use the invented message names the other prompts also avoid", async () => {
    const text = await load();
    for (const invented of ["task.blocked", "escalation.notice", "clarification.needed"]) expect(text).not.toContain(invented);
  });
});

describe("read_coordinator_guide selection", () => {
  const legacy = async () => ({ source: "agents/coordinator/system-prompt.md", prompt: "COORDINATOR V2 BODY" });
  async function tools(guide: ReturnType<typeof createDirectorGuideSource>): Promise<{ call(): Promise<{ source: string; prompt: string }> }> {
    const root = await temp();
    const store = new DirectorStore({ directory: path.join(root, "state") });
    const { token } = await store.register({ provider: "claude", repositoryRoot: "/repo" });
    const instance = new DirectorTools({ store, coordinator: { invoke: async () => ({}) }, coordinatorGuide: guide });
    return { call: async () => (await instance.invoke("read_coordinator_guide", {}, token)) as unknown as { source: string; prompt: string } };
  }

  it("returns the Director guide, unwrapped, in the Director layout", async () => {
    const out = await (await tools(createDirectorGuideSource({ directorLayout: true, readCoordinatorGuide: legacy }))).call();
    expect(out.source).toBe(DIRECTOR_GUIDE_SOURCE);
    expect(out.prompt.startsWith("# Bflow Director guide")).toBe(true);
    expect(out.prompt).not.toContain("COORDINATOR V2 BODY");
    expect(out.prompt).not.toContain("Bỏ qua các phần nói về pane");
  });

  it("keeps the exact legacy Coordinator guide, with its prefix, for v2 sessions", async () => {
    const out = await (await tools(createDirectorGuideSource({ directorLayout: false, readCoordinatorGuide: legacy }))).call();
    expect(out.source).toBe("agents/coordinator/system-prompt.md");
    expect(out.prompt).toBe("Hướng dẫn lập kế hoạch của Coordinator (Director dùng thay). Bỏ qua các phần nói về pane, Herdr và Conversation.\n\nCOORDINATOR V2 BODY");
  });

  it("does not read the legacy guide in the Director layout nor the Director guide in v2", async () => {
    let legacyReads = 0;
    let directorReads = 0;
    const read = async () => { legacyReads += 1; return { source: "s", prompt: "p" }; };
    const director = async () => { directorReads += 1; return { source: "d", prompt: "d", framing: "director" as const }; };
    await createDirectorGuideSource({ directorLayout: true, readCoordinatorGuide: read, readDirectorGuide: director })();
    expect([legacyReads, directorReads]).toEqual([0, 1]);
    await createDirectorGuideSource({ directorLayout: false, readCoordinatorGuide: read, readDirectorGuide: director })();
    expect([legacyReads, directorReads]).toEqual([1, 1]);
  });
});

describe("read_coordinator_guide through the Director endpoint", () => {
  async function endpoint(directorLayout: boolean): Promise<{ call(): Promise<{ source: string; prompt: string }> }> {
    const root = await temp();
    const instance = new DirectorEndpoint({
      directory: path.join(root, "director"),
      repositoryRoot: "/repo",
      coordinator: { invoke: async () => ({}) },
      feed: { read: () => ({ items: [] }) },
      inspect: async () => ({ runs: [] }),
      coordinatorGuide: createDirectorGuideSource({
        directorLayout,
        readCoordinatorGuide: async () => ({ source: "agents/coordinator/system-prompt.md", prompt: "COORDINATOR V2 BODY" })
      })
    });
    const { token } = await instance.register({ provider: "claude" });
    return { call: async () => (await instance.call(token, "read_coordinator_guide", {})) as unknown as { source: string; prompt: string } };
  }

  it("serves the 16 KiB Director guide in a Director session and the old guide in v2", async () => {
    const director = await (await endpoint(true)).call();
    expect(director.source).toBe(DIRECTOR_GUIDE_SOURCE);
    expect(Buffer.byteLength(director.prompt, "utf8")).toBeLessThanOrEqual(DIRECTOR_GUIDE_MAX_BYTES);
    expect(director.prompt).toBe((await readDirectorGuide()).prompt);
    const legacy = await (await endpoint(false)).call();
    expect(legacy.prompt.endsWith("COORDINATOR V2 BODY")).toBe(true);
    expect(legacy.prompt).toContain("Bỏ qua các phần nói về pane");
  });
});

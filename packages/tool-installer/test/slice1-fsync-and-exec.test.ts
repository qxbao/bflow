import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open)
  };
});

import { createToolCapability } from "../src/installer.js";
import { FileToolCapabilityRegistry } from "../src/integrations.js";

let root: string;
let dirSyncErrorCode: string | null = null;

beforeEach(async () => {
  dirSyncErrorCode = null;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  root = await realpath(await mkdtemp(join(tmpdir(), "bflow-s1-ti-")));
  vi.mocked(fsPromises.open).mockImplementation((async (pathLike, flags, mode) => {
    const handle = await actual.open(pathLike, flags, mode);
    if (flags === "r" && dirSyncErrorCode !== null) {
      const info = await handle.stat();
      if (info.isDirectory()) {
        const code = dirSyncErrorCode;
        return new Proxy(handle, {
          get(target, prop, receiver) {
            if (prop === "sync") {
              return async () => {
                const err = Object.assign(new Error(`${code}: fsync not supported on directory`), { code });
                throw err;
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    }
    return handle;
  }) as typeof fsPromises.open);
});

afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await actual.rm(root, { recursive: true, force: true });
});

describe("Slice 1 — FileToolCapabilityRegistry FUSE/NTFS directory fsync resilience", () => {
  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EBADF"])(
    "succeeds cleanly when directory sync() throws %s on FUSE/NTFS mounts",
    async (code) => {
      const dir = join(root, `case-${code}`);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, "capabilities.json");
      dirSyncErrorCode = code;

      const registry = new FileToolCapabilityRegistry(file);
      const capability = createToolCapability("rtk", "0.33.0", "repo-fuse");
      await expect(
        registry.register(capability, { verified: true, version: "0.33.0", scopeKey: "repo-fuse" })
      ).resolves.toMatchObject({ toolId: "rtk" });

      expect((await new FileToolCapabilityRegistry(file).list("repo-fuse"))[0]?.toolId).toBe("rtk");

      await expect(registry.revoke("repo-fuse", "rtk")).resolves.toBeUndefined();
      expect(await new FileToolCapabilityRegistry(file).list("repo-fuse")).toHaveLength(0);
    }
  );

  it("still propagates genuine I/O failures (EIO) from directory sync()", async () => {
    const dir = join(root, "case-eio");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "capabilities.json");
    dirSyncErrorCode = "EIO";

    const registry = new FileToolCapabilityRegistry(file);
    const capability = createToolCapability("rtk", "0.33.0", "repo-eio");
    await expect(
      registry.register(capability, { verified: true, version: "0.33.0", scopeKey: "repo-eio" })
    ).rejects.toMatchObject({ code: "EIO" });
  });
});

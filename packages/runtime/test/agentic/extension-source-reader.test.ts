import { expect, it } from "vitest";
import * as binding from "../../src/agentic/execution-binding.js";

it("reports source-reader-unavailable when a startup reader lacks private-source support", async () => {
  const read = Reflect.get(binding, "readPrivateExecutionSources"); expect(read).toBeTypeOf("function");
  await expect(read(async () => ({}))).rejects.toThrow("source-reader-unavailable");
  await expect(read(Object.assign(async () => ({}), { readPrivateSources: async () => ({ policy: "pinned" }) }))).resolves.toEqual({ policy: "pinned" });
});

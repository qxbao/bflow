import { expect, it } from "vitest";
import { ProjectionSnapshots } from "../../src/interaction/projection-snapshots.js";
import { state, run } from "./fixtures.js";

it("protects shared read snapshots from mutation and revalidates same-size replacement bytes", () => {
  const cache = new ProjectionSnapshots(), initial = state([run()]), repository = initial.repository;
  const bytes = Buffer.from(JSON.stringify(initial));
  const first = cache.parse("state.json", repository, bytes);
  expect(() => { first.runs[0]!.delegation.title = "changed by reader"; }).toThrow();
  const second = cache.parse("state.json", repository, Buffer.from(bytes));
  expect(second.runs[0]!.delegation.title).toBe(initial.runs[0]!.delegation.title);
  const invalid = JSON.stringify(initial).replace('"planning"', '"xxxxxxxx"');
  expect(Buffer.byteLength(invalid)).toBe(bytes.length);
  expect(() => cache.parse("state.json", repository, Buffer.from(invalid))).toThrow();
  expect(() => cache.parse("state.json", repository + "/foreign", bytes)).toThrow();
  bytes.fill(0);
  expect(cache.parse("state.json", repository, Buffer.from(JSON.stringify(initial))).runs[0]!.delegation.title).toBe(initial.runs[0]!.delegation.title);
});

it("observes changed valid bytes immediately instead of serving a timed snapshot", () => {
  const cache = new ProjectionSnapshots(), initial = state([run()]);
  cache.parse("state.json", initial.repository, Buffer.from(JSON.stringify(initial)));
  initial.runs[0]!.delegation.title = "Updated requirement";
  expect(cache.parse("state.json", initial.repository, Buffer.from(JSON.stringify(initial))).runs[0]!.delegation.title).toBe("Updated requirement");
});

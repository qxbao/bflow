import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPriceCents } from "../src/index.ts";

test("formats thousands separators and cents", () => {
  assert.equal(formatPriceCents(123456), "$1,234.56");
});

test("pads small amounts", () => {
  assert.equal(formatPriceCents(5), "$0.05");
  assert.equal(formatPriceCents(0), "$0.00");
});

test("rejects negative and fractional cents", () => {
  assert.throws(() => formatPriceCents(-1), RangeError);
  assert.throws(() => formatPriceCents(1.5), RangeError);
});

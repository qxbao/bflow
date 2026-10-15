import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotalCents, subtotalCents } from "../src/index.ts";

const items = [
  { sku: "book", unitPriceCents: 1500, quantity: 2 },
  { sku: "pen", unitPriceCents: 250, quantity: 4 }
];

test("subtotal multiplies unit price by quantity", () => {
  assert.equal(subtotalCents(items), 4000);
});

test("total without discount equals subtotal", () => {
  assert.equal(cartTotalCents(items), 4000);
});

test("empty cart totals zero", () => {
  assert.equal(cartTotalCents([]), 0);
});

test("rejects discount outside 0-100", () => {
  assert.throws(() => cartTotalCents(items, 101), RangeError);
  assert.throws(() => cartTotalCents(items, -1), RangeError);
});

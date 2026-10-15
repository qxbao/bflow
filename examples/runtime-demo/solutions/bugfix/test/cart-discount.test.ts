import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotalCents } from "../src/index.ts";

test("BUG-001 regression: 10% discount on 4000 cents totals 3600 cents", () => {
  assert.equal(cartTotalCents([{ sku: "book", unitPriceCents: 2000, quantity: 2 }], 10), 3600);
});

test("BUG-001 regression: discounted total rounds to whole cents", () => {
  assert.equal(cartTotalCents([{ sku: "pen", unitPriceCents: 999, quantity: 1 }], 15), 849);
});

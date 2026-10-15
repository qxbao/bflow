// Reproduces BUG-001. This file is intentionally outside `npm test` and fails until the bug is fixed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotalCents } from "../src/index.ts";

test("BUG-001: 10% discount on 4000 cents totals 3600 cents", () => {
  const items = [{ sku: "book", unitPriceCents: 2000, quantity: 2 }];
  assert.equal(cartTotalCents(items, 10), 3600);
});

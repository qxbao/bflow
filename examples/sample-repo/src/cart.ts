/** A cart line. Prices are integer cents to avoid floating-point money errors. */
export interface CartItem {
  readonly sku: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
}

export function subtotalCents(items: readonly CartItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
}

/**
 * Applies a percentage discount (0-100) to the cart subtotal and rounds to whole cents.
 *
 * BUG-001: the discount is subtracted as a flat number of cents instead of a percentage.
 * See issues/BUG-001-discount.md.
 */
export function cartTotalCents(items: readonly CartItem[], discountPercent = 0): number {
  if (discountPercent < 0 || discountPercent > 100) {
    throw new RangeError("discountPercent must be between 0 and 100");
  }
  const subtotal = subtotalCents(items);
  return Math.max(0, subtotal - discountPercent);
}

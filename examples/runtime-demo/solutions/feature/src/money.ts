/** Formats integer cents as a US-dollar display string, e.g. 123456 -> "$1,234.56". */
export function formatPriceCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new RangeError("cents must be a non-negative integer");
  }
  const dollars = Math.floor(cents / 100).toLocaleString("en-US");
  const remainder = String(cents % 100).padStart(2, "0");
  return `$${dollars}.${remainder}`;
}

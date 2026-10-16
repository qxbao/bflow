/** Add two safe integer inputs. See requests/bugfix.md for output overflow. */
export function sum(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new RangeError('Inputs must be safe integers');
  }
  return a + b;
}

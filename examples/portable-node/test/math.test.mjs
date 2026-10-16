import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../dist/math.js';

test('sum adds two integers', () => assert.equal(sum(2, 3), 5));
test('sum supports zero and negative integers', () => assert.equal(sum(0, -3), -3));
test('sum rejects fractional inputs', () => assert.throws(() => sum(1.5, 2), RangeError));
test('sum rejects unsafe inputs', () => assert.throws(() => sum(Infinity, 2), RangeError));

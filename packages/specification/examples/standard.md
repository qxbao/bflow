# Handle empty input in average calculation

Spec: spec-1 · Version: 1 · standard · Risk: medium · draft

Return zero for an empty list and preserve averages for nonempty lists.

## Problem statement

average([]) divides zero by zero and returns NaN to callers.

## In scope

- Define the empty-list result
- Preserve the arithmetic mean for nonempty lists

## Out of scope

- Rounding changes
- New numeric types

## Acceptance criteria

- [ac-1] average([]) returns 0 rather than NaN. (required; unit_test; pending)
- [ac-2] average([2, 4]) returns 3 and average([-2, 2]) returns 0. (required; unit_test; pending)

## Functional requirements

- Return 0 when the input length is zero.
- For nonempty input, return the sum divided by item count.

## Proposed test strategy

Write a failing empty-input regression test first; then verify empty, singleton, positive and negative input using unit tests.

## Affected paths

- src/math/average.ts

## Traceability

- ac-1: implement
- ac-2: implement

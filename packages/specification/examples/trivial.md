# Correct the status command example

Spec: spec-1 · Version: 1 · trivial · Risk: low · draft

Replace the mistaken bflow stats example with bflow status.

## Problem statement

guide.md currently tells users to run the unsupported bflow stats command.

## In scope

- Correct the command spelling in guide.md

## Out of scope

- CLI parsing and Runtime behavior

## Acceptance criteria

- [ac-1] guide.md shows bflow status and contains no bflow stats command example. (required; manual_review; pending)

## Affected paths

- guide.md

## Traceability

- ac-1: implement

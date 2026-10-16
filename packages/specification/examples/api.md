# Add paginated run query and filtering contract

Spec: spec-api-1 · Version: 1 · complex · Risk: high · draft

Introduce PageRequest pagination, status filtering, and timestamp bounds to the public run query contract.

## Problem statement

The current run query contract returns unbounded lists without filter parameters, risking excessive payload sizes and preventing efficient cursor-based run retrieval.

## In scope

- Public PageRequest and PageResponse query types in @bflow/contracts
- Cursor-based pagination with limit bounds (1 to 500)
- Run status and time-range query filter criteria
- Backwards compatibility for unpaginated callers

## Out of scope

- Database index modifications
- CLI presentation formatting
- Multi-tenant authorization logic

## Acceptance criteria

- [ac-1] PageRequestSchema validates cursor strings and clamps limit between 1 and 500 items. (required; unit_test; pending)
- [ac-2] RunQueryFilterSchema validates optional status filters and ISO datetime range bounds while rejecting undeclared properties. (required; unit_test; pending)
- [ac-3] Unpaginated query requests remain valid and produce conforming RunQueryResult collections without backward incompatibility. (required; integration_test; pending)

## Functional requirements

- Export PageRequestSchema validating cursor string and limit between 1 and 500.
- Export RunQueryFilterSchema validating optional status and ISO datetime range filters.
- Support backwards-compatible query execution when pagination parameters are omitted.

## Proposed test strategy

TDD unit tests validating schema boundary conditions followed by integration tests ensuring backward compatibility with unpaginated query fixtures.

## Design proposal

Define composable pagination and filter Zod schemas in @bflow/contracts with optional fields, preserving existing query signatures.

## Architecture

Extend @bflow/contracts with additive PageRequestSchema and RunQueryFilterSchema definitions. Ensure zero breaking changes for existing query callers.

## Technical constraints

- Strict TypeScript typing with exactOptionalPropertyTypes and verbatimModuleSyntax.
- Clamp limit to maximum 500 items per page.
- Preserve existing caller signatures without breaking changes.

## API / data contracts

- PageRequestSchema: { cursor?: string, limit?: number (1..500) }
- RunQueryFilterSchema: { status?: RunStatus, startedAfter?: IsoDateTime, startedBefore?: IsoDateTime }
- Page<RunSummary>: { items: readonly RunSummary[], nextCursor?: string }

## Security considerations

Enforce maximum page size limit of 500 to prevent memory exhaustion DoS; sanitize opaque cursor strings to prevent data leakage.

## Risks and tradeoffs

- Opaque cursor tokens prevent client coupling to internal database primary keys.
- Additive contract surface slightly increases bundle size in exchange for strong runtime validation.

## Rollback

Revert contract additions and rebuild packages/contracts; existing clients remain fully operational because new fields are optional.

## Affected paths

- packages/contracts/src/run.ts
- packages/contracts/src/common.ts

## Traceability

- ac-1: task-contracts-schema, task-contracts-tests
- ac-2: task-contracts-schema, task-contracts-tests
- ac-3: task-contracts-tests

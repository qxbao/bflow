# Migrate stored runs to include archived_at

Spec: spec-1 · Version: 1 · complex · Risk: high · draft

Add a nullable timestamp to the local SQLite runs table without changing existing query behavior.

## Problem statement

Run records cannot retain an archive timestamp; existing rows and queries must remain compatible after the schema upgrade.

## In scope

- Versioned SQLite migration
- Nullable archived_at storage
- Compatibility and rollback checks

## Out of scope

- Archive UI
- Automatic deletion
- Multi-host storage

## Acceptance criteria

- [ac-1] An old-schema fixture retains all run IDs and query results, with archived_at NULL, after migration and reopening. (required; integration_test; pending)
- [ac-2] Repeated opening does not reapply the migration; a valid timestamp round-trips without modifying other fields. (required; integration_test; pending)

## Functional requirements

- Persist an optional archive timestamp.
- Preserve existing rows and existing query results after migration.

## Proposed test strategy

Use real temporary SQLite fixtures: old schema migration, repeat opening, timestamp round trip, and rollback backup verification.

## Design proposal

Apply the approved schema-version migration transaction before opening the new projection. Add a nullable column without rewriting existing rows.

## Architecture

Keep the local SQLite store boundary and introduce one explicitly versioned migration; retain existing read defaults.

## Technical constraints

- Linux local filesystem and the supported SQLite runtime.
- Do not mutate application contracts or silently accept a future schema version.

## API / data contracts

- runs.archived_at: TEXT NULL; accepted values are ISO-8601 timestamps.
- Existing query defaults and run identifiers remain unchanged.

## Security considerations

Validate timestamp values and use bound SQL parameters. Migration must not broaden database file permissions or expose stored run contents.

## Risks and tradeoffs

- An additive nullable column preserves readers but requires an explicit compatibility check for old writers.
- Restoring a backup loses writes after the backup; stop writers for rollback.

## Data model changes

Add runs.archived_at TEXT NULL. Existing rows remain NULL; new values must be valid ISO-8601 timestamps.

## Migration strategy

Back up and verify the database; apply the additive migration atomically once; retain NULL for old rows; validate row counts and queries before enabling writers. On failure restore the verified backup.

## Rollback

Stop writers, restore the pre-upgrade database backup, and reopen with the previous supported binary after verifying integrity.

## Affected paths

- src/storage/migrations/add-archived-at.sql
- src/storage/run-record.ts

## Traceability

- ac-1: implement
- ac-2: implement

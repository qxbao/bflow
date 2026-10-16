# Required Red–Green–Refactor

Accepted specification: {{specification}}
Validated strategy: {{strategy}}
Existing phase evidence: {{evidence}}

1. Write tests from the specification's mapped acceptance criteria before changing
   implementation. Retain the source and test revisions and concrete test names.
2. Run the configured behavioral test commands. Verify a nonzero exit code due to
   missing target behavior. Compilation, dependency, setup, timeout or unrelated
   failures do not establish Red. Keep logs and test results.
3. Submit artifact proposals for logs/results to ArtifactStore. Only references
   returned by ArtifactStore may enter independent `VerificationResult` evidence.
   Record `metadata.conditionalTdd.phase = "red"` and `failureKind = "target_behavior"`.
   Runtime must call `assertReadyToImplement` before allowing implementation.
4. Implement the minimum behavior needed. Run the unchanged tests successfully and
   all required verification methods. Keep Green evidence on the implementation
   revision. Never weaken tests or replace their revision to manufacture Green.
5. Refactor as useful, review the result and rerun those tests and required checks.
   Retain a separate successful refactor receipt even when no cleanup was necessary.

For every phase, independent verification supplies commands, exit codes, criterion
observations, timestamps, distinct execution attempts, and distinct stored artifact
references. Bind the result to the run/task/spec/decision. Use `recordEvidence` and
persist its returned `TestStrategy` through the caller's existing persistence flow.
Do not interpret Herdr turn completion as task success. P17 still independently
checks artifact contents, revisions and acceptance; policy evidence is not acceptance.

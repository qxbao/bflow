# Provider failover implementation plan and ledger

Goal: fulfill the owner request in this session, including controlled-host continuation and fault recovery, without live provider inference or commits.

Specification: the original eleven requirements and acceptance/test matrix in the owner request; integration scope approved by the owner in this conversation. Conditional TDD decision: required for classification, scheduling, continuation and recovery logic because they are deterministic security-sensitive behavior. Tests must fail before the corresponding implementation. Documentation uses diff validation.

Architecture: retain Core task attempt/generation and immutable prior handles; represent each continuation as a new execution binding with an explicit supersession event. Runtime owns a validated private journal record and the switch budget before any side effect. Existing outbox intent, Registry lease/fence, host handover, platform preflight and Pane Manager process ownership remain authoritative.

Constraints: no commit/push/PR; no global provider settings; no automatic account expansion; no task success from failover; no synthetic atomic transaction across storage/Git/Herdr; uncertain launch/delivery/mutation blocks. Keep all implementer identities for independent verification. Changes stay in the approved integration worktree.

Review focus: fake quota text; late failure from an old execution; cancellation or human gate during awaited operations; crash after an allocation side effect; reused lease or native session; stale handover and worktree bytes; exhausted or cyclic chains; sensitive output in notices/audit.

- [x] 1. Contracts/Core: extend binding command/event with a bounded continuation record; validate old execution, attempt, cancellation and absence of a recorded result. Test event/checkpoint recovery and replay.
- [x] 2. Agent Providers: classify only validated structured native failure events. Distinguish explicit quota codes from HTTP 429; redact by projection, never retain raw errors. Test all six classes and forged task/pane text.
- [x] 3. CLI/platform: add optional role policy and exact candidate model/profile, preserve legacy config, include policy in existing resolution fingerprint. Preflight candidates with identical role/tool/permission constraints.
- [x] 4. Runtime: persist observation/intent, stop proof, handover selection, retirement, allocation intent, allocation/binding and continuation dispatch. Reconcile exact durable state at every phase; fail closed on ambiguous allocation or mutation. Bound retries, cooldown and switches durably.
- [x] 5. Host: authenticated failure ingress and provider-specific structured reader; select launch-local provider identity, reuse platform launch/Registry/outbox; send actionable Conversation notices and expose sanitized state.
- [x] 6. Tests/verification: controlled adapters through real Runtime/host, fault matrix, targeted and affected tests with a short TMPDIR and bounded workers; dependency and type checks. Fresh whole-branch review. Report exact commands/outcomes and remaining evidence limits.

Ledger: baseline bc234d1fa0a51dac02d8ea6dceb5c3525947e883, branch agent/runtime/provider-failover. Existing preliminary evaluator has 20 local passing tests but is not host wiring. Prior broad affected run was interrupted (130); isolated reruns passed and do not certify feature acceptance. Public contract/configuration scope is already owner-approved; do not ask again for that same scope.

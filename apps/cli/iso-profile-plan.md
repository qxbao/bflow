# Configured isolator profiles and setup parity

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

Extend `bflow iso` so an existing profile can be selected by `.bflow/config.yml` and used by all provider preflight and role launches.

```yaml
environment:
  defaults:
    codex:
      profile-name: work
    claude:
      profile-name: personal
    agy:
      profile-name: work
  roles:
    - role: coordinator
      cli: codex
      profile-name: lead
    - role: developer
      cli: codex
      profile-name: work
```

A role overrides its provider default. An omitted Developer role inherits the Coordinator's resolved provider/profile; an explicitly configured Developer uses its own selection. Switching to another provider never reuses the original provider's profile. Configuration without profile selection keeps existing behavior.

Only a safe profile name comes from YAML. Runtime resolves the trusted machine profile root and validates existing metadata, directories and containment before provider probes. Missing or invalid profiles block startup with a creation/login command; startup does not create accounts or fall back to the real user. Resolved profile identity is bound to readiness, launch and restart state. Linked Codex LB profiles use the same backend flags as the standalone isolator and still require authenticated execution readiness.

All version/help/auth/execution probes and final role launches use the selected HOME, XDG and native provider configuration. Inherited account credentials and configuration overrides are removed. Existing host hooks, permission checks, role skills and Gateway authorizations remain enforced. Profile selection does not grant new permissions or prove authentication.

Setup must keep native and iso tool configuration aligned. A reusable synchronizer handles MCP, instruction skills and Bflow-managed native plugin assets for existing profiles and future profile creation. It preserves profile auth, model, permissions, local tool entries and unrelated settings. Synchronization belongs to the setup plan/receipt/read-back flow; `--check` and `--dry-run` report drift without writing. Runtime continues to render the same approved role MCP/skills for native and profile launches.

Luna workers implement provider support, Runtime resolution and YAML/lifecycle wiring in separate worktrees. The parent reviews each diff, sends findings back to Luna and validates the combined implementation. Tests use temporary profiles, fake providers and local fixtures; no live account or model call is required for local acceptance.

Required verification includes profile precedence, provider fallback, distinct profiles for two roles of one provider, missing/removed profiles, symlink containment, linked-LB failure, dynamic Developer launches, native/iso MCP and skill parity after setup, idempotent sync and read-only setup checks. Run dependency/type checks, relevant package tests, full tests and diff/status checks; retain exact evidence and platform limits in the acceptance report.

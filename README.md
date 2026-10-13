# AI Flow SDLC

AI Flow SDLC is a module-first orchestration platform for coordinating AI coding agents across a software delivery workflow. This repository currently establishes stable contracts, package boundaries, validation, and parallel implementation ownership. It deliberately does not claim to contain working Herdr, SQLite, artifact, quality-gate, runtime, or CLI implementations yet.

## Requirements

- Node.js 22 or newer (LTS)
- pnpm 12.5.1

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm check:deps
pnpm check
```

See [`docs/architecture.md`](docs/architecture.md), [`docs/contracts.md`](docs/contracts.md), and [`AGENTS.md`](AGENTS.md) before implementing a package.

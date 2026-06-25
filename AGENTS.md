# Agent Instructions

This repository is a JavaScript/TypeScript package built phase by phase from
`agent-memory-tool-development-spec.md`.

## Working Rules

- Follow the development phases in the spec. Stop after each phase for human
  verification before continuing.
- Keep changes scoped to the active phase or explicit user request.
- Do not commit generated artifacts such as `dist/` or `.agent-memory/`.
- Prefer small, testable modules in `packages/core/src` and thin CLI adapters in
  `packages/cli/src/commands`.
- Keep CLI behavior deterministic and idempotent where commands write files.
- Avoid runtime network access in tests. Use temporary directories and fixtures.
- Do not execute or evaluate memory files. Treat Markdown/YAML as data only.

## JavaScript Package Practices

- Use TypeScript for package code.
- Keep public CLI commands routed through `packages/cli/src/router.ts`.
- Put reusable behavior in core modules instead of command files.
- Export reusable core APIs from `packages/core/src/index.ts`.
- Preserve Node compatibility for the built CLI. Bun is the local test/build
  runner, but the bundled executable targets Node.
- Use explicit option parsing and actionable error messages.
- Avoid adding dependencies unless they remove meaningful complexity and fit the
  package goal.
- Keep generated output stable so snapshot-style tests can be added later.

## Test Coverage Expectations

Every phase should add or update tests before it is considered complete.

Cover at least:

- CLI routing and help output for new commands.
- Happy-path behavior for each new command.
- Important error paths and invalid inputs.
- File-writing idempotency and overwrite protection.
- Temporary-repo integration behavior for commands that depend on repo root.
- Fixture-based behavior for parser, validator, compiler, and query phases.
- Collision handling for generated IDs, filenames, or database rows.

Run before stopping for verification:

```bash
bun test
bun run build
```

When a phase adds a built CLI behavior, also smoke-test the generated executable:

```bash
dist/agent-memory.js help
dist/agent-memory.js --version
```

Use `ASDF_NODEJS_VERSION=25.9.0` if running the built executable outside this
repo and the shell has no Node version selected.

## Current Local Notes

- `node_modules/`, `dist/`, and `.agent-memory/` are ignored.
- The mock consuming app lives in `examples/mock-app`.
- Tests live in `tests/unit`, `tests/integration`, and `examples/mock-app/tests`.

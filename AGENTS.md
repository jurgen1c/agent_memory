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

<!-- agent-memory:start -->
## Agent Memory Knowledge Base

Use the repo-memory skill or instruction file whenever it is available. This section is the repo-level fallback and requirement.

Durable repository knowledge lives in `docs/agent-memory/` and must stay versioned and reviewable. Generated memory lives in `.agent-memory/` and must not be committed.

Memory artifacts:

- `claims/`: atomic behavior, rules, constraints, workflows, risks, decisions, and deprecations.
- `graph/`: relationships between claim IDs, including dependencies, constraints, conflicts, and replacements.
- `indexes/`: watched files, default queries, tags, and claim globs for discoverability.
- `recipes/`: repeatable implementation, debugging, release, or review workflows.
- `waivers/`: reviewed exceptions for memory coverage checks.

### Agent-Memory-First Workflow

Before non-trivial work:

1. Run `bin/memory sync`.
2. Run `bin/memory context --task "<task>"`.
3. If files are known, run `bin/memory context --changed-files <file1> <file2>`.
4. If working from a diff, run `bin/memory context --git-diff`.
5. Use `bin/memory query`, `bin/memory show`, or `bin/memory system` for precise claims, graph links, recipes, or watched-file context.

For non-trivial work, cite the relevant claim IDs, system IDs, and verification commands in plans or PR notes.

After non-trivial work:

1. Update memory in the same change when durable repository knowledge changed.
2. Use `bin/memory templates list` and `bin/memory templates show <template>` before creating artifacts.
3. Run `bin/memory validate` and `bin/memory sync` before finishing changes that touch memory.

Update targets:

- Claims for changed behavior, interfaces, system boundaries, auth rules, dependencies, risks, or decisions.
- Graphs for changed triggers, handoffs, constraints, replacements, conflicts, or causal links.
- Indexes for changed route/job/model discoverability, watched files, default queries, or tags.
- Recipes for new or changed repeatable workflows.
- Waivers for intentional coverage exceptions with a reason and expiration.
<!-- agent-memory:end -->

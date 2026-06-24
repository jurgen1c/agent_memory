# Agent Memory

`agent-memory` is a repository-local CLI for maintaining durable, agent-readable memory from committed Markdown and YAML files. It gives coding agents a supported way to retrieve project context, update atomic claims, validate memory, and keep generated SQLite indexes out of source control.

The source of truth stays in the consuming repository:

- `docs/agent-memory/claims/**/*.md`
- `docs/agent-memory/graph/**/*.yaml`
- `docs/agent-memory/indexes/**/*.yaml`
- `docs/agent-memory/recipes/**/*.yaml`
- `docs/agent-memory/waivers/**/*.yaml`

The generated cache lives at `.agent-memory/memory.sqlite` by default and should not be committed.

## Requirements

- Node.js 25 or newer for the published CLI.
- Bun for developing this package repository.
- Git for repository root detection and diff-based commands.

## Quickstart

Install the package in a repository that should own its memory:

```bash
npm install --save-dev agent-memory
```

Initialize memory files, a `bin/memory` wrapper, and agent instructions:

```bash
npx agent-memory init --yes --package-manager npm --agent codex --install-hooks
```

For Bun-based applications:

```bash
bun add --dev agent-memory
bunx agent-memory init --yes --package-manager bun --agent codex --install-hooks
```

Compile and check the repository memory:

```bash
bin/memory sync
bin/memory doctor
```

Retrieve task context before editing code:

```bash
bin/memory context --task "fix student oauth"
bin/memory context --changed-files src/auth.js
bin/memory context --git-diff
```

When behavior changes, add or update memory before finishing:

```bash
bin/memory new claim --type fact --system auth --title "Student OAuth UID is tenant scoped"
bin/memory validate
bin/memory compile
bin/memory coverage --git-diff
```

## Command Reference

Use `agent-memory help <command>` for full usage and examples.

| Command | Purpose |
| --- | --- |
| `init` | Scaffold config, canonical memory folders, wrapper, gitignore entry, and optional agent skills/hooks. |
| `templates list` | List built-in claim templates. |
| `templates show claim:fact` | Print a built-in claim template. |
| `new claim` | Create one atomic claim from a template. |
| `validate` | Validate config, claims, graphs, indexes, recipes, and waivers. |
| `compile` | Build the repo-local SQLite cache from canonical memory. |
| `query` | Search compiled memory by text and metadata. |
| `show` | Show one claim and optionally graph-related claims. |
| `system` | Summarize claims, recipes, watched files, and graph activity for one system. |
| `context` | Build task-ready context from a task, changed files, or git diff. |
| `coverage` | Check whether changed watched files have related memory updates or waivers. |
| `doctor` | Check whether the compiled database exists, is fresh, and is compatible. |
| `sync` | Compile, validate, and doctor memory in one command. |
| `install-hooks` | Install non-blocking git hooks that run `bin/memory sync`. |
| `install-skill` | Install repository memory instructions under `.codex`, `.agents`, `.claude`, or a custom path. |
| `migrate-docs` | Plan or create starter memory drafts from existing repository docs. |
| `agent-manifest` | Print machine-readable command metadata and repo-specific paths for agents. |

Useful examples:

```bash
bin/memory query "student oauth tenant" --system auth
bin/memory show auth.student_oauth.uid_is_tenant_scoped --include-related
bin/memory system auth --json
bin/memory install-skill --agent codex --location .codex
bin/memory install-skill --agent codex --kind migration
bin/memory migrate-docs --from docs/legacy --system auth
bin/memory migrate-docs --from docs/legacy --system auth --automatic
bin/memory agent-manifest --json
```

## Claim Authoring Guide

Claims are Markdown files with YAML frontmatter. Keep one atomic claim per file. A good claim documents one behavior, rule, constraint, workflow, risk, decision, or deprecation that an agent should remember.

Create a starter claim with:

```bash
bin/memory new claim --type constraint --system auth --title "OAuth identity requires tenant context"
```

Then fill in the generated TODO values. Every durable claim should include:

- `id`: stable dotted identifier, usually `<system>.<slug>`.
- `type`: one of the supported claim templates, such as `fact`, `rule`, `constraint`, `workflow`, `risk`, `decision`, or `deprecation`.
- `system`: subsystem that owns the claim.
- `status`: `current`, `proposed`, `stale`, `deprecated`, `experimental`, `needs_verification`, `needs_review`, or `rejected`.
- `confidence`: `low`, `medium`, `high`, or `verified`.
- `severity`: `info`, `normal`, `important`, or `critical`.
- `claim`: the atomic statement agents should rely on.
- `source_files`: code or docs that support the claim.
- `verification`: concrete checks a future agent can run.
- `tags`: routing keywords for retrieval.

Use `current` for verified knowledge. Use `needs_verification` or `needs_review` for plausible but unverified memory. If code conflicts with memory, trust code and update or deprecate the claim.

## Graph Relationship Guide

Relationships live in `docs/agent-memory/graph/**/*.yaml`, not inside individual claim files. Graphs connect claims so context retrieval can include related constraints and cross-system dependencies.

Example:

```yaml
id: auth-tenancy
name: Auth and tenancy relationships
edges:
  - relation: requires
    source: auth.student_oauth.uid_is_tenant_scoped
    target: tenancy.current_tenant.required_for_student_auth
```

Supported relations include:

- `requires`: one claim depends on another.
- `constrains`: one claim limits how another can be implemented.
- `explains`: one claim gives background for another.
- `conflicts_with`: claims disagree and need review.
- `replaces`: newer knowledge supersedes older knowledge.
- `verifies`: one claim or check supports another.
- `same_area`: claims are related but not dependent.
- `causes`, `caused_by`, `blocks`, `unblocks`, `implemented_by`, `tested_by`.

Run `bin/memory validate` after editing graph files. Validation fails when graph edges reference missing claims.

## CI Integration

Run validation and compile on pull requests:

```yaml
name: Agent Memory

on:
  pull_request:

jobs:
  memory:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 25
      - run: npm install
      - run: npx agent-memory sync
      - run: npx agent-memory coverage --git-diff --base origin/main
```

If the repository uses the generated wrapper, prefer:

```bash
bin/memory sync
bin/memory coverage --git-diff --base origin/main
```

`coverage` exits with code `6` when a changed watched file has no related memory update or valid waiver.

## Migrating Existing Docs

Plan migration first:

```bash
bin/memory migrate-docs --from docs/legacy --system auth
```

Create starter drafts when you are ready:

```bash
bin/memory migrate-docs --from docs/legacy --system auth --automatic
```

Automatic drafts are `current`, low-confidence starter claims. Review them, split broad prose into atomic claims, add graph edges, and verify against code before treating them as stable memory.

## Package Development

Build the executable bundle:

```bash
bun run build
dist/agent-memory.js help
```

Run tests:

```bash
bun test
bun run test:coverage
```

Run the mock app memory flow:

```bash
repo_root=$(pwd)
tmpdir=$(mktemp -d)
cp -R examples/mock-app/. "$tmpdir"
git -C "$tmpdir" init
cd "$tmpdir"
"$repo_root/dist/agent-memory.js" validate
"$repo_root/dist/agent-memory.js" compile
"$repo_root/dist/agent-memory.js" query "oauth"
"$repo_root/dist/agent-memory.js" context --task "fix student oauth"
"$repo_root/dist/agent-memory.js" coverage --changed-files README.md
```

## Publishing and Versioning

This package follows semantic versioning:

- Major versions introduce incompatible CLI, config, schema, or memory format changes.
- Minor versions add backward-compatible commands, templates, schema fields, and retrieval behavior.
- Patch versions fix bugs, improve docs, or make backward-compatible validation/retrieval corrections.

Before publishing:

```bash
bun test
bun run build
npm pack --dry-run
```

Publishing is handled by the GitHub release workflow. Create a semver tag such as `v0.1.0`, publish a GitHub Release for that tag, and the workflow will test, build, dry-run the package, and run `npm publish --provenance` using `NPM_TOKEN`.

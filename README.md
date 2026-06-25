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
npm install --save-dev @jurgen1c/agent-memory-cli
```

Initialize memory files, a `bin/memory` wrapper, `AGENTS.md` guidance, and agent instructions:

```bash
npx agent-memory init --yes --package-manager npm --agent codex --install-hooks
```

For Bun-based applications:

```bash
bun add --dev @jurgen1c/agent-memory-cli
bunx @jurgen1c/agent-memory-cli init --yes --package-manager bun --agent codex --install-hooks
```

For a global CLI install:

```bash
npm install -g @jurgen1c/agent-memory-cli
agent-memory --help
```

### What `init` Creates

`init` bootstraps a repository so agents have a stable memory contract and local commands:

- `agent-memory.config.yaml`: memory paths, validation defaults, context defaults, and agent skill locations.
- `docs/agent-memory/`: canonical memory root with `claims/`, `graph/`, `indexes/`, `recipes/`, and `waivers/`.
- `bin/memory`: repository-local wrapper around the installed or globally available CLI.
- `.gitignore`: adds `.agent-memory/` so generated SQLite stays out of commits.
- `AGENTS.md`: creates or refreshes a managed Agent Memory section that points agents to the repo-memory skill, requires context lookup before non-trivial work, and requires memory updates when durable knowledge changes.
- Agent instructions: installs Codex and generic instructions by default, unless `--agent` narrows the target.
- Git hooks: installed only when `--install-hooks` is passed.

`init` is safe to rerun. Existing scaffold files are skipped unless `--force` is passed. Existing `AGENTS.md` content is preserved; only the managed `agent-memory` section is appended or refreshed.

Init options:

| Option | Meaning |
| --- | --- |
| `--yes`, `-y` | Run as a non-interactive setup command. |
| `--package-manager npm` | Generate `bin/memory` with an `npx agent-memory` fallback. |
| `--package-manager bun` | Generate `bin/memory` with a `bunx agent-memory` fallback. |
| `--agent codex` | Install only the Codex repo-memory skill. Repeat `--agent` to install multiple targets. |
| `--agent generic` | Install only the generic agent instruction file. |
| `--skill-location .agents` | Install the selected agent skill under `.agents/skills/repo-memory/SKILL.md` and write that path to config. Requires exactly one `--agent`. |
| `--install-hooks` | Install non-blocking git hooks that run `bin/memory sync` after checkout, merge, or rewrite. |
| `--force` | Overwrite existing scaffold files and hooks where supported. |

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

Open the local browser UI when you want to inspect memory visually:

```bash
bin/memory ui
```

The command prints a local URL with a session token. Open that URL in your browser and keep the command running while using the UI.

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
| `init` | Scaffold config, canonical memory folders, wrapper, gitignore entry, `AGENTS.md` guidance, and optional agent skills/hooks. |
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
| `upgrade` | Refresh generated config comments, managed `AGENTS.md` guidance, and agent skill files after package upgrades. |
| `install-hooks` | Install non-blocking git hooks that run `bin/memory sync`. |
| `ui` | Serve a local browser UI for inspecting and reviewing repository memory. |
| `install-skill` | Install repository memory instructions under `.codex`, `.agents`, `.claude`, or a custom path. |
| `migrate-docs` | Plan or create starter memory drafts from existing repository docs. |
| `agent-manifest` | Print machine-readable command metadata and repo-specific paths for agents. |

Command usage cheat sheet:

| Command | Required input | Useful flags |
| --- | --- | --- |
| `init` | None; use `--yes` for non-interactive setup. | `--package-manager npm`, `--package-manager bun`, `--agent codex`, `--agent generic`, `--skill-location <dir>`, `--install-hooks`, `--force` |
| `templates list` | None. | None. |
| `templates show` | Template name, such as `claim:fact`. | None. |
| `templates copy` | Template name and `--to <path>`. | `--force` |
| `new claim` | `--type`, `--system`, and `--title`, unless using `--interactive`. | `--id`, `--source-file`, `--claim`, `--verification-step`, `--severity`, `--force` |
| `validate` | None. | `--json`, `--strict`, `--changed-files <files...>` |
| `compile` | None. | `--db <path>`, `--json`, `--verbose` |
| `query` | Search text. | `--system`, `--status`, `--limit`, `--include-stale`, `--json` |
| `show` | Claim ID. | `--include-related`, `--depth <n>`, `--json` |
| `system` | System ID, such as `auth`. | `--json` |
| `context` | One of `--task`, `--changed-files`, or `--git-diff`. | `--budget small`, `--budget medium`, `--budget full`, `--depth <n>`, `--include-inferred`, `--no-include-inferred`, `--json` |
| `coverage` | `--changed-files` or `--git-diff`. | `--base <ref>` with `--git-diff`, `--json` |
| `doctor` | None. | `--json` |
| `sync` | None. | `--json` |
| `upgrade` | None. Dry-run by default. | `--write`, `--force`, `--json` |
| `install-hooks` | None. | `--force`, `--json` |
| `ui` | None. | `--host <host>`, `--port <port>`, `--json` |
| `install-skill` | `--agent codex` or `--agent generic`. | `--kind repo`, `--kind migration`, `--location <dir>`, `--path <file>`, `--force`, `--json` |
| `migrate-docs` | `--from <path-to-docs>` and `--system <system>`. | `--automatic`, `--force`, `--json` |
| `agent-manifest` | None. | `--json` |

Useful examples:

```bash
bin/memory query "student oauth tenant" --system auth
bin/memory show auth.student_oauth.uid_is_tenant_scoped --include-related
bin/memory system auth --json
bin/memory ui --port 0
bin/memory init --yes --agent codex --skill-location .agents
bin/memory install-skill --agent codex --location .codex
bin/memory install-skill --agent codex --kind migration
bin/memory migrate-docs --from docs/legacy --system auth
bin/memory migrate-docs --from docs/legacy --system auth --automatic
bin/memory upgrade --write
bin/memory agent-manifest --json
```

## Local Web UI

The UI is a local developer tool for browsing and reviewing canonical memory files. It is not a hosted service.

Start it from the repository that owns the memory:

```bash
bin/memory ui
```

By default the server binds to `127.0.0.1:4317`. If the port is busy, it automatically tries the next available port. Use `--port 0` to request an ephemeral port:

```bash
bin/memory ui --port 0
bin/memory ui --host 127.0.0.1 --port 4317
bin/memory ui --json
```

The command prints:

- URL: browser URL with the session token in the query string.
- Session token: required for write actions such as review updates and sync.
- Static assets: packaged UI asset location.

Keep the process running while the browser is open. The UI serves only from the local machine by default; do not bind it to a public interface unless you understand the exposure.

The UI includes:

- Graph view: pan, zoom, drag, minimap, claim nodes, explicit graph edges, optional inferred/recipe/replacement relations, filters, and search.
- File view: tree rooted at `memory_root`, including claims, graph files, indexes, recipes, and waivers.
- Detail drawer: claim metadata, Markdown body, related claims, source files, tags, review controls, and copy helpers.
- Review queue: claims sorted by review risk, including `needs_review`, `needs_verification`, `proposed`, migrated low-confidence claims, stale claims, and deprecated claims.
- Health banner: validation errors, doctor warnings, missing or stale database state, and sync status.

Review actions update only claim frontmatter and preserve the Markdown body plus unknown frontmatter fields. `Approve` sets:

```yaml
status: current
confidence: high
```

The status dropdown can also set `proposed`, `stale`, `deprecated`, `experimental`, `needs_verification`, `needs_review`, or `rejected`. After a write, the server validates memory immediately and recompiles the SQLite cache when validation passes.

If the health banner says the database is missing or stale, click `Sync` in the UI or run:

```bash
bin/memory sync
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

Use `migrate-docs` when a repository already has human-written docs that should become reviewable `agent-memory` claims.

Usage:

```bash
bin/memory migrate-docs --from <path-to-docs> --system <system> [--automatic] [--force] [--json]
```

Required arguments:

| Argument | Meaning |
| --- | --- |
| `--from <path-to-docs>` | File or directory to scan for existing docs. The command reads `.md`, `.markdown`, `.mdx`, and `.txt` files. |
| `--system <system>` | Memory system namespace for generated claim IDs and paths, such as `auth`, `billing`, or `search`. Use lowercase letters, numbers, and underscores only. |

A system is the durable memory namespace for the claims being created. It is usually the subsystem or domain the docs describe, not the source folder name unless that folder is already meaningful. For broad canonical docs, `--system docs` or `--system platform` may be appropriate; for focused docs, use a subsystem like `auth`, `billing`, or `search`. The value becomes part of generated IDs and paths, such as `docs.migrated_canonical` and `docs/agent-memory/claims/docs/`.

Optional flags:

| Flag | Meaning |
| --- | --- |
| `--automatic` | Write starter claim drafts instead of only printing a plan. `--auto` is accepted as an alias. |
| `--force` | In automatic mode, overwrite existing generated draft files. Without it, existing files are skipped. |
| `--json` | Print machine-readable output for scripts or agent workflows. |

Plan migration first. Plan mode does not write files:

```bash
bin/memory migrate-docs --from docs/legacy --system auth
```

For canonical repository docs, a docs namespace is often a good first pass:

```bash
bin/memory migrate-docs --from docs/canonical --system docs --automatic
```

The plan lists each source doc, suggested claim ID, and target path. For example, `docs/legacy/oauth.md` under `--system auth` may plan a draft like:

```text
docs/agent-memory/claims/auth/migrated_oauth.md
id: auth.migrated_oauth
```

Create starter drafts when you are ready. Automatic mode writes files under the configured memory root:

```bash
bin/memory migrate-docs --from docs/legacy --system auth --automatic
```

Automatic drafts are `current`, low-confidence starter claims. Review them, split broad prose into atomic claims, add graph edges, and verify against code before treating them as stable memory. Automatic mode only writes drafts for docs inside the repository; use plan mode for external docs, then copy the source docs into the repo before creating drafts.

## Package Development

Build the executable bundle:

```bash
bun run build
dist/agent-memory.js help
```

Run tests:

```bash
bun run audit
bun run lint
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

Run the web UI against a temporary copy of the mock app:

```bash
bun run ui:mock
```

The script builds the package, copies `examples/mock-app` to `/tmp`, seeds one proposed claim for the review queue, and starts `agent-memory ui --port 0`. Use `bun run ui:mock -- --clean` to skip the seeded review item or `bun run ui:mock -- --no-build` to reuse the existing build.

## Publishing and Versioning

See [docs/releasing.md](docs/releasing.md) for the full release checklist.

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

Publishing is handled by the GitHub release workflow and should only happen from semver releases, not normal pushes. Use `npm version patch`, `npm version minor`, or `npm version major` to update `package.json` and create the matching `vX.Y.Z` tag. Push the commit and tag, then publish a GitHub Release for that tag. Pushing a tag alone does not run the publish workflow.

The first manual publish for the scoped package must use public access:

```bash
npm publish --access public
```

The workflow verifies that the release tag matches the package version, then tests, builds, dry-runs the package, and runs `npm publish --provenance --access public`. Configure npm Trusted Publishing for the `@jurgen1c/agent-memory-cli` package so the workflow can publish without an `NPM_TOKEN` secret.

# Agent Memory

`agent-memory` is a repository-local CLI for maintaining durable, agent-readable memory from committed Markdown and YAML files. It gives coding agents a supported way to retrieve project context, update atomic claims, validate memory, and keep generated SQLite indexes out of source control.

The source of truth stays in the consuming repository:

- `docs/agent-memory/claims/**/*.md`
- `docs/agent-memory/graph/**/*.yaml`
- `docs/agent-memory/indexes/**/*.yaml`
- `docs/agent-memory/recipes/**/*.yaml`
- `docs/agent-memory/plans/**/*.yaml`
- `docs/agent-memory/profiles/**/*.yaml`
- `docs/agent-memory/waivers/**/*.yaml`

Fresh initialization uses a user-local global SQLite cache resolved from the committed `memory_key` and checkout identity. Explicit `--local` compatibility mode uses `.agent-memory/memory.sqlite`. Neither cache should be committed.
Generated one-off plan runs live under `.agent-memory/plans/` and should not be committed unless they are explicitly promoted into reusable plan templates.

## API and Architecture

The package exports Agent Memory's public library API with generated TypeScript
declarations:

```ts
import {
  buildContext,
  loadConfig,
  openSqliteDatabase
} from "@jurgen1c/agent-memory-cli";
```

Agent Memory depends on `@jurgen1c/agent-core` for strict YAML parsing,
repository and path safety, and portable SQLite. Generic recipes and plan
templates remain part of Agent Memory's own contextual-memory model.

## Requirements

- Node.js 25.9.0 or newer for the published CLI. This repository develops and
  smoke-tests with Node.js 26.7.0.
- Bun for developing this package repository.
- Git for repository root detection and diff-based commands.

## Quickstart

Install the CLI once, then run it from a Git repository that should own its
memory:

```bash
npm install -g @jurgen1c/agent-memory-cli
agent-memory --version
cd /path/to/repository
agent-memory init --yes --agent codex --install-hooks
```

Fresh `init` uses global storage by default and does not require a repository-local
package install or `bin/memory` wrapper. Build the generated cache, verify it,
and retrieve context with the same global command:

```bash
agent-memory compile
agent-memory sync
agent-memory doctor
agent-memory context --task "fix student oauth"
agent-memory context --changed-files src/auth.js
agent-memory context --git-diff
```

`compile` rebuilds the configured SQLite cache from canonical files. `sync`
compiles, validates, and runs the repository health checks; `doctor` only checks
the current cache and reports how to repair missing, stale, or incompatible
state. Retrieval commands require that generated cache, so run `sync` after
initialization, pulls, checkouts, rebases, or canonical memory changes.

### Local and Wrapper Compatibility

Use a wrapper when repository scripts or multiple contributors still need the
stable `bin/memory` entry point while storage remains global:

```bash
agent-memory init --yes --wrapper --agent codex --install-hooks
bin/memory sync
```

Use local compatibility mode only when the repository must retain the version 1
repo-local package/cache workflow:

```bash
npm install --save-dev @jurgen1c/agent-memory-cli
npx agent-memory init --yes --local --agent codex --install-hooks
bin/memory sync
```

`--wrapper` and `--local` are different: `--wrapper` adds the command shim but
keeps `database_scope: global`; `--local` writes a version 1 local config and
uses `.agent-memory/memory.sqlite`. Generated wrappers prefer a repo-local CLI,
then the installed global command, and use the package-manager fallback only
when allowed. Existing custom wrappers are preserved for manual review.

### What `init` Creates

`init` bootstraps a repository so agents have a stable memory contract and local commands:

- `agent-memory.config.yaml`: memory paths, validation defaults, context defaults, and agent skill locations.
- `docs/agent-memory/`: canonical memory root with `claims/`, `graph/`, `indexes/`, `recipes/`, `plans/`, `profiles/`, and `waivers/`.
- Optional `bin/memory`: repository-local wrapper created only by `--wrapper` or fresh `--local` compatibility mode.
- `.gitignore`: adds `.agent-memory/` so generated SQLite stays out of commits.
- Repository instruction files: creates or refreshes a managed Agent Memory section in `AGENTS.md` by default, or one or more files selected by repeating `--instructions-file`.
- Agent instructions: installs Codex and generic instructions by default, unless `--agent` narrows the target.
- Git hooks: installed only when `--install-hooks` is passed.

`init` is safe to rerun. Existing scaffold files are skipped unless `--force` is passed. Existing repository instructions are preserved; only the managed `agent-memory` section is appended or refreshed. Selected instruction paths are saved under `agent_instructions.paths` so `upgrade --write` refreshes every configured file. Upgrade migrates the legacy singular `agent_instructions.path` setting.

Init options:

| Option | Meaning |
| --- | --- |
| `--yes`, `-y` | Run as a non-interactive setup command. |
| `--local` | Create a fresh version 1 local-mode config and `bin/memory` wrapper. Existing version 2 configs remain version 2 when deliberately switched local with `--force`. |
| `--wrapper` | Create `bin/memory` while retaining global storage mode. |
| `--memory-key <key>` | Override the stable global memory key derived offline from the repository identity. |
| `--package-manager npm` | Use an `npx agent-memory` fallback when a wrapper is requested. |
| `--package-manager bun` | Use a `bunx agent-memory` fallback when a wrapper is requested. |
| `--agent codex` | Install only the Codex repo-memory skill. Repeat `--agent` to install multiple targets. |
| `--agent generic` | Install only the generic agent instruction file. |
| `--skill-location .agents` | Install the selected agent skill under `.agents/skills/repo-memory/SKILL.md` and write that path to config. Requires exactly one `--agent`. |
| `--instructions-file CLAUDE.md` | Append managed repository guidance to this file and persist it for upgrades. Repeat the option to manage files such as both `AGENTS.md` and `CLAUDE.md`. |
| `--install-hooks` | Install configured non-blocking git hooks that resolve the repository root before using `agent-memory`, or `bin/memory` when that wrapper is readable and executable. |
| `--force` | Overwrite existing scaffold files and hooks where supported. |

### Migrate an Existing Local Install

Existing version 1 repositories remain in local wrapper mode until migration is explicitly requested. Preview the migration first:

```bash
agent-memory upgrade --global
```

Apply it with:

```bash
agent-memory upgrade --global --write
```

The migration derives a stable `memory_key` from repository identity, or accepts
`--memory-key <key>` to override key derivation. Global registry safety still
requires a supported credential-free repository identity; an explicit key does
not bypass that validation. It refreshes managed instruction sections,
generated agent skills, and installed generated hooks to use `agent-memory`;
missing hooks stay uninstalled. Custom skills and hooks are preserved unless
`--force` is passed. The local SQLite cache and `bin/memory` are never removed;
output classifies the wrapper as generated, custom, or missing and reports
whether manual cleanup is safe after these commands succeed:

```bash
agent-memory sync
agent-memory doctor
```

Writes are rolled back if migration fails so the prior local configuration
remains usable.

### Global Storage and Source-of-Truth Boundaries

A global-mode config commits portable identity and policy, never a user-specific
cache path:

```yaml
version: 2
memory_key: example-project
database_scope: global
database_path: .agent-memory/memory.sqlite
```

- `memory_key` is the stable repository memory identifier. Clones share it, but
  each checkout gets an isolated generated database. Use lowercase letters,
  digits, dots, underscores, and hyphens; do not put paths or credentials in it.
- `database_scope` is `global` or `local`. In global mode, `database_path` is
  retained only as the local-mode fallback and is not the effective cache path.
- `AGENT_MEMORY_HOME` optionally selects an absolute, private global home. The
  default is `<user-home>/.agent-memory`.
- Global generated state lives at `<global-home>/registry.json` and
  `<global-home>/databases/<memory-key>/<checkout-fingerprint>/memory.sqlite`.

Canonical Markdown/YAML under `docs/agent-memory/` and
`agent-memory.config.yaml` remain the source of truth. Global SQLite databases,
`registry.json`, registry locks, SQLite sidecars, `.agent-memory/`, and generated
plan runs are rebuildable user-local state: do not commit or synchronize them.
Registry maintenance never deletes canonical repository memory or custom
wrappers.

### Global Install Troubleshooting

- **`agent-memory: command not found`:** confirm `node --version` is at least
  25.9.0, reinstall with `npm install -g @jurgen1c/agent-memory-cli`, and ensure
  the executable directory for `npm config get prefix` is on `PATH`. Until that
  is fixed, an existing usable `bin/memory` wrapper can remain the entry point.
- **Compiled database is missing:** from the repository root, run
  `agent-memory sync` (or `agent-memory compile` followed by
  `agent-memory doctor`). The database is generated; do not copy an old local
  SQLite file into global home.
- **Registry reports stale paths:** run `agent-memory registry doctor`, preview
  `agent-memory registry prune`, verify every listed checkout is actually gone
  or moved, then run `agent-memory registry prune --force`.
- **Repository moved:** run `agent-memory sync` from the new root to create its
  new checkout-specific cache. Then use the registry doctor/prune preview before
  removing the old stale mapping; Agent Memory never reuses or deletes it
  automatically.
- **Duplicate or colliding `memory_key`:** do not prune an active checkout to
  hide the collision. Give one unrelated repository a distinct committed
  `memory_key`, then run `agent-memory sync`. Use
  `agent-memory registry list` and `agent-memory registry show <memory-key>` to
  confirm which roots and repository identities are involved.
- **Custom wrapper during migration:** `upgrade --global --write` preserves it.
  Review the wrapper manually and keep using it if needed; remove or revise it
  only after global `sync` and `doctor` pass. `--force` is for eligible custom
  generated support files and does not make an unknown wrapper safe to delete.

### Claim Relevance and Source Policy

Generated repository guidance and skills include a memory-worthiness gate. A new claim should normally be repository-specific, future-relevant, durable, consequential if forgotten, and evidence-backed. Agents are told to search existing memory first and not create claims merely because code changed or coverage reported a gap.

Use repo-relative globs to control which files can support claims:

```yaml
claim_sources:
  allow:
    - app/**
    - config/**
  deny:
    - app/generated/**
    - vendor/**
```

An empty `allow` list permits every repository path. `deny` always wins. The policy applies to claim `source_files` and `related_files`; excluded changed files are ignored by claim coverage. Existing claims that reference newly excluded paths must be updated or removed before validation and compilation pass.

Compile and check the repository memory:

```bash
agent-memory sync
agent-memory doctor
```

Retrieve task context before editing code:

```bash
agent-memory context --task "fix student oauth"
agent-memory context --changed-files src/auth.js
agent-memory context --git-diff
```

When a repository has workflow memory, `context` can also include matched recipes, plan-stage context, and task-specific profile traits:

```bash
agent-memory recipes search "student oauth"
agent-memory plans suggest --task "change student oauth provider"
agent-memory plans new --template plan_template.auth.oauth_change --task "change student oauth provider"
agent-memory context --plan plan_run.20260702.oauth_change.1234abcd --stage inspect
agent-memory profiles match --task "review auth changes" --changed-files src/auth.js
```

Open the local browser UI when you want to inspect memory visually:

```bash
agent-memory ui
```

The command prints a local URL with a session token. Open that URL in your browser and keep the command running while using the UI.

When behavior changes, add or update memory before finishing:

```bash
agent-memory new claim --type fact --system auth --title "Student OAuth UID is tenant scoped"
agent-memory new recipe --system auth --title "Modify OAuth safely"
agent-memory validate
agent-memory compile
agent-memory coverage --git-diff
agent-memory audit --git-diff
```

## Command Reference

Use `agent-memory help <command>` for full usage and examples.

| Command | Purpose |
| --- | --- |
| `init` | Scaffold config, canonical memory folders, optional wrapper, gitignore entry, configurable repository guidance, and optional agent skills/hooks. |
| `templates list` | List built-in claim templates. |
| `templates show claim:fact` | Print a built-in claim template. |
| `new claim` | Create one low-confidence atomic claim draft in `needs_review`. |
| `new recipe` | Create one first-class YAML recipe draft in `needs_review`. |
| `validate` | Validate config, claims, graphs, indexes, recipes, plans, profiles, and waivers. |
| `compile` | Build the configured local or user-global SQLite cache from canonical memory. |
| `query` | Search compiled memory by text and metadata. |
| `show` | Show one claim and optionally graph-related claims. |
| `system` | Summarize claims, recipes, watched files, and graph activity for one system. |
| `recipes` | List, search, and show reusable workflow recipes. |
| `plans` | Search plan templates and manage generated local plan runs. |
| `profiles` | List, inspect, and match task-specific profile traits. |
| `context` | Build task-ready context from a task, changed files, or git diff. |
| `coverage` | Check whether changed watched files have related memory updates or waivers. |
| `audit` | Audit changed memory for deterministic stale-claim risks. |
| `doctor` | Check whether the compiled database exists, is fresh, and is compatible. |
| `sync` | Compile, validate, and doctor memory in one command. |
| `upgrade` | Refresh generated support files after package upgrades, or migrate local wrapper mode with `--global`. |
| `install-hooks` | Install the hooks configured under `git.hooks`; each resolves the repository root and non-blockingly runs the available `agent-memory` command or wrapper. |
| `ui` | Serve a local browser UI for inspecting and reviewing repository memory. |
| `install-skill` | Install repository memory instructions under `.codex`, `.agents`, `.claude`, or a custom path. |
| `migrate-docs` | Plan or create starter memory drafts from existing repository docs. |
| `agent-manifest` | Print machine-readable command metadata and repo-specific paths for agents. |

Command usage cheat sheet:

| Command | Required input | Useful flags |
| --- | --- | --- |
| `init` | None; use `--yes` for non-interactive setup. | `--local`, `--wrapper`, `--memory-key <key>`, `--package-manager npm`, `--package-manager bun`, `--agent codex`, `--agent generic`, `--skill-location <dir>`, `--install-hooks`, `--force` |
| `templates list` | None. | None. |
| `templates show` | Template name, such as `claim:fact`. | None. |
| `templates copy` | Template name and `--to <path>`. | `--force` |
| `new claim` | `--type`, `--system`, and `--title`, unless using `--interactive`. | `--id`, `--source-file`, `--claim`, `--verification-step`, `--severity`, `--force` |
| `validate` | None. | `--json`, `--strict`, `--changed-files <files...>` |
| `compile` | None. | `--db <path>`, `--json`, `--verbose` |
| `query` | Search text. | `--system`, `--status`, `--limit`, `--include-stale`, `--json` |
| `show` | Claim ID. | `--include-related`, `--depth <n>`, `--json` |
| `system` | System ID, such as `auth`. | `--json` |
| `recipes list` | None. | `--include-inactive`, `--json` |
| `recipes search` | Search text. | `--changed-files <files...>`, `--limit <n>`, `--include-inactive`, `--json` |
| `recipes show` | Recipe ID. | `--json` |
| `plans templates list` | None. | `--json` |
| `plans templates show` | Plan template ID. | `--json` |
| `plans suggest` | `--task <task>`. | `--json` |
| `plans new` | `--task <task>`, with optional `--template <id>`. | `--json` |
| `plans show` | Plan run ID. | `--json` |
| `plans next` | Plan run ID. | `--json` |
| `plans complete-stage` | Plan run ID, `--stage <id>`, and `--evidence <text>`. | `--allow-empty-evidence`, `--json` |
| `plans block-stage` | Plan run ID, `--stage <id>`, and `--reason <text>`. | `--json` |
| `plans finish` | Plan run ID. | `--confirm-unresolved`, `--archive`, `--abandon-blocked`, `--reason <text>`, `--json` |
| `plans prune` | A selector such as `--completed`, `--abandoned`, or `--include-blocked`. | `--older-than <age>`, `--dry-run`, `--json` |
| `plans promote` | Plan run ID and `--to-template`. | `--system <system>`, `--title <title>`, `--finish-after-promote`, `--json` |
| `profiles list` | None. | `--include-inactive`, `--json` |
| `profiles show` | Profile trait ID. | `--json` |
| `profiles match` | Task, changed files, recipe, system, alias, or explicit trait. | `--task <task>`, `--changed-files <files...>`, `--recipe <id>`, `--system <system>`, `--profile <alias>`, `--profile-trait <id>`, `--json` |
| `context` | One of `--task`, `--changed-files`, `--git-diff`, `--recipe`, or `--plan`. | `--stage <id>`, `--profile <alias>`, `--profile-trait <id>`, `--budget small`, `--budget medium`, `--budget full`, `--depth <n>`, `--include-inferred`, `--no-include-inferred`, `--json` |
| `coverage` | `--changed-files` or `--git-diff`. | `--base <ref>` with `--git-diff`, `--json` |
| `audit` | `--changed-files` or `--git-diff`. | `--base <ref>` with `--git-diff`, `--strict`, `--json` |
| `doctor` | None. | `--json` |
| `sync` | None. | `--json` |
| `upgrade` | None. Dry-run by default. | `--write`, `--force`, `--json`, `--global`, `--memory-key <key>` |
| `install-hooks` | None. | `--force`, `--json` |
| `ui` | None. | `--host <host>`, `--port <port>`, `--json` |
| `install-skill` | `--agent codex` or `--agent generic`. | `--kind repo`, `--kind migration`, `--location <dir>`, `--path <file>`, `--force`, `--json` |
| `migrate-docs` | `--from <path-to-docs>` and `--system <system>`. | `--automatic`, `--force`, `--json` |
| `agent-manifest` | None. | `--json` |

Useful examples:

```bash
agent-memory query "student oauth tenant" --system auth
agent-memory show auth.student_oauth.uid_is_tenant_scoped --include-related
agent-memory system auth --json
agent-memory recipes search "student oauth"
agent-memory context --recipe recipe.auth.modify_student_oauth
agent-memory plans suggest --task "change student oauth provider"
agent-memory plans next plan_run.20260702.oauth_change.1234abcd
agent-memory plans finish plan_run.20260702.oauth_change.1234abcd --confirm-unresolved
agent-memory profiles match --task "review auth changes" --profile review
agent-memory context --task "review auth changes" --profile review
agent-memory ui --port 0
agent-memory init --yes --agent codex --skill-location .agents
agent-memory install-skill --agent codex --location .codex
agent-memory install-skill --agent codex --kind migration
agent-memory migrate-docs --from docs/legacy --system auth
agent-memory migrate-docs --from docs/legacy --system auth --automatic
agent-memory upgrade --write
agent-memory upgrade --global --write
agent-memory agent-manifest --json
```

## Contextual Workflow Guide

Contextual workflows layer reusable procedures, staged work plans, and task-specific guidance on top of claims and graph relationships. They are optional: repositories without recipes, plans, or profiles still use the same claim retrieval commands.

### Recipes

Recipes are reusable workflow procedures stored under `docs/agent-memory/recipes/**/*.yaml`. Use them for repeatable project work such as "modify student OAuth", "add a billing webhook", or "review a migration".

```bash
agent-memory recipes search "student oauth"
agent-memory recipes show recipe.auth.modify_student_oauth
agent-memory context --recipe recipe.auth.modify_student_oauth
```

`context --task` automatically includes matching recipes when they are relevant. Recipe `required_claims` are pulled into context so the agent does not need a second lookup for the constraints that make the recipe safe to follow.

### Plans

Plan templates are reusable staged workflows stored under `docs/agent-memory/plans/**/*.yaml`. Plan runs are local generated state stored under `.agent-memory/plans/`.

```bash
agent-memory plans suggest --task "change student oauth provider"
agent-memory plans new --template plan_template.auth.oauth_change --task "change student oauth provider"
agent-memory plans next plan_run.20260702.oauth_change.1234abcd
agent-memory context --plan plan_run.20260702.oauth_change.1234abcd --stage inspect
```

Use plan runs for multi-step work where each stage needs different claims, recipes, files, and verification. Complete or block stages as work progresses:

```bash
agent-memory plans complete-stage plan_run.20260702.oauth_change.1234abcd --stage inspect --evidence "Reviewed callback contract"
agent-memory plans block-stage plan_run.20260702.oauth_change.1234abcd --stage implement --reason "Waiting on provider docs"
```

Finish plan runs when they are done, and prune old local runs so `.agent-memory/plans` does not accumulate stale state:

```bash
agent-memory plans finish plan_run.20260702.oauth_change.1234abcd --confirm-unresolved
agent-memory plans finish plan_run.20260702.oauth_change.1234abcd --abandon-blocked --reason "Provider change was cancelled"
agent-memory plans prune --completed --older-than 7d
```

Do not commit `.agent-memory/plans` files. If a one-off run becomes a reusable workflow, promote it into a proposed canonical template:

```bash
agent-memory plans promote plan_run.20260702.oauth_change.1234abcd --to-template --system auth --title "OAuth provider behavior change"
```

### Profiles

Profile traits are small pieces of task-specific guidance stored under `docs/agent-memory/profiles/**/*.yaml`. Use them for guidance that depends on intent, changed files, systems, recipes, plan templates, or profile aliases such as `review`.

```bash
agent-memory profiles match --task "review auth changes" --changed-files src/auth.js
agent-memory profiles show profile_trait.review.findings_first
agent-memory context --task "review auth changes" --profile review
```

Profile traits are context, not instruction hierarchy. Treat them as repository guidance below system, developer, user, and local `AGENTS.md` instructions.

## Local Web UI

The UI is a local developer tool for browsing and reviewing canonical memory files. It is not a hosted service.

Start it from the repository that owns the memory:

```bash
agent-memory ui
```

By default the server binds to `127.0.0.1:4317`. If the port is busy, it automatically tries the next available port. Use `--port 0` to request an ephemeral port:

```bash
agent-memory ui --port 0
agent-memory ui --host 127.0.0.1 --port 4317
agent-memory ui --json
```

The command prints:

- URL: browser URL with the session token in the query string.
- Session token: required for write actions such as review updates and sync.
- Static assets: packaged UI asset location.

Keep the process running while the browser is open. The UI serves only from the local machine by default; do not bind it to a public interface unless you understand the exposure.

The UI includes:

- Graph view: pan, zoom, drag, minimap, claim nodes, explicit graph edges, optional inferred/recipe/replacement relations, filters, and search.
- File view: tree rooted at `memory_root`, including claims, graph files, indexes, recipes, plans, profiles, and waivers.
- Detail drawer: claim metadata, Markdown body, related claims, source files, tags, review controls, and copy helpers.
- Review queue: claims sorted by review risk, including `needs_review`, `needs_verification`, `proposed`, migrated low-confidence claims, stale claims, and deprecated claims.
- Workflows: recipe, plan template, profile trait, and local plan-run summaries, with token-protected edits for workflow metadata and plan-stage updates.
- Health banner: validation errors, doctor warnings, missing or stale database state, and sync status.

Review actions update only claim frontmatter and preserve the Markdown body plus unknown frontmatter fields. `Approve` sets:

```yaml
status: current
confidence: high
```

The status dropdown can also set `proposed`, `stale`, `deprecated`, `experimental`, `needs_verification`, `needs_review`, or `rejected`. After a write, the server validates memory immediately and recompiles the SQLite cache when validation passes.

If the health banner says the database is missing or stale, click `Sync` in the UI or run:

```bash
agent-memory sync
```

## Claim Authoring Guide

Claims are Markdown files with YAML frontmatter. Keep one atomic claim per file. A good claim documents one behavior, rule, constraint, workflow, risk, decision, or deprecation that an agent should remember.

Create a starter claim with:

```bash
agent-memory new claim --type constraint --system auth --title "OAuth identity requires tenant context"
```

New claims are deliberately created with `status: needs_review` and `confidence: low`. Fill in every generated TODO value, run the verification steps, and only then promote the claim to `current`. Validation rejects TODO placeholders in current claims.

Every durable claim should include:

- `id`: stable dotted identifier, usually `<system>.<slug>`.
- `type`: one of the supported claim templates, such as `fact`, `rule`, `constraint`, `workflow`, `risk`, `decision`, or `deprecation`.
- `system`: subsystem that owns the claim.
- `status`: `current`, `proposed`, `stale`, `deprecated`, `experimental`, `needs_verification`, `needs_review`, or `rejected`.
- `confidence`: `low`, `medium`, `high`, or `verified`.
- `severity`: `info`, `normal`, `important`, or `critical`.
- `claim`: the atomic statement agents should rely on.
- `source_files`: code or docs that support the claim.
- `verification`: concrete checks a future agent can run.
- `last_verified_commit`: the full tested Git commit object ID, or `null` until verification is complete; movable refs such as branches and `HEAD` are invalid.
- `tags`: routing keywords for retrieval.

Use `current` for checked knowledge. Use `needs_verification` or `needs_review` for plausible but unverified memory. `confidence: verified` requires a recorded `last_verified_commit`. Audit warns when a claim's supporting files changed after that commit. If code conflicts with memory, trust code and update or deprecate the claim.

Create reusable procedures as first-class recipes:

```bash
agent-memory new recipe \
  --system auth \
  --title "Modify OAuth safely" \
  --trigger "change oauth" \
  --source-file src/auth.js \
  --step "Inspect current identity resolution." \
  --verification-step "bun test"
```

Recipe scaffolding also starts in `needs_review`. Replace TODO values before promotion to `current`; validation rejects TODO placeholders in current recipes. The legacy `claim:recipe` template remains compatibility-only.

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

Run `agent-memory validate` after editing graph files. Validation fails when graph edges reference missing claims.

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
          node-version: 25.9.0
      - run: npm install -g @jurgen1c/agent-memory-cli
      - run: agent-memory sync
      - run: agent-memory coverage --git-diff --base origin/main
      - run: agent-memory audit --git-diff --base origin/main
```

If the repository uses the generated wrapper, prefer:

```bash
bin/memory sync
bin/memory coverage --git-diff --base origin/main
bin/memory audit --git-diff --base origin/main
```

`coverage` exits with code `6` when a changed watched file has no related memory update or valid waiver.
`audit` exits with code `6` for error findings. Shared routes, shared symbols, and same-system claims with at least two shared `source_files` are strong overlap signals and require review. Shared source or related files are warnings, while tag-only overlap is informational. Any semantically accurate explicit graph relationship records that an overlap pair was reviewed; invalid `deprecated_by` references and unresolved active conflicts remain blocking. A recorded `last_verified_commit` must be a full immutable commit object ID that resolves to a commit, and audit warns when referenced source files changed afterward.

With `--git-diff`, audit compares overlap findings with the resolved base revision and reports new or more severe pairs. Use `--strict` to retain the legacy behavior that blocks every overlap, accepts only `replaces` or `conflicts_with` as graph review decisions, blocks `source.related_claims_not_reviewed`, and does not suppress base findings.

Every Git subprocess runs through a shared bounded adapter. Baseline blob reads retain their five-second deadline; other Git operations use a bounded default deadline. If a restricted subprocess stalls, agent-memory terminates it instead of hanging. Audit emits a warning and conservatively retains current-tree overlap findings when baseline memory cannot be loaded.

## Migrating Existing Docs

Use `migrate-docs` when a repository already has human-written docs that should become reviewable `agent-memory` claims.

Usage:

```bash
agent-memory migrate-docs --from <path-to-docs> --system <system> [--automatic] [--force] [--json]
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
agent-memory migrate-docs --from docs/legacy --system auth
```

For canonical repository docs, a docs namespace is often a good first pass:

```bash
agent-memory migrate-docs --from docs/canonical --system docs --automatic
```

The plan lists each source doc, suggested claim ID, and target path. For example, `docs/legacy/oauth.md` under `--system auth` may plan a draft like:

```text
docs/agent-memory/claims/auth/migrated_oauth.md
id: auth.migrated_oauth
```

Create starter drafts when you are ready. Automatic mode writes files under the configured memory root:

```bash
agent-memory migrate-docs --from docs/legacy --system auth --automatic
```

Automatic drafts are `needs_review`, low-confidence starter claims. Review them, split broad prose into atomic claims, add graph edges, and verify against code before promoting them to current memory. Automatic mode only writes drafts for docs inside the repository; use plan mode for external docs, then copy the source docs into the repo before creating drafts.

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

The coverage command prints a summary and writes `coverage/lcov.info`. CI runs
the command and retains the LCOV report as the `bun-coverage` artifact.

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

The workflow verifies that the release tag matches the package version, then tests, builds, dry-runs the package, and runs `npm publish --provenance --access public`. Configure npm Trusted Publishing for the `@jurgen1c/agent-memory-cli` package with GitHub user `jurgen1c`, repository `agent_memory`, workflow `publish.yml`, allowed action `npm publish`, and no environment.

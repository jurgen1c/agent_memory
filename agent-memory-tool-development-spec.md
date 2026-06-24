# Agent Memory Tool — Development Specification

## 1. Purpose

Build a reusable standalone tool that lets software repositories maintain an agent-readable memory layer based on atomic claims, relationship graphs, recipes, and generated SQLite indexes.

The tool should be packaged once and reused across many repositories. Each consuming repository owns its own canonical memory files and its own generated SQLite database.

The tool should help coding agents answer questions like:

- What claims are relevant to this task?
- What constraints apply before I edit this file?
- What related cross-system claims should I consider?
- What memory should I update after this code change?
- What claim template should I use?
- How do I install the agent skill for this repository?

## 2. Design Principles

1. Canonical memory is committed as Markdown and YAML.
2. SQLite is generated local cache, not source of truth.
3. One Markdown file represents one atomic claim.
4. Relationships between claims live in graph YAML files, not duplicated inside claim files.
5. Index files route memory by system, tags, watched files, and default queries.
6. Recipes describe repeatable workflows and reference claims.
7. Agents should interact through CLI commands, not by manually parsing docs.
8. The same package should work across many repositories without shared DB conflicts.
9. Generated state is repo-local by default.
10. Validation must prevent drift, broken references, stale indexes, and ambiguous memory.

## 3. Package Shape

Recommended package name:

```text
agent-memory
```

Recommended standalone repository layout:

```text
agent-memory/
  package.json
  README.md
  LICENSE

  packages/
    cli/
      src/
        index.ts
        commands/
          init.ts
          sync.ts
          compile.ts
          validate.ts
          doctor.ts
          query.ts
          context.ts
          show.ts
          system.ts
          template.ts
          new.ts
          deprecate.ts
          install_hooks.ts
          install_skill.ts
          coverage.ts
          governance.ts

    core/
      src/
        config.ts
        repo.ts
        compiler.ts
        validator.ts
        sqlite.ts
        search.ts
        context_builder.ts
        graph.ts
        templates.ts
        skills.ts
        governance.ts
        markdown.ts
        yaml.ts
        git.ts
        errors.ts
        types.ts

    schemas/
      claim.schema.json
      graph.schema.json
      index.schema.json
      recipe.schema.json
      config.schema.json

    templates/
      claims/
        fact.md
        rule.md
        constraint.md
        workflow.md
        recipe.md
        risk.md
        decision.md
        deprecation.md
      graph.yaml
      index.yaml
      recipe.yaml
      config.yaml
      skill.codex.md
      skill.generic.md

    tests/
      fixtures/
        valid_repo/
        invalid_repo/
      unit/
      integration/
```

The public executable should be:

```bash
agent-memory
```

A consuming repository may also create a thin wrapper:

```bash
bin/memory
```

Wrapper content:

```bash
#!/usr/bin/env bash
npx agent-memory "$@"
```

or:

```bash
#!/usr/bin/env bash
bunx agent-memory "$@"
```

## 4. Consuming Repository Shape

After initialization, a consuming repository should contain:

```text
my-app/
  agent-memory.config.yaml

  docs/
    agent-memory/
      README.md
      claims/
        auth/
        tenancy/
        assessments/
        infrastructure/
      graph/
        auth-tenancy.yaml
      indexes/
        auth.yaml
        tenancy.yaml
      recipes/
        auth/
      waivers/
        .gitkeep

  .agent-memory/
    memory.sqlite

  .codex/
    skills/
      repo-memory/
        SKILL.md

  bin/
    memory
```

`.agent-memory/` must be ignored by git.

Recommended `.gitignore` entry:

```gitignore
.agent-memory/
```

## 5. Repository Isolation

Each repository gets its own generated database:

```text
<repo-root>/.agent-memory/memory.sqlite
```

The tool must detect repo root using:

```bash
git rev-parse --show-toplevel
```

If not inside a git repository, the tool should use the current working directory as repo root and warn.

The DB path is configurable:

```yaml
database_path: .agent-memory/memory.sqlite
```

Default behavior must never write to a shared global DB.

Optional future global cache may be added later, but v1 must be repo-local only.

## 6. Configuration File

File:

```text
agent-memory.config.yaml
```

Example:

```yaml
version: 1
memory_root: docs/agent-memory
database_path: .agent-memory/memory.sqlite

claims:
  - claims/**/*.md

graphs:
  - graph/**/*.yaml

indexes:
  - indexes/**/*.yaml

recipes:
  - recipes/**/*.yaml

waivers:
  - waivers/**/*.yaml

agent_skills:
  codex:
    enabled: true
    path: .codex/skills/repo-memory/SKILL.md
  generic:
    enabled: true
    path: docs/agent-memory/AGENT_SKILL.md

git:
  install_hooks: true
  hooks:
    - post-merge
    - post-checkout
    - post-rewrite

validation:
  require_source_files: true
  require_verification: true
  reject_multi_claim_documents: true
  require_unique_titles_within_system: true
  require_claim_file_matches_id: false

context:
  default_budget: medium
  default_depth: 1
  include_inferred_edges_by_default: false
```

## 7. Canonical Claim Model

A claim is the smallest durable unit of repository knowledge.

Each claim must be:

- specific
- verifiable
- independently reviewable
- linked to source files or evidence
- small enough to update or deprecate without touching unrelated knowledge

Each claim lives in one Markdown file.

Allowed claim types:

```text
fact
rule
constraint
workflow
recipe
risk
decision
deprecation
```

Allowed statuses:

```text
current
proposed
stale
deprecated
experimental
needs_verification
```

Allowed confidence values:

```text
low
medium
high
verified
```

Allowed severities:

```text
info
normal
important
critical
```

## 8. Claim File Schema

Claim file example:

```markdown
---
id: auth.student_oauth.uid_is_tenant_scoped
type: fact
system: auth
status: current
confidence: high
severity: important

title: Student OAuth UID is tenant scoped

claim: >
  Student OAuth identity resolution depends on both the provider sourced ID and
  the tenant context. The provider student identifier alone is not sufficient.

source_files:
  - app/controllers/api/v6/auth_controller.rb

related_files:
  - app/models/student.rb
  - app/models/tenant.rb

symbols:
  - Students::OmniauthCallbacksController
  - Student
  - Tenant

routes:
  - /api/v6/auth/:provider

tags:
  - auth
  - oauth
  - student
  - tenancy

verification:
  - Test OAuth login with two tenants that contain provider users with overlapping sourced IDs.

last_verified_commit: null
---

# Student OAuth UID is tenant scoped

## Claim

Student OAuth identity resolution depends on both the provider sourced ID and the tenant context.
The provider student identifier alone is not sufficient.

## Why It Matters

If tenant context is wrong or missing, the auth flow can issue a token for the wrong student or fail to resolve the intended student.

## Evidence

- `app/controllers/api/v6/auth_controller.rb`

## Verification

- Test OAuth login with two tenants that contain provider users with overlapping sourced IDs.
```

### Required frontmatter fields

```yaml
id: string
type: string
system: string
status: string
confidence: string
severity: string
title: string
claim: string
source_files: string[]
tags: string[]
```

### Optional frontmatter fields

```yaml
related_files: string[]
symbols: string[]
routes: string[]
verification: string[]
last_verified_commit: string | null
replaces: string[]
deprecated_by: string | null
metadata: object
```

## 9. One Claim Per File Enforcement

Validation must reject broad multi-claim documents.

A file should be considered invalid if:

- frontmatter contains more than one `claim`
- multiple unrelated claims are listed under `## Claim`
- the title is broad and the body contains many unrelated assertions
- the file contains headings such as `## Claim 1`, `## Claim 2`
- the file describes an entire subsystem instead of one fact/rule/constraint

The first implementation can enforce simple static rules:

- exactly one `claim` field in frontmatter
- no headings matching `/^## Claim \d+/i`
- no `claims:` array in frontmatter
- maximum claim frontmatter length configurable, default 900 characters
- maximum `## Claim` section length configurable, default 1,200 characters

Later versions may add LLM-assisted linting.

## 10. Graph Relationship Model

Relationships between claims live in graph YAML files.

Directory:

```text
docs/agent-memory/graph/
```

Example:

```yaml
id: graph.auth_tenancy
name: Auth and Tenancy Claim Relationships

edges:
  - source: auth.student_oauth.uid_is_tenant_scoped
    target: tenancy.current_tenant.required_for_student_auth
    relation: requires
    reason: Student OAuth identity resolution depends on tenant context.
    strength: 95
    bidirectional: false

  - source: tenancy.current_tenant.required_for_student_auth
    target: auth.student_oauth.uid_is_tenant_scoped
    relation: constrains
    reason: Tenant resolution constrains how student OAuth can identify students.
    strength: 90
    bidirectional: false

  - claims:
      - auth.student_game_oauth.token_handoff
      - auth.ios_webview.cookies_not_reliable
    relation: same_area
    reason: Both affect student game login behavior.
    strength: 70
    bidirectional: true
```

Allowed relation types:

```text
requires
constrains
explains
conflicts_with
replaces
verifies
same_area
causes
caused_by
blocks
unblocks
implemented_by
tested_by
```

Compiler behavior:

1. Load all claims.
2. Load all graph files.
3. Validate every edge references existing claims.
4. Expand bidirectional edges into two directed edges.
5. Insert explicit graph edges.
6. Create weak inferred edges based on shared files, symbols, routes, and tags.
7. Preserve edge origin as `explicit`, `inferred`, `recipe`, or `replacement`.

Explicit edges always outrank inferred edges.

## 11. Index Model

Indexes route claims by system.

Indexes should not contain canonical knowledge.

Example:

```yaml
id: auth
name: Authentication
summary: OAuth, Devise, student token auth, educator login, and game auth handoff.

claim_globs:
  - claims/auth/**/*.md

recipe_globs:
  - recipes/auth/**/*.yaml

default_queries:
  - oauth
  - login
  - devise
  - token
  - classlink
  - clever
  - webview

watched_files:
  - app/controllers/api/v6/auth_controller.rb
  - app/models/student.rb
  - student-server/src/main.rs
  - ios/**/*.kt

tags:
  - auth
  - oauth
  - login
```

## 12. Recipe Model

Recipes describe repeatable workflows.

Example:

```yaml
id: recipe.auth.modify_student_oauth
title: Modify student OAuth safely
system: auth
status: current

required_claims:
  - auth.student_oauth.uid_is_tenant_scoped
  - tenancy.current_tenant.required_for_student_auth
  - auth.student_game_oauth.token_handoff

intent_triggers:
  - modify student oauth
  - fix student login
  - change clever login
  - change classlink login

relevant_files:
  - app/controllers/api/v6/auth_controller.rb
  - student-server/src/main.rs

steps:
  - Query current auth and tenancy claims.
  - Check changed files against auth memory coverage.
  - Keep educator and student OAuth behavior separate.
  - Test ClassLink and Clever separately.
  - Test game login behavior.
  - Update or add atomic claims if behavior changes.

verification:
  - bundle exec rspec spec/requests/api/v6/auth_spec.rb
```

## 13. SQLite Schema

Generated DB path:

```text
.agent-memory/memory.sqlite
```

Minimum schema:

```sql
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  system TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  claim TEXT NOT NULL,
  source_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE claim_files (
  claim_id TEXT NOT NULL,
  path TEXT NOT NULL,
  relation TEXT NOT NULL
);

CREATE TABLE claim_symbols (
  claim_id TEXT NOT NULL,
  symbol TEXT NOT NULL
);

CREATE TABLE claim_tags (
  claim_id TEXT NOT NULL,
  tag TEXT NOT NULL
);

CREATE TABLE claim_routes (
  claim_id TEXT NOT NULL,
  route TEXT NOT NULL
);

CREATE TABLE claim_relations (
  source_claim_id TEXT NOT NULL,
  target_claim_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  reason TEXT,
  strength INTEGER DEFAULT 50,
  origin TEXT NOT NULL,
  source_path TEXT,
  bidirectional BOOLEAN DEFAULT FALSE,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (source_claim_id, target_claim_id, relation, origin)
);

CREATE TABLE indexes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT,
  source_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  system TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  source_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE TABLE recipe_claims (
  recipe_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  relation TEXT NOT NULL
);

CREATE TABLE compile_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

FTS table:

```sql
CREATE VIRTUAL TABLE claims_fts USING fts5(
  id,
  title,
  claim,
  system,
  tags,
  files,
  symbols,
  routes
);
```

Compile metadata should include:

```text
schema_version
package_version
git_commit
repo_root
compiled_at
memory_root
config_hash
```

## 14. Required CLI Commands

### 14.1 Help

```bash
agent-memory help
agent-memory help <command>
```

Must show command purpose, examples, and agent-specific notes.

### 14.2 Init

```bash
agent-memory init
```

Creates:

```text
agent-memory.config.yaml
docs/agent-memory/README.md
docs/agent-memory/claims/.gitkeep
docs/agent-memory/graph/.gitkeep
docs/agent-memory/indexes/.gitkeep
docs/agent-memory/recipes/.gitkeep
docs/agent-memory/waivers/.gitkeep
bin/memory
.codex/skills/repo-memory/SKILL.md
```

Updates `.gitignore` with:

```gitignore
.agent-memory/
```

Interactive options:

```bash
agent-memory init --yes
agent-memory init --package-manager npm
agent-memory init --package-manager bun
agent-memory init --agent codex
agent-memory init --agent generic
agent-memory init --install-hooks
```

Acceptance criteria:

- safe to run repeatedly
- does not overwrite files unless `--force`
- prints created/skipped files
- creates a working `bin/memory` wrapper
- creates initial example templates or copies template directory

### 14.3 Compile

```bash
agent-memory compile
```

Responsibilities:

- load config
- discover claim, graph, index, recipe, and waiver files
- parse Markdown frontmatter
- validate basic shape before DB write
- create `.agent-memory/` if missing
- rebuild SQLite from scratch
- populate FTS
- write compile metadata

Options:

```bash
agent-memory compile --db .agent-memory/memory.sqlite
agent-memory compile --json
agent-memory compile --verbose
```

### 14.4 Sync

```bash
agent-memory sync
```

Runs:

```bash
agent-memory compile
agent-memory validate
agent-memory doctor
```

Used after pull, checkout, rebase, or merge.

### 14.5 Doctor

```bash
agent-memory doctor
```

Checks:

- DB exists
- DB schema matches package version
- DB was compiled from current git commit
- DB is newer than canonical memory files
- config hash matches
- FTS table exists

Should print actionable warnings.

### 14.6 Validate

```bash
agent-memory validate
```

Validates:

- config schema
- claim schema
- graph schema
- index schema
- recipe schema
- unique claim IDs
- unique recipe IDs
- graph edges point to existing claims
- recipes point to existing claims
- source files exist
- deprecated claims are not required by current recipes unless explicitly allowed
- one claim per file
- current claims do not point to missing evidence

Options:

```bash
agent-memory validate --json
agent-memory validate --strict
agent-memory validate --changed-files file1 file2
```

### 14.7 Query

```bash
agent-memory query "student oauth tenant"
```

Searches FTS and metadata.

Output should include:

- matching claims
- score
- system
- status
- severity
- source path

Options:

```bash
agent-memory query "student oauth tenant" --json
agent-memory query "student oauth tenant" --limit 10
agent-memory query "student oauth tenant" --system auth
agent-memory query "student oauth tenant" --include-stale
```

### 14.8 Context

```bash
agent-memory context --task "fix student oauth in ios webview"
```

Builds agent-ready context.

Options:

```bash
agent-memory context --task "..."
agent-memory context --changed-files file1 file2
agent-memory context --git-diff
agent-memory context --budget small|medium|full
agent-memory context --depth 0|1|2|3
agent-memory context --json
agent-memory context --include-inferred
```

Context must include, when relevant:

- critical rules first
- matched claims
- required/constraining related claims
- relevant files
- related recipes
- verification steps
- stale/deprecated warnings

### 14.9 Show Claim

```bash
agent-memory show auth.student_oauth.uid_is_tenant_scoped
```

Options:

```bash
agent-memory show <id> --json
agent-memory show <id> --include-related
agent-memory show <id> --depth 2
```

### 14.10 System

```bash
agent-memory system auth
```

Returns:

- index summary
- claim count by type/status
- critical claims
- watched files
- recipes
- top graph relationships

### 14.11 Templates

```bash
agent-memory templates list
agent-memory templates show claim:fact
agent-memory templates show claim:constraint
agent-memory templates copy claim:fact --to /tmp/fact.md
```

This is important for agents. Agents should be able to request the exact template instead of inventing structure.

### 14.12 New Claim

```bash
agent-memory new claim --type fact --system auth --title "Student OAuth UID is tenant scoped"
```

Behavior:

- generates a slug and suggested ID
- creates a new Markdown file from template
- never overwrites existing file
- prints path

Options:

```bash
agent-memory new claim --interactive
agent-memory new claim --type constraint --system auth --id auth.ios_webview.cookies_not_reliable
agent-memory new claim --type rule --system ci --severity critical
```

### 14.13 Deprecate Claim

```bash
agent-memory deprecate auth.old_claim --replacement auth.new_claim
```

Behavior:

- updates old claim status to `deprecated`
- sets `deprecated_by`
- creates replacement graph edge
- validates replacement exists

### 14.14 Coverage

```bash
agent-memory coverage --changed-files
agent-memory coverage --git-diff
```

Checks whether changed files are covered by claims, indexes, recipes, or waivers.

### 14.15 Install Hooks

```bash
agent-memory install-hooks
```

Installs:

```text
.git/hooks/post-merge
.git/hooks/post-checkout
.git/hooks/post-rewrite
```

Each hook runs:

```bash
bin/memory sync
```

Hooks must warn but not block git operations by default.

### 14.16 Install Skill

```bash
agent-memory install-skill --agent codex
agent-memory install-skill --agent generic
agent-memory install-skill --agent cursor
agent-memory install-skill --agent claude
```

v1 required:

```text
codex
generic
```

v1 optional:

```text
cursor
claude
```

Behavior:

- writes agent-specific skill/instruction file
- creates directories if needed
- does not overwrite unless `--force`
- skill must list available commands and when to use them

### 14.17 Agent Manifest

```bash
agent-memory agent-manifest
agent-memory agent-manifest --json
```

Returns a concise machine-readable list of tools available to agents.

Example output:

```json
{
  "tool": "agent-memory",
  "commands": [
    {
      "name": "context",
      "purpose": "Retrieve task or file-specific memory for agent work",
      "examples": [
        "agent-memory context --task \"fix student oauth\"",
        "agent-memory context --git-diff"
      ]
    },
    {
      "name": "templates show",
      "purpose": "Show reusable templates for claim creation"
    }
  ]
}
```

## 15. Claim Templates

The package must ship reusable templates for every claim type.

### 15.1 Fact Template

```markdown
---
id: {{id}}
type: fact
system: {{system}}
status: current
confidence: medium
severity: normal

title: {{title}}

claim: >
  {{claim}}

source_files:
  - {{source_file}}

related_files: []
symbols: []
routes: []
tags:
  - {{system}}

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Claim

{{claim}}

## Why It Matters

{{why_it_matters}}

## Evidence

- `{{source_file}}`

## Verification

- {{verification_step}}
```

### 15.2 Constraint Template

```markdown
---
id: {{id}}
type: constraint
system: {{system}}
status: current
confidence: medium
severity: important

title: {{title}}

claim: >
  {{claim}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - constraint

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Claim

{{claim}}

## Constraint

{{constraint_detail}}

## Why It Matters

{{why_it_matters}}

## Verification

- {{verification_step}}
```

### 15.3 Rule Template

```markdown
---
id: {{id}}
type: rule
system: {{system}}
status: current
confidence: medium
severity: critical

title: {{title}}

claim: >
  {{rule}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - rule

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Rule

{{rule}}

## Severity

Critical unless changed in frontmatter.

## Why It Matters

{{why_it_matters}}

## Verification

- {{verification_step}}
```

### 15.4 Workflow Template

```markdown
---
id: {{id}}
type: workflow
system: {{system}}
status: current
confidence: medium
severity: normal

title: {{title}}

claim: >
  {{workflow_summary}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - workflow

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Workflow

{{workflow_summary}}

## Steps

1. {{step_one}}
2. {{step_two}}
3. {{step_three}}

## Why It Matters

{{why_it_matters}}

## Verification

- {{verification_step}}
```

### 15.5 Risk Template

```markdown
---
id: {{id}}
type: risk
system: {{system}}
status: current
confidence: medium
severity: important

title: {{title}}

claim: >
  {{risk_summary}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - risk

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Risk

{{risk_summary}}

## Trigger

{{trigger}}

## Mitigation

{{mitigation}}

## Verification

- {{verification_step}}
```

### 15.6 Decision Template

```markdown
---
id: {{id}}
type: decision
system: {{system}}
status: current
confidence: medium
severity: normal

title: {{title}}

claim: >
  {{decision_summary}}

source_files:
  - {{source_file}}

tags:
  - {{system}}
  - decision

verification:
  - {{verification_step}}

last_verified_commit: null
---

# {{title}}

## Decision

{{decision_summary}}

## Rationale

{{rationale}}

## Alternatives Considered

- {{alternative}}

## Verification

- {{verification_step}}
```

### 15.7 Deprecation Template

```markdown
---
id: {{id}}
type: deprecation
system: {{system}}
status: deprecated
confidence: medium
severity: important

title: {{title}}

claim: >
  {{deprecated_behavior}}

source_files:
  - {{source_file}}

deprecated_by: {{replacement_claim_id}}

tags:
  - {{system}}
  - deprecation

verification:
  - Confirm callers use the replacement behavior.

last_verified_commit: null
---

# {{title}}

## Deprecated Behavior

{{deprecated_behavior}}

## Replacement

Use `{{replacement_claim_id}}`.

## Why It Was Deprecated

{{deprecation_reason}}
```

## 16. Agent Skill Template

The tool must generate an agent skill/instruction file.

Codex path:

```text
.codex/skills/repo-memory/SKILL.md
```

Generic path:

```text
docs/agent-memory/AGENT_SKILL.md
```

Skill content:

```markdown
# Repo Memory Skill

Use this skill whenever working in this repository.

This repository uses `agent-memory`, a local memory system based on atomic claims.

Canonical memory lives in:

- `docs/agent-memory/claims/**/*.md`
- `docs/agent-memory/graph/**/*.yaml`
- `docs/agent-memory/indexes/**/*.yaml`
- `docs/agent-memory/recipes/**/*.yaml`

Generated memory lives in:

- `.agent-memory/memory.sqlite`

Do not edit or commit the SQLite database.

## Before Work

Run:

```bash
bin/memory sync
```

Then retrieve task context:

```bash
bin/memory context --task "<task>"
```

If files are already known:

```bash
bin/memory context --changed-files <file1> <file2>
```

If working from an existing diff:

```bash
bin/memory context --git-diff
```

## During Work

Use:

```bash
bin/memory query "<topic>"
bin/memory show <claim-id> --include-related
bin/memory system <system>
bin/memory templates list
bin/memory templates show claim:fact
```

## After Work

If behavior changed, update or add atomic claims.

Use one Markdown file per claim.

Create a claim with:

```bash
bin/memory new claim --type fact --system <system> --title "<title>"
```

Before finishing:

```bash
bin/memory validate
bin/memory compile
bin/memory doctor
```

## When to Update Memory

Update memory when:

- behavior changed
- architecture changed
- a workflow changed
- a critical constraint was discovered
- a previous claim became stale
- a reusable recipe was discovered

Do not update durable memory for:

- formatting-only changes
- speculative assumptions
- temporary debugging notes

## Relationship Graphs

Relationships between claims live in:

```text
docs/agent-memory/graph/**/*.yaml
```

Do not duplicate relationship metadata in every claim file.

Use graph files to connect claims with relationships like:

- requires
- constrains
- explains
- conflicts_with
- replaces
- verifies
- same_area

## Conflict Rule

If memory conflicts with code, trust code and update memory.
```

## 17. Governance Model

Governance must be policy-driven and mostly automatic. Agents should not need to ask for human approval during normal work. Instead, agents create or update memory, and the tool classifies the resulting claims, graph edges, and recipes according to repository policy.

The goal is:

```text
agents may write
agent-memory classifies
CI enforces policy
humans review only high-risk changes
```

### 17.1 Governance Outcomes

Every new or modified claim should be assigned one governance outcome during validation:

```text
auto_current
proposed
needs_review
blocked
```

Meanings:

```text
auto_current:
  The claim is safe to treat as current because it is evidence-backed and low-risk.

proposed:
  The claim is useful but should be shown with a warning until reviewed or promoted.

needs_review:
  The claim or graph edge touches high-risk systems, creates a cross-system constraint,
  deprecates established knowledge, or lacks sufficient evidence.

blocked:
  The memory change is unsafe, unsupported, invalid, or appears to contain sensitive data.
```

Allowed claim statuses should include:

```text
current
proposed
needs_review
rejected
stale
deprecated
experimental
needs_verification
```

### 17.2 Governance Configuration

Add governance policy to `agent-memory.config.yaml`:

```yaml
governance:
  enabled: true

  default_agent_status: proposed

  auto_current_allowed_when:
    require_source_files: true
    require_verification: true
    require_changed_files_match_claim_files: true
    max_severity: important
    allowed_types:
      - fact
      - workflow
      - risk

  review_required_when:
    severities:
      - critical
    types:
      - rule
      - constraint
      - decision
      - deprecation
    systems:
      - auth
      - security
      - tenancy
      - billing
      - infrastructure
    creates_cross_system_edge: true
    creates_requires_edge: true
    creates_constrains_edge: true
    creates_conflicts_with_edge: true
    deprecates_current_claim: true
    changes_current_critical_claim: true
    lacks_source_files: true
    lacks_verification: true

  blocked_when:
    contains_secret_like_value: true
    contains_private_customer_data: true
    references_missing_source_files: true
    duplicate_claim_id: true
    invalid_schema: true

  reviewers:
    auth:
      - platform
      - security
    security:
      - security
    tenancy:
      - platform
    billing:
      - platform
      - finance
    infrastructure:
      - platform
      - devops
```

### 17.3 Auto-Promotion Rules

A claim may be automatically promoted to `current` only when all configured auto-current conditions pass.

Default v1 policy:

- claim has at least one `source_files` entry
- claim has at least one `verification` entry
- claim type is `fact`, `workflow`, or `risk`
- severity is not `critical`
- source files exist
- claim does not create or modify a high-risk graph edge
- claim does not deprecate or replace a current claim
- claim does not touch a configured high-risk system

If these conditions are not met, the claim remains `proposed` or `needs_review` depending on risk.

### 17.4 Review-Required Rules

Validation should mark memory changes as `needs_review` when they involve:

- critical severity
- `rule`, `constraint`, `decision`, or `deprecation` claims
- high-risk systems such as auth, security, tenancy, billing, or infrastructure
- cross-system graph edges
- `requires`, `constrains`, `conflicts_with`, or `replaces` relationships
- deprecating a `current` claim
- changing a previously reviewed critical claim
- insufficient evidence

The tool should not interrupt the agent. It should record the review requirement and surface it in the governance report and CI output.

### 17.5 Blocked Memory Changes

Validation should block memory changes when:

- schema is invalid
- duplicate claim IDs exist
- referenced source files do not exist
- graph edges point to missing claims
- likely secrets are detected
- private customer data is detected
- claim text is unsupported by any source/evidence
- claim appears to contain environment-specific credentials, tokens, or production-only private details

Blocked changes should fail CI.

### 17.6 Governance Report Command

Add command:

```bash
agent-memory governance report
```

Optional aliases:

```bash
agent-memory govern
agent-memory review-report
```

Expected output:

```text
Agent Memory Governance Report

Auto-current:
- assessments.pdf_report.includes_growth_score

Proposed:
- multiplayer.room_reconnect_retries_after_disconnect

Needs review:
- auth.student_oauth.requires_tenant_context
  Reasons:
  - high-risk system: auth
  - cross-system edge: auth -> tenancy
  Suggested reviewers:
  - platform
  - security

Blocked:
- security.production_jwt_secret
  Reasons:
  - possible secret-like value
```

JSON output:

```bash
agent-memory governance report --json
```

Shape:

```json
{
  "auto_current": [],
  "proposed": [],
  "needs_review": [
    {
      "id": "auth.student_oauth.requires_tenant_context",
      "kind": "claim",
      "reasons": ["high-risk system: auth", "cross-system edge: auth -> tenancy"],
      "reviewers": ["platform", "security"]
    }
  ],
  "blocked": []
}
```

### 17.7 PR-Level Governance

Governance should run at PR/CI time, not as a blocking approval during every agent step.

Recommended CI:

```bash
npx agent-memory compile
npx agent-memory validate
npx agent-memory governance report --ci
npx agent-memory coverage --git-diff
```

CI behavior:

- fail on `blocked`
- fail on `needs_review` only if repository policy requires review before merge
- allow `proposed` claims with warnings by default
- allow `auto_current` claims

Recommended PR summary:

```text
Memory changes:
- 3 auto-current claims
- 2 proposed claims
- 1 claim needs review
- 0 blocked claims
```

### 17.8 Review Metadata

Reviewed claims may include:

```yaml
governance:
  reviewed_by:
    - platform
  reviewed_at: 2026-06-24
  review_status: approved
  review_reason: "Verified during PR review."
```

Graph edges may include equivalent metadata:

```yaml
edges:
  - source: auth.student_oauth.uid_is_tenant_scoped
    target: tenancy.student_auth_requires_correct_tenant
    relation: requires
    reason: Student identity resolution depends on tenant context.
    governance:
      review_status: approved
      reviewed_by:
        - platform
      reviewed_at: 2026-06-24
```

### 17.9 Retrieval Behavior for Proposed and Review-Required Claims

By default, context retrieval should include `current` claims and may include `proposed` or `needs_review` claims only with explicit warnings.

Example:

```markdown
## Proposed Claims

### auth.student_oauth.requires_tenant_context

Status: needs_review
Reason: Cross-system auth/tenancy constraint has not been reviewed.
```

CLI options:

```bash
agent-memory context --task "fix student oauth" --include-proposed
agent-memory context --task "fix student oauth" --only-current
agent-memory query "oauth tenant" --include-needs-review
```

Default recommendation:

- include `current`
- include `proposed` with warning in `medium` and `full` budgets
- include `needs_review` with strong warning when directly relevant
- exclude `rejected`, `deprecated`, and `stale` unless explicitly requested

### 17.10 Agent Skill Governance Instructions

The installed agent skill must tell agents:

- do not ask the user for approval before every memory update
- create/update claims when behavior changes
- rely on `agent-memory validate` and `agent-memory governance report` to classify risk
- leave high-risk claims as `needs_review` instead of forcing them to `current`
- never store secrets, credentials, customer data, tokens, or private production details
- if memory conflicts with code, trust code and update or deprecate memory

### 17.11 Acceptance Criteria for Governance

Governance is complete when:

1. The tool classifies changed claims as `auto_current`, `proposed`, `needs_review`, or `blocked`.
2. CI can fail on blocked memory changes.
3. CI can report review-required memory changes without interrupting agent work.
4. High-risk systems and cross-system graph edges are detected by policy.
5. Agents can continue working without asking for approval at every memory update.
6. Retrieval surfaces proposed/review-required claims with visible warnings.
7. Secrets and private data are blocked from durable memory.

## 18. Git Hooks

`agent-memory install-hooks` should install non-blocking hooks.

Hook body:

```bash
#!/usr/bin/env bash

if [ -x bin/memory ]; then
  echo "Refreshing agent memory..."
  bin/memory sync || echo "Warning: agent memory sync failed. Run bin/memory sync manually."
fi
```

Hooks:

```text
post-merge
post-checkout
post-rewrite
```

## 19. CI Integration

Recommended CI commands:

```bash
npx agent-memory compile
npx agent-memory validate
npx agent-memory coverage --git-diff
```

CI should fail on:

- invalid config
- invalid claim
- invalid graph
- invalid recipe
- duplicate claim IDs
- broken graph edges
- missing source files
- broad multi-claim documents
- watched files changed without related memory update or waiver

## 20. Development Phases

### Phase 1 — Package Foundation

Goal: Create reusable package scaffolding and basic CLI.

Tasks:

1. Create monorepo or package workspace.
2. Implement TypeScript build.
3. Add CLI executable `agent-memory`.
4. Implement command router.
5. Add `help` command.
6. Add config loader.
7. Add repo root detector.
8. Add structured error handling.
9. Add test framework.
10. Add fixture repositories.

Acceptance criteria:

- `agent-memory help` works.
- `agent-memory --version` works.
- CLI can locate repo root.
- CLI can load `agent-memory.config.yaml`.

### Phase 2 — Init Scaffolding

Goal: Make adoption easy in any repo.

Tasks:

1. Implement `agent-memory init`.
2. Create default config template.
3. Create docs directory structure.
4. Create `.gitignore` update logic.
5. Create `bin/memory` wrapper.
6. Create Codex skill file.
7. Create generic agent skill file.
8. Support `--yes`, `--force`, `--package-manager`, `--agent`, `--install-hooks`.
9. Ensure idempotent behavior.

Acceptance criteria:

- Running `agent-memory init --yes` in an empty repo creates all required files.
- Running it twice does not destroy existing files.
- `.agent-memory/` is ignored.
- `bin/memory help` works after init.

### Phase 3 — Templates

Goal: Provide reusable templates for every claim type and make them discoverable to agents.

Tasks:

1. Add built-in templates for all claim types.
2. Implement `templates list`.
3. Implement `templates show`.
4. Implement `templates copy`.
5. Implement `new claim` using templates.
6. Add slug/ID generator.
7. Add collision avoidance.
8. Add interactive and non-interactive claim creation.

Acceptance criteria:

- `agent-memory templates list` shows all templates.
- `agent-memory templates show claim:constraint` prints the template.
- `agent-memory new claim --type fact --system auth --title "X"` creates one Markdown file.

### Phase 4 — Parser and Validator

Goal: Parse canonical memory and reject broken structures.

Tasks:

1. Parse Markdown frontmatter.
2. Parse YAML graph/index/recipe files.
3. Add JSON schemas.
4. Validate claim required fields.
5. Validate enum values.
6. Validate source files exist.
7. Validate unique IDs.
8. Validate graph edges.
9. Validate recipe claim references.
10. Validate one claim per file.
11. Add JSON and human-readable validation output.

Acceptance criteria:

- Valid fixture passes.
- Invalid fixture fails with actionable messages.
- Missing referenced file is detected.
- Broken graph edge is detected.
- Multi-claim doc is rejected.

### Phase 5 — SQLite Compiler

Goal: Compile canonical memory into a repo-local SQLite DB.

Tasks:

1. Add SQLite adapter.
2. Create DB schema.
3. Implement full rebuild behavior.
4. Insert claims.
5. Insert claim files, tags, symbols, routes.
6. Insert graph relationships.
7. Expand bidirectional graph edges.
8. Generate inferred weak edges.
9. Insert recipes and indexes.
10. Create FTS table.
11. Write compile metadata.

Acceptance criteria:

- `agent-memory compile` creates `.agent-memory/memory.sqlite`.
- Re-running compile is deterministic.
- DB contains claims and graph relationships.
- FTS search table is populated.

### Phase 6 — Query and Show

Goal: Let agents retrieve exact claims and search memory.

Tasks:

1. Implement `query` using FTS.
2. Implement metadata filters.
3. Implement status filtering.
4. Implement `show <claim-id>`.
5. Implement `show --include-related`.
6. Implement `system <system>`.
7. Add JSON output.
8. Add markdown output optimized for agents.

Acceptance criteria:

- Query returns relevant claims with scores.
- Show returns one claim and metadata.
- Include-related expands graph relationships.
- System command summarizes claims, recipes, and watched files.

### Phase 7 — Context Builder

Goal: Produce agent-ready context for tasks and changed files.

Tasks:

1. Implement `context --task`.
2. Implement `context --changed-files`.
3. Implement `context --git-diff`.
4. Add graph depth expansion.
5. Add budget modes: small, medium, full.
6. Prioritize critical rules and constraints.
7. Include related recipes.
8. Include verification steps.
9. Warn about stale/deprecated claims.
10. Support JSON output.

Acceptance criteria:

- `context --task` returns a useful compact markdown report.
- `context --changed-files` finds file-linked claims.
- `context --git-diff` works on a branch with changed files.
- Related tenancy claim appears when querying relevant auth claim if graph edge exists.

### Phase 8 — Doctor, Sync, and Hooks

Goal: Keep local SQLite fresh after repository state changes.

Tasks:

1. Implement `doctor`.
2. Implement `sync`.
3. Implement stale DB detection.
4. Implement git commit metadata checks.
5. Implement hook installer.
6. Hooks should be non-blocking by default.
7. Add clear warnings and remediation commands.

Acceptance criteria:

- Doctor warns when DB is missing.
- Doctor warns when DB was compiled from another commit.
- Sync compiles, validates, and doctors.
- Hooks run sync after checkout/merge/rebase.

### Phase 9 — Coverage and Waivers

Goal: Prevent code-memory drift.

Tasks:

1. Implement watched file coverage from indexes.
2. Implement `coverage --changed-files`.
3. Implement `coverage --git-diff`.
4. Detect whether related claims changed in same diff.
5. Add waiver YAML support.
6. Add CI-friendly exit codes.
7. Add useful failure output.

Acceptance criteria:

- Changed watched file with no claim update fails coverage.
- Valid waiver passes coverage.
- Non-watched file does not fail coverage.

### Phase 10 — Agent Skill Installation and Manifest

Goal: Surface tools clearly to agents.

Tasks:

1. Implement `install-skill --agent codex`.
2. Implement `install-skill --agent generic`.
3. Implement `agent-manifest`.
4. Add command descriptions and examples.
5. Add repo-specific paths from config.
6. Ensure skill reminds agents not to commit SQLite.
7. Ensure skill explains templates and graph relationships.

Acceptance criteria:

- Skill file installs in expected path.
- Agent manifest returns machine-readable command descriptions.
- Skill references `bin/memory` when wrapper exists.

### Phase 11 — Documentation and Release

Goal: Make the package reusable by other repositories.

Tasks:

1. Write README.
2. Add quickstart.
3. Add command reference.
4. Add claim authoring guide.
5. Add graph relationship guide.
6. Add CI integration examples.
7. Add package publishing workflow.
8. Add semantic versioning.

Acceptance criteria:

- New repo can adopt the tool from README only.
- Package can be published to npm.
- Example repo passes all documented commands.

## 21. Testing Strategy

### Unit tests

- config loading
- repo root detection
- YAML parsing
- Markdown parsing
- schema validation
- ID generation
- template rendering
- graph expansion
- context prioritization

### Integration tests

- init in empty repo
- compile valid fixture
- validate invalid fixture
- query compiled DB
- context from changed files
- hook installation
- skill installation

### Snapshot tests

- command output
- generated templates
- generated skill files
- context markdown

## 22. Exit Codes

Recommended exit codes:

```text
0 success
1 generic failure
2 validation failure
3 config failure
4 compile failure
5 stale database
6 coverage failure
7 not found
```

## 23. Output Modes

Every agent-facing query command should support:

```bash
--json
```

Human default should be Markdown.

Examples:

```bash
agent-memory query "oauth" --json
agent-memory context --git-diff --json
agent-memory show auth.student_oauth.uid_is_tenant_scoped --json
```

## 24. Security and Safety

The tool must not execute arbitrary code from memory files.

Rules:

- parse Markdown/YAML only
- do not evaluate templates as JavaScript
- do not follow external URLs during compile
- do not write outside repo root unless explicitly configured
- do not overwrite files unless `--force`
- do not commit or stage files automatically

## 25. v1 Non-Goals

Do not implement in v1:

- remote hosted memory service
- Turso/shared DB
- embeddings
- LLM-based claim validation
- web dashboard
- IDE plugin
- cross-repo global memory
- automatic git commits

## 26. Final Acceptance Criteria

The tool is ready for v1 when:

1. It can be installed as an npm package.
2. `agent-memory init --yes` bootstraps a repo.
3. `bin/memory sync` creates and validates the local SQLite database.
4. Agents can retrieve context using task text, changed files, or git diff.
5. Claim templates are discoverable through CLI.
6. Agents can install skill files through CLI.
7. Relationships are defined in graph YAML files and compiled into SQLite.
8. Related claims are included in context output according to graph depth and budget.
9. CI can validate memory and coverage.
10. SQLite remains repo-local, disposable, and gitignored.

# Contextual Workflows Implementation Plan

Status: proposed future feature

## Implementation Strategy

Implement contextual workflows in small phases. Each phase should add tests and
preserve existing behavior.

Recommended order:

1. Shared artifact model and schemas.
2. Recipe indexing, search, and context expansion.
3. Plan templates and plan runs.
4. Profile traits and composition.
5. Agent exposure through skills, references, manifest, and help.
6. UI support.
7. Governance, audit, and higher-level polish.

This order is intentional. Recipes already exist and are closest to current
behavior. Plans depend on recipes and claims. Profiles are most likely to turn
into prompt bloat, so they should be implemented after retrieval diagnostics and
budgeting are real.

## Phase 0: Current-State Audit

Before coding:

- Inspect current recipe schema, compiler, validator, context builder, SQLite
  tables, CLI router, help output, skills generation, and agent manifest.
- Record current JSON shapes for `context`, `system`, `agent-manifest`, and
  recipe compile output if present.
- Confirm generated files under `.agent-memory/` remain ignored.
- Confirm package tests run with `bun test` and `bun run build`.

Files likely involved:

```text
packages/schemas/recipe.schema.json
packages/schemas/config.schema.json
packages/core/src/types.ts
packages/core/src/config.ts
packages/core/src/compiler.ts
packages/core/src/validator.ts
packages/core/src/sqlite.ts
packages/core/src/retrieval.ts
packages/core/src/context_builder.ts
packages/core/src/skills.ts
packages/core/src/manifest.ts
packages/cli/src/router.ts
packages/cli/src/commands/context.ts
packages/cli/src/commands/help.ts
packages/cli/src/commands/agent_manifest.ts
tests/unit
tests/integration
```

Deliverable:

- No code changes required, but identify the minimal modules to modify in phase
  1.

Gotcha:

- Do not start by adding UI. UI support should consume stable core APIs after
  CLI and JSON behavior are tested.

## Phase 1: Artifact Model and Config

### Goals

- Add plan template and profile trait canonical globs.
- Add TypeScript types for recipes, plan templates, plan stages, plan runs, and
  profile traits.
- Add schema files.
- Keep old repositories valid.

### Data Model

Add schema files:

```text
packages/schemas/plan.schema.json
packages/schemas/profile.schema.json
```

Potential exported types:

```ts
export type WorkflowStatus =
  | "current"
  | "proposed"
  | "needs_review"
  | "deprecated"
  | "stale"
  | "rejected";

export type ProfileTraitCategory =
  | "retrieval_bias"
  | "output_contract"
  | "verification_bias"
  | "risk_lens"
  | "scope_control";

export type ProfileTraitPriority =
  | "low"
  | "normal"
  | "high"
  | "critical";

export interface PlanTemplate {
  id: string;
  title: string;
  system: string;
  status: WorkflowStatus;
  intent_triggers?: string[];
  recipes?: string[];
  stages: PlanTemplateStage[];
  metadata?: Record<string, unknown>;
}

export interface PlanTemplateStage {
  id: string;
  title: string;
  goal: string;
  claim_refs?: string[];
  recipe_refs?: string[];
  profile_traits?: string[];
  source_files?: string[];
  verification?: string[];
  done_when?: string[];
  memory_updates?: string[];
}

export interface PlanRun {
  id: string;
  template_id?: string;
  task: string;
  created_at: string;
  updated_at: string;
  status: "active" | "complete" | "blocked" | "abandoned";
  current_stage: string;
  branch?: string;
  base_commit?: string;
  stages: PlanRunStage[];
}

export interface PlanRunStage {
  id: string;
  status: "pending" | "active" | "blocked" | "complete" | "skipped";
  started_at?: string;
  completed_at?: string;
  evidence?: string[];
}

export interface ProfileTrait {
  id: string;
  title: string;
  status: WorkflowStatus;
  category: ProfileTraitCategory;
  priority: ProfileTraitPriority;
  applies_when: ProfileTraitAppliesWhen;
  snippet: string;
  conflicts_with?: string[];
}
```

### Config

Update config parsing defaults:

```yaml
plans:
  - plans/**/*.yaml

profiles:
  - profiles/**/*.yaml

context:
  recipe_match_limit: 3
  profile_trait_limit: 5
  plan_template_suggestion_limit: 3
  include_profile_traits: true
  include_recipe_diagnostics: true
  include_profile_diagnostics: true
```

Backward compatibility:

- If `plans` or `profiles` is missing, use defaults but do not require the
  directories to exist.
- If config has no `context` workflow fields, use default limits.

### Validation

Add validation for:

- unique plan template IDs
- unique stage IDs within a plan
- required plan fields
- unique profile trait IDs
- profile snippet length
- supported profile category and priority
- `conflicts_with` references
- dangerous profile text that claims to override higher-priority instructions

Secret and customer-data validation can start as a simple deterministic scanner
consistent with existing audit/governance direction. Do not introduce network
checks.

### Tests

Add unit or integration tests for:

- valid plan template
- invalid plan template missing stages
- duplicate plan stage IDs
- valid profile trait
- huge profile snippet failure
- trait conflict references missing trait
- old config without plans/profiles still validates

### Gotchas

- JSON schemas should reject unknown dangerous shapes only when necessary.
  Repositories may want metadata fields later.
- Do not require every plan stage to reference claims or recipes. A stage may be
  valid but low value; warn rather than fail unless strict mode is on.
- Avoid using `profile` as a user/person record. The artifact is a
  `profile_trait`.

## Phase 2: SQLite and Compile

### Goals

- Compile plan templates and profile traits into SQLite.
- Improve recipe indexing if current recipe lookup is not direct enough.
- Add FTS for recipes, plan templates, and profile traits.

### SQLite Changes

Add or migrate tables:

```sql
CREATE TABLE profile_traits (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  source_path TEXT NOT NULL,
  applies_when_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  snippet TEXT NOT NULL
);

CREATE VIRTUAL TABLE profile_traits_fts USING fts5(
  id,
  title,
  category,
  snippet,
  content=''
);

CREATE TABLE plan_templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  system TEXT NOT NULL,
  status TEXT NOT NULL,
  source_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE TABLE plan_stages (
  plan_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (plan_id, stage_id)
);

CREATE VIRTUAL TABLE plan_templates_fts USING fts5(
  id,
  title,
  system,
  stage_titles,
  stage_goals,
  intent_triggers,
  content=''
);
```

If recipes are not already searchable as first-class artifacts, add:

```sql
CREATE VIRTUAL TABLE recipes_fts USING fts5(
  id,
  title,
  system,
  triggers,
  steps,
  verification,
  content=''
);
```

### Compile Behavior

Compile should:

1. Parse existing claims, graph, indexes, recipes, waivers.
2. Parse plan templates from configured globs.
3. Parse profile traits from configured globs.
4. Validate references across artifacts.
5. Insert artifacts into SQLite.
6. Rebuild FTS rows.

Plan runs under `.agent-memory/plans` should not be compiled in this phase.
They are active generated state and can be read directly by plan commands.

### Tests

Add tests for:

- compile stores profile traits
- compile stores plan templates and stages
- FTS can find plan by stage goal
- FTS can find profile trait by snippet/title
- recipe FTS includes triggers and steps
- compile remains idempotent
- stale DB detection accounts for new canonical globs

### Gotchas

- If compile only watches claims/graph/indexes/recipes today, doctor may miss
  stale plans/profiles. Update stale detection inputs.
- FTS row rebuild must be deterministic. Avoid nondeterministic JSON key order
  in searchable text.
- Be careful with FTS tokenization of dotted IDs like
  `profile_trait.review.findings_first`.

## Phase 3: Recipe Search and Context Expansion

### Goals

- Add direct recipe commands.
- Make `context --task` automatically include matched recipes and required
  claims.
- Add diagnostics.

### Commands

Add command group:

```bash
bin/memory recipes list
bin/memory recipes search "<query>"
bin/memory recipes show <recipe-id>
```

Recommended files:

```text
packages/cli/src/commands/recipes.ts
packages/core/src/recipes.ts
tests/integration/recipes.test.ts
```

Router entries:

```text
recipes list
recipes search
recipes show
```

### Core API

Potential functions:

```ts
export interface RecipeMatch {
  recipe: Recipe;
  score: number;
  reasons: MatchReason[];
}

export function searchRecipes(input: RecipeSearchInput): RecipeMatch[];
export function getRecipe(id: string): Recipe | null;
export function expandRecipeContext(match: RecipeMatch): RecipeContextExpansion;
```

Reason codes:

- `explicit_recipe`
- `trigger_match`
- `fts_match`
- `summary_fts`
- `step_fts`
- `system_match`
- `changed_file_match`
- `required_claim_already_matched`
- `tag_match`

### Context Integration

Update context builder:

1. Run existing claim retrieval.
2. Run recipe matching from task text and changed files.
3. Include top recipes according to budget.
4. Add recipe `required_claims` to required claim set.
5. Add recipe `optional_claims` to related claim set when budget allows.
6. Add recipe `relevant_files`, `verification`, and `memory_updates`.
7. Render recipe diagnostics.

`context --recipe <id>` should force-include the recipe and its required claims.

### Output

Markdown section:

```markdown
## Matched Recipes

### recipe.auth.modify_student_oauth

Matched because:
- task trigger: "fix student login"
- changed file: app/controllers/api/v6/auth_controller.rb

Steps:
1. Inspect current provider identity resolution.
2. Preserve tenant scoping.

Required claims:
- auth.student_oauth.uid_is_tenant_scoped

Verification:
- bundle exec rspec spec/requests/api/v6/auth_spec.rb
```

JSON shape:

```json
{
  "matched_recipes": [
    {
      "id": "recipe.auth.modify_student_oauth",
      "score": 42,
      "reasons": [
        {"code": "trigger_match", "detail": "fix student login"}
      ],
      "required_claims": [],
      "verification": []
    }
  ]
}
```

### Tests

Cover:

- recipe search finds by trigger
- recipe search finds by changed file
- recipe search hides stale/deprecated by default
- recipe show prints required claims and verification
- context auto-includes recipe required claims
- context with explicit recipe includes recipe even without task match
- JSON includes reasons
- no recipes configured keeps current context behavior

### Gotchas

- Do not over-rank a recipe solely because one common word matched.
- Do not include required claims twice if already matched by normal retrieval.
- A recipe can reference missing claims in proposed mode; context should warn,
  not crash.
- If recipe matching pollutes context, users will stop trusting recipes.
  Diagnostics and caps are mandatory.

## Phase 4: Plan Templates and Plan Runs

### Goals

- Search and inspect plan templates.
- Create generated plan runs.
- Retrieve context for a plan stage.
- Update plan stage status atomically.
- Finish, prune, or promote completed plan runs so local task state does not
  become durable memory by accident.

### Commands

Add command group:

```bash
bin/memory plans templates list
bin/memory plans templates show <template-id>
bin/memory plans suggest --task "<task>"
bin/memory plans new --task "<task>"
bin/memory plans new --template <template-id> --task "<task>"
bin/memory plans show <plan-run-id>
bin/memory plans next <plan-run-id>
bin/memory plans complete-stage <plan-run-id> --stage <stage-id> --evidence "<text>"
bin/memory plans block-stage <plan-run-id> --stage <stage-id> --reason "<text>"
bin/memory plans finish <plan-run-id>
bin/memory plans prune --completed --older-than 7d
bin/memory plans promote <plan-run-id> --to-template
```

Recommended files:

```text
packages/cli/src/commands/plans.ts
packages/core/src/plans.ts
tests/integration/plans.test.ts
```

### Plan IDs and Storage

Plan run ID should be deterministic enough to read but collision safe:

```text
plan_run.<yyyymmdd>.<slug>.<short_hash>
```

Path:

```text
.agent-memory/plans/<yyyymmdd>-<slug>-<short_hash>.yaml
```

The hash can be derived from task text, template ID, timestamp, and repo root.
If a collision occurs, append a numeric suffix.

### Plan Suggestion

`plans suggest` should:

1. Normalize task text.
2. Search plan templates by triggers/title/stages.
3. Search recipes.
4. Return top templates and their reasons.
5. If no template matches, suggest a minimal ad hoc plan shape without writing.

### Plan Creation

`plans new` should:

1. Resolve template by explicit ID or best suggestion.
2. Build a plan run.
3. Copy or snapshot stage IDs and titles into the run.
4. Record branch and base commit when available.
5. Write under `.agent-memory/plans` with atomic write.
6. Print next `context --plan ... --stage ...` command.

Open question:

- Snapshot full stage data or reference template stage data?

Recommended first implementation:

- Store `template_id` and per-stage status/evidence in the run.
- Store a lightweight `template_snapshot_hash`.
- Read stage details from current template when available.
- Warn if hash changed.

This keeps runs compact while surfacing template drift.

### Plan Finish

`plans finish <plan-run-id>` should close out a local one-off plan run without
letting it become an accidental memory corpus.

Recommended behavior:

1. Load the plan run from `.agent-memory/plans`.
2. Verify no stage is `active` or `pending`.
3. Allow `blocked` stages only with `--abandon-blocked` or an explicit reason.
4. Scan plan template and stage data for unresolved `memory_updates` prompts.
5. Print unresolved prompts and the durable artifact types that should carry the
   knowledge forward.
6. If prompts are unresolved, ask the caller to pass `--confirm-unresolved` or
   update memory first.
7. Mark the run `complete` or `abandoned`.
8. Delete the local run by default, or move it to
   `.agent-memory/plans/completed/` only if `--archive` is passed.

Default deletion is intentional. A completed one-off plan should not sit around
as pseudo-memory. Claims, recipes, graph edges, indexes, and profile traits are
the durable memory artifacts.

Suggested options:

```bash
bin/memory plans finish <plan-run-id>
bin/memory plans finish <plan-run-id> --confirm-unresolved
bin/memory plans finish <plan-run-id> --archive
bin/memory plans finish <plan-run-id> --abandon-blocked --reason "<reason>"
```

### Plan Prune

`plans prune` should remove old local runs under `.agent-memory/plans`.

Suggested options:

```bash
bin/memory plans prune --completed
bin/memory plans prune --abandoned
bin/memory plans prune --completed --older-than 7d
bin/memory plans prune --dry-run
bin/memory plans prune --include-blocked --older-than 30d
```

Rules:

- Never prune `active` or `pending` runs by default.
- Never prune `blocked` runs unless `--include-blocked` is passed.
- Support `--dry-run`.
- Print every deleted path.
- Stay inside `.agent-memory/plans`; reject paths outside the repo-local plan
  root.

`doctor` should warn when completed or abandoned plan runs exceed a configured
age or count threshold and suggest a prune command.

### Plan Promote

`plans promote <plan-run-id> --to-template` should convert a completed local run
into a reusable canonical template only when the user explicitly asks.

Recommended behavior:

1. Load the run.
2. Require the run to be complete or abandoned.
3. Require `--system` and `--title` when they cannot be inferred safely.
4. Build a proposed `plan_template.*` YAML file under
   `docs/agent-memory/plans`.
5. Strip run-only fields: timestamps, branch names, commit hashes, evidence,
   active status, and one-off notes.
6. Keep reusable stage titles, goals, claim refs, recipe refs, profile traits,
   source file globs, verification, done-when checks, and memory-update prompts.
7. Warn about task-specific wording that should be generalized.
8. Do not delete the source run unless `--finish-after-promote` is passed.

Suggested options:

```bash
bin/memory plans promote <plan-run-id> --to-template
bin/memory plans promote <plan-run-id> --to-template --system auth --title "OAuth provider behavior change"
bin/memory plans promote <plan-run-id> --to-template --finish-after-promote
```

Promotion should write reviewable YAML, then tell the user to run validation.
It should not mark the new template `current` if references are missing or if
the source run contains unresolved one-off details.

### Plan Context

`context --plan <id> --stage <stage>` should:

1. Load plan run from `.agent-memory/plans` or template from canonical docs.
2. Resolve stage.
3. Add stage `claim_refs` to required claims.
4. Add stage `recipe_refs` and expand them.
5. Add stage `profile_traits`.
6. Add stage `source_files`.
7. Add stage `verification`, `done_when`, and `memory_updates`.
8. Run normal graph expansion and warnings.

If `--stage` is omitted:

- plan run: use `current_stage`
- template: use first stage

### Atomic Writes

Implement plan run writes with:

1. Ensure `.agent-memory/plans` exists.
2. Acquire a lock file such as `.agent-memory/locks/plans.lock`.
3. Read current YAML.
4. Validate transition.
5. Write to temp file in same directory.
6. Rename temp file over target.
7. Release lock.

If lock acquisition fails:

- return a clear error
- include path to stale lock
- do not write

Avoid destructive cleanup of lock files unless user passes an explicit
`--break-lock` flag.

### Stage Transitions

Allowed transitions:

```text
pending -> active
pending -> skipped
active -> complete
active -> blocked
pending -> abandoned
active -> abandoned
blocked -> abandoned
blocked -> active
blocked -> skipped
```

Do not allow:

```text
complete -> active
complete -> pending
skipped -> active
abandoned -> active
```

unless `--force` is passed.

### Tests

Cover:

- template list/show
- suggest finds template by trigger
- suggest does not write
- new writes under `.agent-memory/plans`
- new records branch/base commit when git exists
- next returns current stage and context command
- complete-stage updates YAML atomically
- empty evidence fails
- context with plan stage includes stage claims and recipes
- missing stage fails with actionable message
- template drift warning
- plan run on different branch warning
- collision-safe filenames
- finish deletes or archives completed runs
- finish warns on unresolved memory update prompts
- finish refuses active or pending stages
- prune dry-run lists completed or abandoned runs
- prune does not delete active, pending, or blocked runs by default
- promote writes canonical template YAML without run-only fields
- promote warns about task-specific wording

### Gotchas

- Plan runs can become stale fast. Warnings are better than hard failures.
- One-off plans should not be committed.
- Completed one-off plans should not accumulate. The tool should make cleanup
  the normal path.
- Do not call completed plan runs "memory." They are local scaffolding.
- A plan stage with no claims or recipes may still be useful, but context should
  not pretend it is memory-backed.
- Agents may over-follow bad plans. Render plan stages with warnings and source
  paths, not as unquestionable truth.
- Promotion can easily create ugly, task-specific templates. Strip run-only data
  and warn before writing reusable memory.

## Phase 5: Profile Traits and Composition

### Goals

- Add profile trait commands.
- Compose traits into context output.
- Keep traits small and explainable.

### Commands

Add command group:

```bash
bin/memory profiles list
bin/memory profiles show <trait-id>
bin/memory profiles match --task "<task>" --changed-files <files...>
```

Add context flags:

```bash
bin/memory context --profile auto
bin/memory context --profile review
bin/memory context --profile architect
bin/memory context --profile-trait profile_trait.review.findings_first
```

Recommended files:

```text
packages/cli/src/commands/profiles.ts
packages/core/src/profiles.ts
tests/integration/profiles.test.ts
```

### Trait Matching

Inputs:

- task text
- inferred task intents
- changed files
- systems
- matched recipes
- plan template/stage
- matched claims and claim types
- explicit profile alias
- explicit profile trait IDs

Task intents can start with deterministic keyword rules:

```text
review: review, audit, inspect, find issues, pr comments
architect: architecture, design, approach, plan, tradeoff
implementer: implement, fix, change, add, refactor
release: release, publish, deploy, version
migration: migrate, move, remove legacy, canonical
```

Do not pretend these are perfect. Include intent diagnostics.

### Specificity Scoring

Trait score should increase when:

- explicitly requested
- task intent matches
- system matches
- file glob matches
- recipe ID matches
- plan template ID matches
- risk signal matches
- claim type matches

Trait score should decrease when:

- trait is broad
- trait is proposed or needs review
- trait applies to every command
- trait snippet is near max length

### Conflict Resolution

Rules:

1. Explicit trait wins if valid.
2. Higher priority wins.
3. More specific `applies_when` wins.
4. Current status wins over proposed.
5. For `output_contract`, select at most one active trait per conflict group.
6. For `retrieval_bias`, compose unless directly contradictory.
7. Report dropped traits in diagnostics.

### Context Rendering

Markdown:

```markdown
## Selected Profile Traits

### profile_trait.review.findings_first

Selected because:
- task intent: review
- changed files: app/controllers/api/v6/auth_controller.rb

Guidance:
Lead with concrete findings ordered by severity. Include file and line
references for each finding. Keep summary secondary.
```

JSON:

```json
{
  "profile_traits": [
    {
      "id": "profile_trait.review.findings_first",
      "category": "output_contract",
      "priority": "high",
      "snippet": "...",
      "reasons": []
    }
  ],
  "dropped_profile_traits": [
    {
      "id": "profile_trait.explain.tutorial_style",
      "reason": "conflicts_with profile_trait.review.findings_first"
    }
  ]
}
```

### Tests

Cover:

- match by task intent
- match by file glob
- match by recipe ID
- explicit trait inclusion
- missing explicit trait error
- alias maps to relevant traits
- conflicting output traits
- broad trait warning
- long snippet validation
- unsafe snippet validation
- context includes profile traits with reasons
- small budget caps traits

### Gotchas

- Profiles are the easiest feature to overbuild. Enforce size and count limits.
- Do not allow traits to say "ignore the user" or equivalent.
- Do not call them personalities in user-facing schema.
- Treat traits as memory context, not instruction hierarchy.

## Phase 6: Agent Exposure

### Goals

- Make agents discover and use contextual workflows.
- Keep top-level skills concise.
- Add deeper references for agents that need them.
- Expose machine-readable capabilities.

### Repo-Memory Skill Updates

Update skill generation in:

```text
packages/core/src/skills.ts
```

The generated repo-memory skill should include:

```text
Before non-trivial work:
- Run `bin/memory context --task "<task>"` or `bin/memory context --git-diff`.
- If the context includes matched recipes, use their required claims,
  verification, and memory-update prompts.
- If the context includes a plan stage, work that stage unless the user broadens
  scope.
- If the context includes profile traits, treat them as repo guidance with lower
  priority than system/developer/user/AGENTS.md instructions.
- After code changes, run coverage/audit and update durable memory when
  behavior changed.
- When a one-off plan run is complete, run `plans finish` or `plans prune`.
- Promote a completed run only when it describes a reusable workflow.
```

Codex installs should include references:

```text
references/contextual-workflows.md
references/recipes.md
references/plans.md
references/profiles.md
```

Reference content should be short but actionable:

- command examples
- how to interpret context sections
- when to create a plan run
- how to finish, prune, and promote plan runs
- how to inspect recipes/profile traits
- what not to commit

### Generic Agent Instructions

Update generic instructions with the same command flow, without Codex-specific
reference mechanics.

### Init and Upgrade

`init` should:

- create `docs/agent-memory/plans/.gitkeep`
- create `docs/agent-memory/profiles/.gitkeep`
- install updated skill/reference content
- keep existing user files unless managed/forced

`upgrade --write` should:

- refresh managed skill content
- refresh managed reference files
- avoid overwriting custom references unless `--force`
- preserve single-agent install behavior

### Agent Manifest

Update:

```text
packages/core/src/manifest.ts
packages/cli/src/commands/agent_manifest.ts
```

Add:

```json
{
  "capabilities": {
    "contextual_workflows": true,
    "recipes": {
      "enabled": true,
      "commands": ["recipes list", "recipes search", "recipes show"],
      "context_flags": ["--recipe"]
    },
    "plans": {
      "enabled": true,
      "commands": ["plans suggest", "plans new", "plans next", "plans finish", "plans prune", "plans promote"],
      "context_flags": ["--plan", "--stage"],
      "run_root": ".agent-memory/plans"
    },
    "profiles": {
      "enabled": true,
      "commands": ["profiles list", "profiles match", "profiles show"],
      "context_flags": ["--profile", "--profile-trait"]
    }
  }
}
```

Add counts:

```json
{
  "workflow_summary": {
    "recipe_count": 0,
    "plan_template_count": 0,
    "profile_trait_count": 0,
    "active_plan_run_count": 0,
    "completed_plan_run_count": 0,
    "abandoned_plan_run_count": 0,
    "warnings": []
  }
}
```

### Help Output

Update:

```text
packages/cli/src/commands/help.ts
```

Add command docs and cross-links:

- `help context`
- `help recipes`
- `help plans`
- `help profiles`
- root `help`

### Tests

Cover:

- init creates plan/profile dirs
- install-skill includes workflow guidance
- Codex references are generated
- upgrade refreshes managed references
- custom references are preserved
- single-agent install does not generate unselected agent content
- agent-manifest includes capabilities and counts
- help output includes workflow commands

### Gotchas

- If skills are not updated, agents will not use the feature.
- Do not put full schema docs into `SKILL.md`. Keep the entrypoint small.
- The manifest should not require compile to succeed just to advertise command
  availability, but counts may require reading config/DB and can report
  warnings.

## Phase 7: UI Support

### Goals

- Let users inspect recipes, plan templates, active plan runs, and profile
  traits.
- Keep writes explicit.

Potential UI additions:

- Recipe search/list/detail.
- Plan template list/detail.
- Active plan run list with current stage.
- Plan run stage completion form with evidence.
- Profile trait list/detail and conflict warnings.
- Context preview for a task or plan stage.

Files likely involved:

```text
packages/core/src/ui_model.ts
packages/core/src/ui_server.ts
packages/web/src/App.tsx
packages/web/src/styles.css
tests/unit/ui_model.test.ts
tests/integration/ui_server.test.ts
```

UI write actions:

- approve or change status for profile traits and plan templates, later
- complete/block plan stage, maybe
- sync after canonical memory edits

First UI phase should probably be read-only for canonical plan/profile files and
write only active plan-run stage status. Editing YAML schemas in the UI can wait.

### Tests

Cover:

- UI model includes workflow summary
- UI server returns recipes/plans/profiles endpoints
- plan run update endpoint requires token
- invalid plan run update returns actionable error
- no workflow artifacts renders empty states

### Gotchas

- UI should not become the only way to understand the feature.
- Keep CLI and JSON stable first.
- Do not expose plan-run write endpoints without the existing session token
  protection.

## Phase 8: Governance, Audit, and Coverage

### Goals

- Surface risky workflow artifacts.
- Detect stale and contradictory workflow memory.
- Prevent dangerous profile traits.

### Validation and Audit Enhancements

Add warnings or failures for:

- current recipe references deprecated claim
- current plan stage references deprecated recipe
- current profile trait has broad applies_when and critical priority
- profile trait conflicts with another current trait but lacks
  `conflicts_with`
- completed or abandoned plan runs exceed configured age/count thresholds
- completed plan run contains unresolved `memory_updates` prompts
- Markdown recipe claim references a deprecated YAML recipe
- YAML recipe lacks corresponding Markdown recipe claim when configured
- plan template duplicates recipe steps without adding stage-specific value
- active plan run accidentally staged in git

### Coverage Enhancements

Consider expanding `coverage`:

- if changed files match a recipe's `relevant_files`, memory coverage can be
  satisfied by updating related claims or the recipe
- if changed files match a plan template's `source_files`, coverage may suggest
  checking related plan templates
- if a profile trait applies to changed files and behavior changes, coverage may
  remind users to update profile traits only when guidance changed

Be careful. Coverage should not require updating profiles just because a file
changed.

### Tests

Cover:

- audit flags current recipe requiring deprecated claim
- audit flags unsafe broad critical profile trait
- coverage warning for active plan run staged
- doctor warning for accumulated completed plan runs
- finish warning for unresolved memory update prompts
- coverage does not over-require profile updates

### Gotchas

- Overzealous coverage will make users hate the feature.
- Governance should classify and warn; only block clear invalid or unsafe data.

## Phase 9: Optional Future Improvements

Do not implement these in the first pass:

- semantic recipe/profile/plan matching through embeddings
- LLM-generated plan stages
- automatic promotion of completed plan runs into templates
- long-term archival of completed one-off plan runs
- UI YAML editors
- cross-repo shared workflow libraries
- remote synchronization
- task transcript storage

These can be revisited after deterministic CLI behavior is useful.

Expanded notes for these deferred ideas live in
[future-improvements.md](./future-improvements.md).

## Command Summary

New command groups:

```bash
bin/memory recipes list
bin/memory recipes search "<query>"
bin/memory recipes show <recipe-id>

bin/memory plans templates list
bin/memory plans templates show <template-id>
bin/memory plans suggest --task "<task>"
bin/memory plans new --task "<task>"
bin/memory plans new --template <template-id> --task "<task>"
bin/memory plans show <plan-run-id>
bin/memory plans next <plan-run-id>
bin/memory plans complete-stage <plan-run-id> --stage <stage-id> --evidence "<text>"
bin/memory plans block-stage <plan-run-id> --stage <stage-id> --reason "<text>"
bin/memory plans finish <plan-run-id>
bin/memory plans prune --completed --older-than 7d
bin/memory plans promote <plan-run-id> --to-template

bin/memory profiles list
bin/memory profiles show <trait-id>
bin/memory profiles match --task "<task>" --changed-files <files...>
```

New context flags:

```bash
bin/memory context --recipe <recipe-id>
bin/memory context --plan <plan-run-or-template-id>
bin/memory context --stage <stage-id>
bin/memory context --profile auto
bin/memory context --profile <alias>
bin/memory context --profile-trait <trait-id>
```

## Verification Before Each Phase Ends

Run:

```bash
bun test
bun run build
dist/agent-memory.js help
dist/agent-memory.js --version
```

For phases with built CLI behavior, smoke-test commands against
`examples/mock-app` or a temporary copy.

## Rollout Plan

### First Release

Ship:

- recipe search/show
- automatic recipe expansion in context
- plan/profile schemas and validation only, or hide them behind docs
- skill/manifest hints for recipe-aware context

This gives immediate value and avoids shipping unfinished plans/profiles.

### Second Release

Ship:

- plan templates
- plan runs
- `context --plan --stage`
- installed skill references for plans

### Third Release

Ship:

- profile traits
- profile matching/composition
- context profile sections
- safety validation

### Fourth Release

Ship:

- UI views
- governance/audit enhancements
- richer coverage integration

## Harsh Checks Before Building

Ask these before each phase:

- Does this reduce context the agent needs to load, or add another thing to
  read?
- Can an agent discover this from installed skills or manifest output?
- Can the user inspect why something matched?
- Can a bad artifact be detected before it hurts an agent's work?
- Is generated task state kept out of git?
- Can a repository ignore this feature and keep existing behavior?
- Are we adding workflow value, or just inventing new YAML?

If the answer is bad, simplify the phase before implementing it.

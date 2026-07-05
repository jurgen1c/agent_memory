# Contextual Workflows Requirements

Status: proposed future feature

## Purpose

Contextual workflows should help agents work from precise, staged repository
memory instead of loading broad skills or searching memory manually.

The feature is successful only if an agent can start from a normal user request
and receive:

- matching recipes
- current plan stage, when applicable
- relevant claims and related graph constraints
- selected profile traits
- source files and verification commands
- warnings about stale, deprecated, proposed, or review-required memory
- reasons for every selected item

## Non-Goals

- Do not build a generic project-management system.
- Do not create a second hidden prompt or skill system.
- Do not execute recipe, plan, profile, or verification content.
- Do not commit active plan runs by default.
- Do not accumulate completed one-off plan runs as durable memory.
- Do not use an LLM-only classifier as the first implementation.
- Do not require semantic embeddings or network access.
- Do not replace claims, graph files, indexes, recipes, coverage, or audit.

## User Stories

### Agent Starts Work From a Task

As an agent, when I receive a user task, I can run:

```bash
bin/memory context --task "fix ClassLink login tenant collision"
```

The output should include the best matching recipe, required claims, relevant
files, verification commands, profile traits, and selection diagnostics.

Acceptance criteria:

- Matching recipes are included automatically when confidence is high enough.
- Required recipe claims are included without a second query.
- Recipe verification commands are rendered.
- Profile traits are included only when relevant.
- The output explains why the recipe and traits were selected.
- The command still works when no recipes, plans, or profiles are configured.

### Agent Works a Specific Plan Stage

As an agent, when a plan run exists, I can run:

```bash
bin/memory context --plan plan_run.20260702.auth_oauth_provider_change --stage implement_change
```

The output should include exactly the context needed for that stage.

Acceptance criteria:

- The selected stage is rendered before general context.
- Stage claim references are resolved and included.
- Stage recipe references are resolved and expanded.
- Stage profile traits are composed with inferred traits.
- Stage verification and done-when checks are rendered.
- Missing or stale references produce visible warnings.
- The tool does not silently advance stages.

### Agent Finds Reusable Workflows

As an agent or user, I can inspect recipe matches directly:

```bash
bin/memory recipes search "student oauth"
bin/memory recipes show recipe.auth.modify_student_oauth
```

Acceptance criteria:

- Search ranks by intent triggers, title, system, tags, relevant files, and FTS.
- Show prints recipe metadata, required claims, steps, verification, and related
  profile traits.
- JSON output includes the same data in stable fields.
- Deprecated and stale recipes are hidden by default unless explicitly included.

### Agent Creates a Stage-Aware Plan Run

As an agent, I can ask the tool to suggest or create a plan run:

```bash
bin/memory plans suggest --task "migrate legacy auth callbacks"
bin/memory plans new --task "migrate legacy auth callbacks"
```

Acceptance criteria:

- `suggest` does not write.
- `new` writes a plan run under `.agent-memory/plans`.
- The generated run records task text, branch, base commit when available,
  template source when matched, stage statuses, and timestamps.
- The generated run references claims, recipes, source files, verification, and
  profile traits.
- The command warns if no template matched and it has to create a minimal
  task-derived plan.
- Generated plan runs are ignored by git.

### Agent Resumes a Plan

As an agent, I can resume active work:

```bash
bin/memory plans next plan_run.20260702.auth_oauth_provider_change
```

Acceptance criteria:

- The command prints the current or next pending stage.
- The command suggests the exact `context --plan ... --stage ...` command.
- If branch or base commit changed, it warns before continuing.
- If references are invalid, it reports them and does not claim the stage is
  ready.

### Agent Completes a Stage

As an agent, I can mark a stage complete with compact evidence:

```bash
bin/memory plans complete-stage plan_run.20260702.auth_oauth_provider_change \
  --stage inspect_current_contract \
  --evidence "Reviewed auth controller and tenant scoping claims."
```

Acceptance criteria:

- The plan run is updated atomically.
- The completed stage records timestamp and evidence.
- The next stage becomes current when appropriate.
- The command does not accept empty evidence unless `--allow-empty-evidence` is
  provided.
- Concurrent writes do not corrupt the plan file.

### Agent Finishes or Prunes a Plan Run

As an agent, I can finish completed work and avoid accumulating local plan runs:

```bash
bin/memory plans finish plan_run.20260702.auth_oauth_provider_change
bin/memory plans prune --completed --older-than 7d
```

Acceptance criteria:

- `finish` verifies all stages are complete, skipped, or explicitly abandoned
  before cleanup.
- `finish` reports unresolved `memory_updates` prompts before deleting or
  archiving the run.
- `finish` prints which durable artifacts should carry forward any important
  knowledge: claims, recipes, graph edges, indexes, or profile traits.
- `prune` deletes completed or abandoned local runs that match the provided
  filters.
- `prune` does not delete active or blocked runs unless explicitly requested.
- Both commands operate only under `.agent-memory/plans` by default.

### Agent Promotes a Reusable Plan

As an agent or user, I can promote a completed one-off run into a canonical
template only when it is reusable:

```bash
bin/memory plans promote plan_run.20260702.auth_oauth_provider_change --to-template
```

Acceptance criteria:

- Promotion writes a reviewable template under `docs/agent-memory/plans`.
- Promotion requires a reusable title, system, and stage goals.
- Promotion strips one-off evidence, branch names, timestamps, and task-specific
  notes unless explicitly preserved as template metadata.
- Promotion does not delete the source run until cleanup is confirmed.
- Promotion output tells the user to validate, review, and commit the generated
  template only if it is truly reusable.

### Agent Uses Profiles Without Loading Large Skills

As an agent, I can ask for applicable profile traits:

```bash
bin/memory profiles match --task "review auth changes" --changed-files app/controllers/api/v6/auth_controller.rb
```

Acceptance criteria:

- The command returns small matched traits with reasons.
- The command does not return a large monolithic profile file.
- Conflicting traits are detected and reported.
- Explicit profile traits override inferred traits when valid.
- Traits are rendered as repository guidance, not hidden instructions.

### Installed Skills Surface the Feature

As an agent using generated repo-memory instructions, I should learn about
contextual workflows without reading feature docs.

Acceptance criteria:

- `init` and `upgrade --write` refresh managed skill content.
- The installed repo-memory skill tells agents to start with
  `context --task`, `context --git-diff`, or `context --plan`.
- The skill explains that recipes, plan stages, and profile traits may be
  included in context output.
- The skill explains that completed one-off plan runs should be finished or
  pruned, and reusable workflows should be promoted explicitly.
- Codex skill installs include optional `references/` files for deeper
  recipe/plan/profile guidance.
- Generic agent instructions include a short equivalent command flow.
- `agent-manifest --json` advertises recipes, plans, profiles, supported
  commands, context flags, and health counts.

## Artifact Requirements

### Recipes

Recipes must remain canonical YAML artifacts.

Required fields:

- `id`
- `title`
- `system`
- `status`
- `intent_triggers`
- `steps`

Recommended fields:

- `summary`
- `required_claims`
- `optional_claims`
- `related_systems`
- `relevant_files`
- `profile_traits`
- `verification`
- `memory_updates`
- `tags`

Validation requirements:

- `id` must be unique.
- `status` must be supported.
- `system` must be valid.
- `required_claims` and `optional_claims` must reference existing claims unless
  strict validation is disabled for proposed drafts.
- `profile_traits` must reference existing profile traits when profiles are
  enabled.
- `relevant_files` must be valid glob or repo-relative paths.
- `intent_triggers` should not be empty for current recipes.
- Broad single-word triggers should warn, not fail, unless strict mode is on.

Retrieval requirements:

- Recipes are indexed for FTS.
- Recipe matching uses triggers, title, summary, steps, tags, system, relevant
  files, required-claim overlap, and explicit IDs.
- Matched recipes are capped by budget.
- Each recipe match includes reasons and score components in JSON.

### Plan Templates

Plan templates are durable YAML artifacts under:

```text
docs/agent-memory/plans/**/*.yaml
```

Required fields:

- `id`
- `title`
- `system`
- `status`
- `stages`

Each stage requires:

- `id`
- `title`
- `goal`

Recommended stage fields:

- `claim_refs`
- `recipe_refs`
- `profile_traits`
- `source_files`
- `verification`
- `done_when`
- `memory_updates`

Validation requirements:

- Template IDs must be unique.
- Stage IDs must be unique within the template.
- Stages must have deterministic order.
- `claim_refs` must reference existing claims.
- `recipe_refs` must reference existing recipes.
- `profile_traits` must reference existing traits.
- Stage source files must be repo-relative paths or valid globs.
- Empty or one-stage templates should warn if they add no value over a recipe.

Retrieval requirements:

- Plan templates are searchable by task, title, system, intent triggers, stage
  titles, stage goals, recipe refs, and source files.
- Suggested plan templates include match reasons.
- Context may suggest plan templates but must not create plan runs unless the
  user or agent invokes a write command.

### Plan Runs

Plan runs are active generated state under:

```text
.agent-memory/plans/**/*.yaml
```

Required fields:

- `id`
- `task`
- `created_at`
- `updated_at`
- `status`
- `current_stage`
- `stages`

Recommended fields:

- `template_id`
- `branch`
- `base_commit`
- `head_commit_at_creation`
- `created_by`
- `notes`

Each stage requires:

- `id`
- `status`

Stage statuses:

- `pending`
- `active`
- `blocked`
- `complete`
- `skipped`
- `abandoned`

Validation requirements:

- Plan runs must be valid YAML.
- Current stage must exist.
- Stage statuses must be valid.
- Completed stages should have evidence.
- Plan runs should warn when resumed on a different branch.
- Plan runs should warn when source template no longer exists or changed
  materially.
- Completed or abandoned runs should be eligible for pruning.
- Completed runs with unresolved `memory_updates` prompts should warn before
  deletion.

Git requirements:

- `.agent-memory/` remains ignored.
- `plans new` must refuse to write plan runs into canonical docs unless an
  explicit template-authoring command is used.
- `plans promote` is the only command that may convert a local plan run into a
  canonical plan template.

### Profile Traits

Profile traits are canonical YAML artifacts under:

```text
docs/agent-memory/profiles/**/*.yaml
```

Required fields:

- `id`
- `title`
- `status`
- `category`
- `priority`
- `applies_when`
- `snippet`

Supported categories:

- `retrieval_bias`
- `output_contract`
- `verification_bias`
- `risk_lens`
- `scope_control`

Supported priorities:

- `low`
- `normal`
- `high`
- `critical`

`applies_when` may include:

- `task_intents`
- `systems`
- `file_globs`
- `claim_types`
- `recipe_ids`
- `plan_template_ids`
- `risk_signals`
- `commands`
- `statuses`

Validation requirements:

- Trait IDs must be unique.
- Snippets must be short. Default hard limit should be 800 characters.
- Critical priority traits should require narrow `applies_when` conditions.
- Traits with no `applies_when` should warn or fail in strict mode.
- Traits that claim to override system, developer, user, AGENTS.md, safety, or
  tool instructions must fail validation.
- Traits with secret-like values or customer data must fail validation.
- `conflicts_with` must reference existing traits.

Retrieval requirements:

- Trait composition should select a small set, default maximum five.
- Explicit traits beat inferred traits.
- More specific traits beat generic traits.
- Conflicting `output_contract` traits should not both be rendered as active.
- Dropped conflicting traits should appear in diagnostics.

## Context Requirements

`context` should support:

```bash
bin/memory context --task "<task>"
bin/memory context --git-diff
bin/memory context --changed-files <files...>
bin/memory context --recipe <recipe-id>
bin/memory context --plan <plan-run-or-template-id>
bin/memory context --stage <stage-id>
bin/memory context --profile auto
bin/memory context --profile <alias>
bin/memory context --profile-trait <trait-id>
```

Markdown output sections:

1. Warnings
2. Active plan stage
3. Matched recipes
4. Selected profile traits
5. Required claims
6. Related claims
7. Relevant files
8. Verification
9. Memory update prompts
10. Diagnostics

JSON output requirements:

- Include `schema_version`.
- Include normalized inputs.
- Include selected items and dropped items.
- Include match reasons.
- Include warnings with stable codes.
- Include command suggestions for inspection and next steps.

Budget requirements:

- `small`: current stage, highest-risk warnings, top recipe, top traits, required
  claims, essential verification.
- `medium`: include related claims, optional recipe claims, and diagnostics.
- `full`: include all selected recipes, related graph expansion within depth,
  profile diagnostics, and plan suggestions.

## Agent Exposure Requirements

### Skills

Generated repo-memory skills must include:

- when to run `context --task`
- when to run `context --git-diff`
- how to use `context --plan`
- how to inspect matched recipes
- how to interpret profile traits
- warning that traits are repo guidance, not hidden higher-priority
  instructions
- warning that plan runs under `.agent-memory` should not be committed
- guidance to finish or prune completed one-off plan runs
- guidance to promote only reusable plan runs into templates
- guidance to run coverage/audit after code changes

Codex-specific installs should generate reference files when supported:

```text
references/contextual-workflows.md
references/recipes.md
references/plans.md
references/profiles.md
```

Acceptance criteria:

- `init` writes these files for new installs.
- `upgrade --write` refreshes managed files.
- Custom user reference files are not overwritten unless `--force` is used.
- Single-agent installs do not regenerate unselected agent instructions.

### Agent Manifest

`agent-manifest --json` must include:

- feature availability
- configured globs
- command names
- context flags
- artifact counts
- active plan run count
- completed or abandoned plan run count
- warnings for missing or invalid workflow artifacts
- warnings for accumulated completed plan runs

This allows agents and wrappers to discover capabilities without scraping help
text.

### Help Output

Help output must cross-link related commands:

- `help context` mentions recipes, plans, and profiles.
- `help recipes` points to `context --recipe`.
- `help plans` points to `context --plan`.
- `help profiles` points to `context --profile`.

## Safety Requirements

- Never execute recipe steps, plan steps, profile snippets, or verification
  commands.
- Treat all Markdown/YAML as data.
- Show profile trait source paths and statuses.
- Do not silently inject profile snippets into hidden prompts.
- Preserve existing system/developer/user/AGENTS.md priority.
- Do not store active plan runs in shared global state.
- Do not treat completed plan runs as durable memory.
- Do not require network access in tests.
- Do not expose local UI endpoints publicly by default.

## Edge Cases

### No Workflow Artifacts Exist

`context` should behave as it does today. It may include a note that no recipes,
plan templates, or profile traits were configured, but this should not be a
warning unless strict mode requires them.

### Multiple Recipes Match

Return only the top matches according to budget. If scores are close, include
diagnostics so a user can improve triggers.

### Broad Recipe Trigger

A trigger like `auth` or `api` should warn because it will overmatch. Strict
mode may fail current recipes with broad triggers.

### Missing Required Claim

Validation should fail for current recipes and plan templates. For proposed
drafts, validation may warn if configured.

### Deprecated Claim Required by Current Recipe

Validation should fail or warn strongly. Context should render a stale/deprecated
warning and include replacement claims when graph edges provide them.

### Conflicting Profile Traits

Do not render two active output contracts that conflict. Pick one by explicit
selection, priority, and specificity. Show the dropped trait in diagnostics.

### Huge Profile Snippet

Validation should fail. Profiles are only useful if they keep context smaller
than loading a skill or broad doc.

### Plan Run Resumed After Rebase

Warn when branch or base commit differs. Do not block, because rebases are
normal, but make the risk visible.

### Plan Template Changed After Run Creation

Warn that the run may be stale. Keep the run usable because it should carry a
snapshot of stages or enough stage data to continue.

### Concurrent Plan Updates

Use atomic writes and a lock file. If lock acquisition fails, return an
actionable error instead of risking YAML corruption.

### Plan Stage Has No Verification

Warn unless the stage is explicitly marked `verification_not_applicable` with a
reason.

### Recipe and Markdown Recipe Claim Drift

If a repository keeps queryable Markdown recipe claims, validation should
eventually detect mismatched status or missing reciprocal references.

### Explicit Profile Alias With No Matches

Return a clear warning. Do not silently fall back to unrelated generic traits.

### Active Plan Run Accidentally Staged

`coverage` or `audit` should warn if `.agent-memory/plans` appears in git
staging, even though `.agent-memory` should normally be ignored.

### Completed Plan Runs Accumulate

`doctor` should warn when completed or abandoned local runs exceed a configured
count or age threshold. The warning should suggest `plans prune`, not a manual
delete.

### Completed Plan Contains Durable Knowledge

`plans finish` should surface unresolved `memory_updates` prompts. The tool
should guide users to move durable knowledge into claims, recipes, graph edges,
indexes, or profile traits before pruning.

### Promotion Would Create a Task-Specific Template

`plans promote` should warn when the source run contains task-specific wording,
branch names, timestamps, evidence, or source diffs that do not belong in a
reusable template.

## Performance Requirements

- Compile should remain fast for small repositories.
- Context retrieval should not scan the full filesystem at runtime.
- Recipe, plan template, and profile trait lookup should use compiled indexes.
- Plan runs may be read from `.agent-memory/plans` on demand.
- JSON output should be generated from the same selection model as Markdown
  output.

## Backward Compatibility

- Existing repositories without `plans` or `profiles` continue to validate.
- Existing recipe files remain valid if they match the current schema.
- New fields should be optional unless needed for current artifacts.
- `sync`, `validate`, `compile`, `query`, `show`, `system`, `context`,
  `coverage`, and `audit` keep current behavior unless new flags are used or
  workflow artifacts are present.

## Documentation Requirements

Documentation should cover:

- artifact models
- command examples
- profile trait safety model
- plan template versus plan run distinction
- how installed skills expose the feature
- migration path for existing recipes
- examples of good and bad triggers
- examples of good and bad profile traits
- edge cases and warnings

## Test Requirements

Tests must cover:

- schema validation for recipes, plan templates, plan runs, and profile traits
- recipe search and ranking
- context automatic recipe inclusion
- context plan-stage inclusion
- profile trait matching and conflict resolution
- missing references
- stale/deprecated status warnings
- plan run creation and atomic updates
- plan finish, prune, and promote lifecycle behavior
- agent skill generation and upgrade
- agent-manifest capability output
- help output references
- JSON output stability
- no network access
- temporary repo behavior

## Open Questions

- Should plan runs snapshot full stage data, or reference template stages and
  only store status/evidence?
- Should profile aliases be configured in `agent-memory.config.yaml` or inferred
  from trait ID prefixes such as `review.*`?
- Should recipe matching support negative triggers such as "not for educator
  auth"?
- Should UI editing support plans and profiles in the first implementation, or
  should CLI support land first?
- Should `context --git-diff` infer a plan stage from changed files if an active
  plan run exists?

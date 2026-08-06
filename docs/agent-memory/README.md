# Agent Memory

This repository uses `agent-memory` for durable agent-readable memory.

Canonical memory lives in:

- `claims/**/*.md`
- `graph/**/*.yaml`
- `indexes/**/*.yaml`
- `recipes/**/*.yaml`
- `plans/**/*.yaml`
- `profiles/**/*.yaml`

Generated memory lives in `.agent-memory/` and should not be committed.

Before creating claims, apply the memory-worthiness gate in the repository instruction file and repo-memory skill. Durable claims should be repository-specific, future-relevant, durable, consequential if forgotten, and evidence-backed. Coverage gaps are prompts to review memory, not reasons to create placeholder claims.

Use `bin/memory new claim` for a safe low-confidence claim draft and `bin/memory new recipe` for a first-class reusable procedure draft. Both start in `needs_review`; replace all TODO values and complete verification before promotion to `current`. Record the full tested Git commit object ID in `last_verified_commit` when a claim is verified; never record a movable ref such as a branch or `HEAD`.

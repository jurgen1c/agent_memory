# Contextual Workflow Future Improvements

Status: future feature backlog

Contextual workflows now have deterministic recipes, plan templates, local plan
runs, profile traits, UI inspection/editing, and governance checks. The ideas
below should stay outside the current implementation until the deterministic
surfaces are proven useful.

## Semantic Matching

Semantic recipe/profile/plan matching through embeddings is tracked separately
in [semantic-embeddings.md](../semantic-embeddings.md). Any future contextual
workflow semantic matching should build on that opt-in embedding design instead
of adding a workflow-specific embedding system.

## LLM-Generated Plan Drafts

An LLM could draft custom plan stages from a task when no template fits well.
This should be draft-only and local by default.

Potential command:

```bash
agent-memory plans draft --task "migrate auth callbacks to OAuth v2"
```

Guardrails:

- Do not write canonical templates automatically.
- Validate generated claim, recipe, profile, and file references.
- Label generated stages as draft content.
- Require explicit user acceptance before creating a plan run.
- Never promote generated stages without human review.

Open questions:

- Which context is safe to send to the model?
- Should this require an explicit provider configuration?
- How should generated stage IDs remain stable enough for review?

## Assisted Promotion

Completed local plan runs can already be promoted explicitly with
`plans promote`. A future assistant could propose a cleaned-up template from a
completed run, but it should not promote automatically.

Guardrails:

- Strip task-specific evidence, branch names, timestamps, and one-off notes.
- Require reusable title, system, and generalized stage goals.
- Show a diff before writing.
- Keep promotion opt-in.

## Archival

Long-term archival of completed one-off plan runs is intentionally not part of
the first implementation. Local plan runs are task state, not durable memory.

If archival is added later, it should answer:

- What retention period is useful?
- Which fields should be removed for privacy and noise reduction?
- How does archival avoid replacing claims, recipes, graphs, indexes, or profile
  traits as durable memory?

## Advanced UI Editing

The current UI editor is intentionally narrow and structured. Future UI work may
add richer forms for full recipe, plan, and profile schemas.

Do not add a free-form YAML editor until:

- validation feedback is inline and actionable
- write actions are token-protected
- generated references remain stable
- users can recover from invalid edits without leaving the UI

## Shared Workflow Libraries

Cross-repo workflow libraries could share recipes, plans, and profile traits
across related repositories. This needs a trust and versioning model first.

Open questions:

- How are shared artifacts versioned?
- Can a consuming repo override or pin shared artifacts?
- How are conflicting profile traits handled?
- How does audit distinguish local ownership from imported guidance?

## Remote Synchronization

Remote sync would move memory artifacts or generated state between machines or
services. This is a large expansion because it introduces authentication,
privacy, conflict resolution, and offline behavior.

Do not add remote sync until local file and git workflows are insufficient.

## Task Transcript Storage

Task transcripts are intentionally deferred. The system should prefer compact
stage evidence and durable memory updates over storing full conversations.

If transcript storage is revisited, it should be opt-in, local-first, and clear
about retention, privacy, and how transcripts differ from canonical memory.

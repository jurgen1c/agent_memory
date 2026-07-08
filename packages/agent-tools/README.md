# Agent Tools

`@jurgen1c/agent-tools` is a lightweight meta package for discovering the
Agent Memory and Agentflow command-line packages.

It does not replace the individual CLIs and it does not depend on either CLI at
runtime. Install the currently published package that owns the command you need:

```bash
npm install --save-dev @jurgen1c/agent-memory-cli
```

## Package Relationships

| CLI package | Current install package | Binary | Purpose |
| --- | --- | --- | --- |
| `@jurgen1c/agent-memory-cli` | `@jurgen1c/agent-memory-cli` | `agent-memory` | Repository-local memory commands for claims, indexes, validation, retrieval, and local UI. |
| `@jurgen1c/agentflow-cli` | `@jurgen1c/agent-memory-cli` while the CLI workspace remains private | `agentflow` | Agentflow workflow commands. Runtime execution commands are introduced independently from Agent Memory. |

The meta package exports package metadata for documentation and tooling, but it
does not create hidden runtime coupling between Agent Memory and Agentflow.

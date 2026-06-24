# Agent Memory

`agent-memory` is a repository-local CLI for maintaining agent-readable memory from canonical Markdown and YAML files.

This repository is being built phase by phase from `agent-memory-tool-development-spec.md`.

## Phase 1 Commands

```bash
bun packages/cli/src/index.ts help
bun packages/cli/src/index.ts --version
```

## Phase 2 Command

```bash
bun packages/cli/src/index.ts init --yes
```

## Phase 3 Commands

```bash
bun packages/cli/src/index.ts templates list
bun packages/cli/src/index.ts templates show claim:constraint
bun packages/cli/src/index.ts new claim --type fact --system auth --title "Student OAuth UID is tenant scoped"
```

## Phase 4 Command

```bash
bun packages/cli/src/index.ts validate
bun packages/cli/src/index.ts validate --json
```

## Phase 5 Command

```bash
bun packages/cli/src/index.ts compile
bun packages/cli/src/index.ts compile --json
```

## Phase 6 Commands

```bash
bun packages/cli/src/index.ts query "student oauth tenant"
bun packages/cli/src/index.ts show auth.student_oauth.uid_is_tenant_scoped --include-related
bun packages/cli/src/index.ts system auth
```

## Phase 7 Command

```bash
bun packages/cli/src/index.ts context --task "fix student oauth"
bun packages/cli/src/index.ts context --changed-files src/auth.js
bun packages/cli/src/index.ts context --git-diff
```

## Phase 8 Commands

```bash
bun packages/cli/src/index.ts doctor
bun packages/cli/src/index.ts sync
bun packages/cli/src/index.ts install-hooks
```

## Phase 9 Commands

```bash
bun packages/cli/src/index.ts coverage --changed-files src/auth.js
bun packages/cli/src/index.ts coverage --git-diff
bun packages/cli/src/index.ts coverage --git-diff --base origin/main
```

Build the executable bundle:

```bash
bun run build
dist/agent-memory.js help
```

Run tests:

```bash
bun test
```

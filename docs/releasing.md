# Releasing Agent Memory

Agent Memory is versioned and released independently from Agent Core, Agent
Flow, and Agentic Development.

Publishing is triggered by a published GitHub Release. Pushing a `vX.Y.Z` tag
alone does not run `.github/workflows/publish.yml`.

## Release checklist

1. Work from a clean, current `main` branch.
2. Confirm the chosen version does not already exist:

   ```bash
   npm view @jurgen1c/agent-memory-cli versions --json
   ```

3. Update the root version, retained private workspace versions, and
   `packages/core/src/generated_version.ts`.
4. Run:

   ```bash
   bun install --frozen-lockfile
   bun run ci
   bun run verify:package
   dist/agent-memory.js help
   dist/agent-memory.js --version
   ```

5. Commit and push `main`.
6. Create and push the matching annotated `vX.Y.Z` tag.
7. Publish a GitHub Release for that tag.
8. Wait for the `Publish package` workflow.
9. Verify:

   ```bash
   npm view @jurgen1c/agent-memory-cli version
   ```

The workflow validates tag and package versions, performs a frozen install,
runs the complete gate, installs the tarball in a clean consumer, and
publishes with public access and npm provenance.

Trusted Publishing must authorize repository `jurgen1c/agent_memory`,
workflow `.github/workflows/publish.yml`, with no environment unless the
workflow is updated to use one.

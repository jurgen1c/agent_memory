# Releasing Agent Memory

Agent Memory is versioned and released independently from the other packages in
the toolchain.

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
   bun run verify:global-cli
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

`verify:global-cli` creates a temporary consuming Git repository and a private
temporary `AGENT_MEMORY_HOME`, then exercises packaged global init, sync,
compile, doctor, context, registry list/show, templates, help, and version
output. It removes both temporary directories when it finishes and does not use
the network. The package verifier repeats that workflow against the installed
tarball.

The workflow validates tag and package versions, performs a frozen install,
runs the complete gate, installs the tarball in a clean consumer, and publishes
with public access and npm provenance.

Configure npm Trusted Publishing for GitHub user `jurgen1c`, repository
`agent_memory`, workflow `publish.yml`, allowed action `npm publish`, and no
environment.

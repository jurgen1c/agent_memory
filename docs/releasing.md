# Releasing

Use this checklist to publish a coordinated Agent Memory and Agentflow release.

Publishing is triggered by a published GitHub Release. Pushing a `vX.Y.Z` tag by itself does not run `.github/workflows/publish.yml`.

## Prerequisites

- Work from `main` after the release changes have been merged.
- Make sure `package.json` contains the version you intend to publish.
- Make sure private workspace package versions match the root package version.
  The `npm version` lifecycle runs `scripts/sync-workspace-versions.mjs --stage`
  for future bumps, but manual edits should keep `packages/*/package.json`
  aligned.
- Make sure npm Trusted Publishing is configured for every public package:
  `@jurgen1c/agent-memory-cli`, `@jurgen1c/agentflow-cli`, and
  `@jurgen1c/agent-tools`.
- Make sure the GitHub workflow named `Publish package` is active.

## Choose the Version

This package follows semantic versioning:

- Patch: bug fixes, docs, and backward-compatible validation or retrieval corrections.
- Minor: backward-compatible commands, templates, schema fields, UI features, or retrieval behavior.
- Major: incompatible CLI, config, schema, or memory format changes.

## Local Verification

Run the release gate before tagging:

```bash
bun run audit
bun run lint
bun test
bun run build
dist/agent-memory.js help
dist/agent-memory.js --version
npm pack --dry-run
npm pack --workspace @jurgen1c/agentflow-cli --dry-run
npm pack --workspace @jurgen1c/agent-tools --dry-run
```

## Create the Version Commit and Tag

From `main`, create the version commit and matching tag:

```bash
npm version patch
```

Use `minor` or `major` instead of `patch` when appropriate.
The version lifecycle syncs `packages/*/package.json` to the root package
version and stages those workspace files before npm creates the release commit.

Push both the version commit and tag:

```bash
git push origin main
git push origin vX.Y.Z
```

Replace `vX.Y.Z` with the tag that `npm version` created, such as `v0.1.1`.

## Publish the GitHub Release

Create a GitHub Release for the pushed tag:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "Release vX.Y.Z"
```

This `release: published` event starts `.github/workflows/publish.yml`.

The workflow verifies that the release tag matches `package.json`, verifies all
public release package versions, installs dependencies, runs audit/lint/tests/build,
dry-runs each public package tarball, and publishes the packages with npm Trusted
Publishing provenance in this deterministic order:

```bash
npm publish --provenance --access public
npm publish --workspace @jurgen1c/agentflow-cli --provenance --access public
npm publish --workspace @jurgen1c/agent-tools --provenance --access public
```

## Monitor the Publish

Watch the workflow:

```bash
gh run list --workflow "Publish package" --limit 5
gh run watch
```

Check npm after it completes:

```bash
npm view @jurgen1c/agent-memory-cli version
npm view @jurgen1c/agentflow-cli version
npm view @jurgen1c/agent-tools version
```

## If You Pushed a Tag but Nothing Ran

That is expected unless a GitHub Release was also published. Create the release for the existing tag:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "Release vX.Y.Z"
```

## If the Version Is Wrong

If the tag was pushed but the release was not published yet, delete the bad tag locally and remotely, then create the correct version:

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```

Only delete or replace a tag before it has been published to npm. Once a version is on npm, publish a new version instead.

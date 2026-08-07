# Global Storage Architecture

Status: approved AM-65 architecture contract for the AM-66 through AM-76 implementation sequence

## Purpose

Agent Memory can be installed once as a global CLI while each repository keeps
its canonical memory in version control. Global mode changes where the generated
SQLite cache and its discovery metadata live. It does not change which files are
the source of truth.

This document is the contract for AM-66 through AM-76. Those stories implement
the resolver, config support, registry, initialization, compatibility,
migration, maintenance commands, hardening, user documentation, and packaged
smoke coverage in that order.

## State Boundaries

| State | Location | Committed | Authority |
| --- | --- | --- | --- |
| Canonical claims, graphs, indexes, recipes, plan templates, profiles, and waivers | `<repo>/docs/agent-memory/` | Yes | Source of truth |
| Repository config | `<repo>/agent-memory.config.yaml` | Yes | Declares memory identity and storage scope |
| Local SQLite cache | `<repo>/.agent-memory/memory.sqlite` by default | No | Rebuildable generated state |
| Global SQLite cache | `<global-home>/databases/<memory-key>/<checkout-fingerprint>/memory.sqlite` | No | Rebuildable generated state |
| Global registry | `<global-home>/registry.json` | No | Rebuildable user-local discovery metadata |
| Active and completed one-off plan runs | `<repo>/.agent-memory/plans/` | No | Repo-local task state |

Global SQLite and registry data must never be treated as canonical memory or
copied into `docs/agent-memory`. Removing either can lose local cache freshness
and registry diagnostics, but `agent-memory sync` can rebuild the database from
the committed canonical files.

Plan runs remain repo-local for this feature. Global mode does not move, share,
or index `.agent-memory/plans` outside the checkout.

## Config Contract

Global storage uses config version 2 as a deliberate compatibility boundary:

```yaml
version: 2
memory_key: jurgen1c-agent-memory
database_scope: global
memory_root: docs/agent-memory
database_path: .agent-memory/memory.sqlite
```

### `memory_key`

`memory_key` is the stable, committed identity of one repository's canonical
memory. Every clone of the same repository reads the same key, while the
checkout fingerprint keeps their generated databases separate.

The value must:

- contain 1 to 128 lowercase ASCII letters, digits, dots, underscores, or
  hyphens;
- start with a lowercase letter or digit; and
- contain no path separators, whitespace, trailing dot, `.` segment, or `..`
  segment.

The validation pattern is
`[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9_-])?`, with `.` and `..` rejected
explicitly. The portion before the first dot must not case-insensitively equal a
Windows device basename: `con`, `prn`, `aux`, `nul`, `com1` through `com9`, or
`lpt1` through `lpt9`. This also rejects forms such as `con.cache`. The value is
then safe to use as one directory component on supported platforms, but
implementations must still join it beneath the resolved global home and verify
containment.

New global-mode initialization derives a candidate from the credential-free,
normalized `origin` repository identity when available (normally
`<owner>-<repository>`), then falls back to the repository directory name. It
slugifies the candidate and writes it to config. After initialization the
committed value is authoritative and must not change automatically when a
checkout moves, a remote changes, or the directory is renamed. The user may
provide an explicit key during initialization or migration.

Initialization validates the slug before writing any file. If derivation
produces an empty, reserved, or overlong value, initialization fails without
partial output and requires an explicit valid `memory_key`; it must not silently
substitute a different repository identity or write an invalid key.

`memory_key` is optional in local mode and required in global mode. It is an
identifier, not a place for credentials, usernames, absolute paths, or other
secrets.

### `database_scope`

`database_scope` accepts exactly `local` or `global`.

- In version 1, missing `database_scope` means `local`. This preserves all
  existing configs without rewriting them.
- In version 2, `database_scope` is required so the storage choice is explicit.
- `local` resolves `database_path` exactly as today: absolute paths remain
  absolute and relative paths resolve from the repository root.
- `global` requires `memory_key` and derives the database path from global home,
  memory key, and checkout fingerprint. It never resolves `database_path` as
  the global cache location.

`database_path` remains valid in a global config as the repository's local-mode
fallback. It is ignored while `database_scope` is `global`, which lets a user
return deliberately to local mode without reconstructing the previous setting.
Global initialization may retain the repo-relative default shown above, but it
must never write a user-specific global path to committed config.

### Schema compatibility

Version 1 remains the legacy local-only contract. Version 2 introduces
`database_scope` and `memory_key`; every supported global config must use
version 2. This deliberate schema migration makes old clients fail closed: an
older CLI that supports only version 1 rejects version 2 before it can ignore
the global fields and accidentally use the local fallback database.

The parser and JSON schema must apply these rules:

| Config shape | Effective behavior |
| --- | --- |
| Version 1 without the new fields | Local mode using existing `database_path` behavior |
| Version 1 with either new field | Config error requiring migration to version 2 |
| Version 2 with `database_scope: local` | Local mode; `memory_key` is optional metadata |
| Version 2 with `database_scope: global` and valid `memory_key` | Global per-checkout cache |
| Version 2 with missing scope, missing required key, or an invalid value | Config error naming the invalid field and allowed form |
| Any unsupported version | Config error before database path resolution |

New global-mode initialization writes version 2. A fresh explicit
wrapper/local compatibility setup may continue to write version 1. Once a
repository migrates to version 2, switching its scope back to `local` does not
silently downgrade the config or restore compatibility with version-1-only
clients.

## Effective Database Resolution

Every command must use the shared resolver introduced by AM-66. Resolution
precedence is:

1. An explicit CLI database override, when the command supports one.
2. `database_path` in effective local mode.
3. The derived registry path in effective global mode.

A relative CLI override resolves from the repository root; an absolute override
remains absolute. An override is transient: it does not rewrite config or
replace the checkout's registry mapping. The resolver reports at least:

- the absolute effective path;
- configured scope (`local` or `global`);
- source (`cli_override`, `local_config`, or `global_registry`);
- `memory_key` when configured; and
- checkout fingerprint in global mode.

The global database path is deterministic:

```text
<global-home>/databases/<memory-key>/<checkout-fingerprint>/memory.sqlite
```

No absolute home directory or user name is written to repository config.

## Global Home

Global home resolves without network access in this order:

1. The non-empty `AGENT_MEMORY_HOME` environment variable.
2. `<os.homedir()>/.agent-memory`.

`AGENT_MEMORY_HOME` must be absolute after normal platform path parsing. A
relative value is rejected with an actionable error rather than being resolved
against a process-dependent working directory. Tests and packaged smoke checks
must always set it to a temporary directory.

Global home is a dedicated Agent Memory directory, not an arbitrary shared
parent. When the resolved directory does not exist, Agent Memory creates it with
user-only permissions. When an override already exists, it must be owned by the
current user and already restrict access to that user where the platform exposes
those checks; otherwise resolution fails with guidance to choose a dedicated
private subdirectory. Agent Memory never changes permissions on a pre-existing
override root such as `/tmp` or a team-owned cache directory.

The initial layout is:

```text
<global-home>/
  registry.json
  registry.lock
  databases/
    <memory-key>/
      <checkout-fingerprint>/
        memory.sqlite
```

Every registry read-modify-write update must acquire the exclusive
`<global-home>/registry.lock` before reading `registry.json`, hold it through
validation, temporary-file write, and rename, and release it in a `finally`
path. Contenders use a short bounded retry and then fail with actionable lock
diagnostics; hooks remain non-blocking and report the skipped refresh. A lock
must not be broken merely because it is old. Stale-lock repair requires proving
that the recorded owner process is no longer running or an explicit maintenance
command. Atomic rename makes lock-free readers see either the old or new complete
document, while the lock prevents concurrent writers from losing entries.

Every global-home directory and every generated file beneath it, including
`registry.json`, `registry.lock`, SQLite databases, SQLite sidecars, and
temporary files, must be restricted to the current user where the platform
supports user-only permissions. Implementations request mode `0700` for
directories and `0600` for files at creation. After validating the dedicated
root, they may repair broader permissions only on recognized Agent Memory paths
created beneath it, never on the pre-existing override root or unrelated paths.
They may add other temporary files beneath global home, but must remove their
own temporary and lock artifacts after successful or failed updates.

## Checkout Fingerprint and Repository Identity

The checkout fingerprint isolates generated caches for multiple clones that
share a `memory_key`. It is the first 24 lowercase hexadecimal characters of
the SHA-256 digest of the checkout's canonical absolute root:

1. Resolve the repository root through the existing repository detector.
2. Resolve symlinks with the platform realpath operation.
3. Remove redundant trailing separators and normalize Windows drive-letter
   casing before hashing.
4. Hash the resulting platform path as UTF-8.

The absolute path and digest are user-local facts. Only the digest appears in
the generated database directory; neither belongs in committed config. A move
produces a new fingerprint and leaves the old record stale, which makes the
move visible and prevents silent reuse of a cache built for another path.

The registry also stores one credential-free repository identity on each memory
record for collision classification and safe cache reuse. Resolve it without
network access in this order:

1. When `origin` exists, normalize its SSH or HTTPS URL to a protocol-qualified
   identity such as `remote:https:<host>/<repository>` or
   `remote:ssh:<account>@<host>/<repository>`. Remove secrets such as embedded
   passwords or tokens, query strings, fragments, trailing `.git`, and redundant
   separators, and compare it case-insensitively where the host does. Retain the
   SSH account because SCP-style paths can be relative to that account's home;
   an SSH remote without an unambiguous account and repository path fails closed.
2. Otherwise, derive a user-local `checkout:<digest>` identity from the
   filesystem identity of the Git common directory or repository root. This
   fallback intentionally does not identify separate clones as the same
   repository.

Full Git root commit IDs may be recorded on checkout entries as diagnostic
metadata. They do not prove that two separately rooted repositories have the
same identity: forks and repositories created from a common template can share
root commits. Root commits therefore never authorize cross-checkout cache reuse
or classify separate active roots as clones.

If none of these inputs can be read, identity is `null`. Global registry
registration and cache reuse then fail closed with guidance to repair the
repository identity or use local mode; implementations must not guess that two
roots or two occupants of the same root are the same repository.

## Registry Contract

`registry.json` is versioned independently from repository config. Its initial
shape is:

```json
{
  "version": 1,
  "memories": {
    "jurgen1c-agent-memory": {
      "repository_identity": "remote:https:github.com/jurgen1c/agent_memory",
      "checkouts": {
        "3f786850e387550fdab836ed": {
          "repo_root": "/Users/example/src/agent_memory",
          "config_path": "/Users/example/src/agent_memory/agent-memory.config.yaml",
          "database_path": "/Users/example/.agent-memory/databases/jurgen1c-agent-memory/3f786850e387550fdab836ed/memory.sqlite",
          "package_version": "0.4.0",
          "config_hash": "sha256:...",
          "git_head": "bb056b5...",
          "last_seen_at": "2026-08-07T12:00:00.000Z"
        }
      }
    }
  }
}
```

Each memory record requires exactly one `repository_identity` field plus its
`checkouts` mapping. `repository_identity` is a non-null string for every usable
global mapping; `null` records may be retained only for diagnostics and repair
and must not authorize database reuse.

Each checkout record requires `repo_root`, `config_path`, `database_path`,
`package_version`, `config_hash`, and `last_seen_at`. `git_head` may be `null`
when unavailable. Timestamps use UTC ISO 8601. Paths are absolute because this
file is user-local generated metadata; registry values are never copied into
committed config. `repository_identity` must not also appear on checkout
records; the memory-record value is the single identity against which every
current checkout is checked.

Stored `database_path` values are diagnostic metadata, not trusted path input.
Before opening, creating, pruning, repairing, or deleting a registered database,
the implementation must re-derive the expected path from the current global
home, memory key, and checkout fingerprint. It requires normalized equality
with the stored path and verifies symlink-aware containment beneath global home,
including by resolving the nearest existing ancestor when the database does not
yet exist. A mismatch or containment failure is registry corruption: fail
closed without touching the stored target and require explicit repair.

Every global database stores provenance in its compile metadata: the memory key,
checkout fingerprint, canonical repository root, exact non-null repository
identity, and config hash used to build it. If the deterministic database exists
without a matching checkout mapping, it is an orphaned, untrusted cache and must
not be opened for reads or adopted merely by recreating the registry entry. It
may be adopted only after its embedded provenance exactly matches the current
checkout. Otherwise an explicit repair or rebuild action must replace it from
canonical memory; ordinary reads and implicit registration fail closed.

The registry must not store claim contents, source document contents,
credentials, environment values, or command arguments. Unknown fields should be
preserved when safely rewriting a recognized registry version so additive
diagnostic metadata remains forward-compatible. An unknown registry version or
invalid top-level shape fails closed with repair guidance; code must not execute
or evaluate registry content.

## Collision and Staleness Policy

Commands first select the current checkout by its configured `memory_key` and
computed checkout fingerprint.

| Situation | Classification | Required behavior |
| --- | --- | --- |
| Same key, fingerprint, canonical root, and exact non-null repository identity | Current checkout | Reuse and refresh its entry |
| Same key, fingerprint, and canonical root but identity differs or is unavailable | Reused root or unverified identity | Fail closed; do not read the old DB and require registry repair |
| Same key, different active roots, same non-null repository identity | Multiple clones | Keep isolated DBs; report both in diagnostics |
| Same key, different active roots, different repository identities | Dangerous key collision | Fail closed; require one repository to choose a new key |
| Same key, multiple active roots, identity missing or ambiguous | Unverified key collision | Fail closed until the user repairs or changes the key |
| Same fingerprint mapped to a different canonical root | Fingerprint collision or corrupt registry | Fail closed and do not read either DB |
| Deterministic DB exists without a matching checkout mapping | Orphaned untrusted cache | Do not read or register it without exact embedded provenance; require explicit repair or rebuild |
| Registered root no longer exists | Stale checkout | Do not select it; offer registry prune or repair guidance |
| Current repo moved to a new root | New checkout plus stale candidate | Create a new isolated mapping; never reuse or delete the old DB automatically |
| Current mapping exists but DB is missing | Missing generated cache | Instruct the user to run `agent-memory compile` or `agent-memory sync` |

An active second clone is not itself an error because its fingerprint gives it a
separate database. It becomes unsafe when repository identity shows that the
same key names unrelated canonical memory, or when identity is insufficient to
prove that the roots are related.

Registry repair and prune operations may remove generated registry metadata and
global databases only after the safety rules in AM-72 and AM-74 are satisfied.
They must never delete `docs/agent-memory`, repository config, local plan runs,
or a custom wrapper.

## Initialization and Migration

Once global initialization is implemented, new CLI-first setup writes
`version: 2`, `database_scope: global`, and a stable `memory_key`. It uses
`agent-memory` in generated hooks and instructions and does not create
`bin/memory` unless the user explicitly requests wrapper/local compatibility
mode.

Existing repositories do not migrate automatically:

- A version 1 config without the new fields continues in local mode.
- Normal config loading, `init`, or `upgrade` must not silently opt it into the
  global registry.
- Migration is dry-run by default and writes `version: 2`, `memory_key`, plus
  `database_scope: global` only with an explicit write option.
- Migration refreshes generated hooks and instructions only under their
  existing overwrite-protection rules.
- Migration never deletes `bin/memory` or the local SQLite database.
- The first global `sync` or `compile` builds a fresh generated cache. Copying a
  local database into global home is not part of the migration contract.
- A failed migration leaves the prior local configuration usable.

Switching deliberately back to `database_scope: local` resumes the configured
`database_path`; global registry state remains generated data that can be pruned
separately.

## Non-Goals

- Storing canonical memory or active plan runs in global home.
- Synchronizing memory, databases, or registry metadata between machines.
- Sharing one SQLite file between clones, worktrees, or unrelated repositories.
- Automatically merging, renaming, or deleting colliding registry entries.
- Automatically migrating existing version 1 repositories to global mode.
- Removing support for `bin/memory`, repo-local package installs, absolute local
  database paths, or explicit local mode.
- Adding network access, user accounts, secrets, encryption, or cloud storage.
- Implementing registry behavior in AM-65; this document defines the contract
  for the following implementation stories.

## Resolved Decisions and Follow-Ups

The architecture questions required before registry coding are resolved here:

- global home precedence and validation;
- version 1 local compatibility and the version 2 global config boundary;
- `memory_key` syntax and generation;
- deterministic per-checkout database paths;
- checkout fingerprint and repository identity inputs;
- registry version and entry shape;
- clone, move, stale entry, and collision behavior;
- generated-versus-canonical state boundaries; and
- explicit, non-destructive migration behavior.

Implementation remains intentionally divided among AM-66 through AM-76. Any
change to these decisions must update this document and its architecture test in
the story that changes the contract before dependent behavior ships.

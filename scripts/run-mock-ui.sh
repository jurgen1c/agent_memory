#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bun run ui:mock -- [options] [agent-memory ui options]

Creates a temporary copy of examples/mock-app and runs the built UI against it.

Options handled by this script:
  --clean       Do not seed extra graph/review demo memory.
  --no-build    Skip bun run build and use existing dist/web UI assets.
  --help        Show this help.

Any other options are passed to agent-memory ui. If no --port is provided,
the script adds --port 0 so the UI picks an available local port.

Examples:
  bun run ui:mock
  bun run ui:mock -- --clean
  bun run ui:mock -- --no-build --port 4317
USAGE
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
build=1
seed_demo=1
ui_args=()

while (($#)); do
  case "$1" in
    --clean)
      seed_demo=0
      ;;
    --no-build)
      build=0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      ui_args+=("$@")
      break
      ;;
    *)
      ui_args+=("$1")
      ;;
  esac
  shift
done

seed_graph_demo() {
  local root="$1"

  mkdir -p \
    "$root/docs/agent-memory/claims/auth" \
    "$root/docs/agent-memory/claims/tenancy" \
    "$root/docs/agent-memory/claims/sessions" \
    "$root/docs/agent-memory/graph" \
    "$root/docs/agent-memory/indexes" \
    "$root/docs/agent-memory/recipes/sessions" \
    "$root/docs/agent-memory/waivers"

  cat > "$root/docs/agent-memory/claims/auth/mfa_required_for_admins.md" <<'CLAIM'
---
id: auth.mfa.required_for_admins
type: rule
system: auth
status: current
confidence: high
severity: critical

title: MFA is required for admins

claim: Admin authentication must include a second factor before privileged actions are allowed.

source_files:
  - src/auth.js

related_files:
  - src/tenant.js

symbols:
  - resolveStudentOAuthIdentity

routes: []

tags:
  - auth
  - mfa
  - admin

verification:
  - bun test

last_verified_commit: null
---

# MFA is required for admins

Admin authentication must include a second factor before privileged actions are allowed.
CLAIM

  cat > "$root/docs/agent-memory/claims/auth/oauth_provider_email_verified.md" <<'CLAIM'
---
id: auth.oauth.provider_email_verified
type: constraint
system: auth
status: needs_review
confidence: medium
severity: important

title: OAuth provider email must be verified

claim: OAuth identities should only trust provider email values when the provider reports the email as verified.

source_files:
  - src/auth.js

related_files: []
symbols:
  - resolveStudentOAuthIdentity
routes: []
tags:
  - auth
  - oauth
  - email

verification:
  - bun test

last_verified_commit: null
---

# OAuth provider email must be verified

OAuth identities should only trust provider email values when the provider reports the email as verified.
CLAIM

  cat > "$root/docs/agent-memory/claims/auth/password_reset_tokens_expire.md" <<'CLAIM'
---
id: auth.password_reset.tokens_expire
type: risk
system: auth
status: proposed
confidence: low
severity: important

title: Password reset tokens expire quickly

claim: Password reset tokens should expire quickly enough to limit replay risk after email compromise.

source_files:
  - src/auth.js

related_files: []
symbols: []
routes: []
tags:
  - auth
  - password-reset
  - risk

verification:
  - bun test

last_verified_commit: null
---

# Password reset tokens expire quickly

Password reset tokens should expire quickly enough to limit replay risk after email compromise.
CLAIM

  cat > "$root/docs/agent-memory/claims/tenancy/tenant_slug_unique.md" <<'CLAIM'
---
id: tenancy.tenant_slug.unique
type: fact
system: tenancy
status: current
confidence: high
severity: normal

title: Tenant slugs are unique

claim: Tenant slugs are unique identifiers used in tenant-aware routing and lookup.

source_files:
  - src/tenant.js

related_files: []
symbols:
  - requireTenant
routes: []
tags:
  - tenancy
  - routing

verification:
  - bun test

last_verified_commit: null
---

# Tenant slugs are unique

Tenant slugs are unique identifiers used in tenant-aware routing and lookup.
CLAIM

  cat > "$root/docs/agent-memory/claims/tenancy/tenant_membership_checked_before_auth.md" <<'CLAIM'
---
id: tenancy.membership.checked_before_auth
type: workflow
system: tenancy
status: current
confidence: high
severity: critical

title: Tenant membership is checked before auth

claim: Authentication flows must confirm tenant membership before granting tenant-scoped access.

source_files:
  - src/tenant.js

related_files:
  - src/auth.js
symbols:
  - requireTenant
routes: []
tags:
  - tenancy
  - membership
  - auth

verification:
  - bun test

last_verified_commit: null
---

# Tenant membership is checked before auth

Authentication flows must confirm tenant membership before granting tenant-scoped access.
CLAIM

  cat > "$root/docs/agent-memory/claims/sessions/session_cookie_http_only.md" <<'CLAIM'
---
id: sessions.cookie.http_only
type: rule
system: sessions
status: current
confidence: high
severity: important

title: Session cookie is HTTP only

claim: Session cookies must be HTTP only so browser JavaScript cannot read bearer session tokens.

source_files:
  - src/auth.js

related_files: []
symbols: []
routes: []
tags:
  - sessions
  - cookies
  - security

verification:
  - bun test

last_verified_commit: null
---

# Session cookie is HTTP only

Session cookies must be HTTP only so browser JavaScript cannot read bearer session tokens.
CLAIM

  cat > "$root/docs/agent-memory/claims/sessions/session_rotation_after_login.md" <<'CLAIM'
---
id: sessions.rotation.after_login
type: workflow
system: sessions
status: needs_verification
confidence: medium
severity: important

title: Session rotates after login

claim: Login should rotate the session identifier to prevent fixation across authentication boundaries.

source_files:
  - src/auth.js

related_files: []
symbols: []
routes: []
tags:
  - sessions
  - login
  - security

verification:
  - bun test

last_verified_commit: null
---

# Session rotates after login

Login should rotate the session identifier to prevent fixation across authentication boundaries.
CLAIM

  cat > "$root/docs/agent-memory/graph/demo-security.yaml" <<'GRAPH'
id: graph.demo_security
name: Demo auth, tenancy, and session relationships

edges:
  - source: auth.student_oauth.uid_is_tenant_scoped
    target: tenancy.current_tenant.required_for_student_auth
    relation: requires
    reason: Student OAuth identity resolution depends on tenant context.
    strength: 95
    bidirectional: false
  - source: auth.oauth.provider_email_verified
    target: auth.student_oauth.uid_is_tenant_scoped
    relation: constrains
    reason: Provider identity details constrain OAuth identity resolution.
    strength: 70
    bidirectional: false
  - source: auth.mfa.required_for_admins
    target: tenancy.membership.checked_before_auth
    relation: requires
    reason: Admin access depends on both strong auth and tenant membership.
    strength: 85
    bidirectional: false
  - source: tenancy.membership.checked_before_auth
    target: tenancy.current_tenant.required_for_student_auth
    relation: same_area
    reason: Both claims protect tenant-scoped access.
    strength: 65
    bidirectional: true
  - source: sessions.rotation.after_login
    target: sessions.cookie.http_only
    relation: same_area
    reason: Both claims reduce session hijacking risk.
    strength: 60
    bidirectional: true
  - source: auth.password_reset.tokens_expire
    target: sessions.rotation.after_login
    relation: explains
    reason: Token replay and session fixation are adjacent authentication risks.
    strength: 45
    bidirectional: false
GRAPH

  cat > "$root/docs/agent-memory/indexes/sessions.yaml" <<'INDEX'
id: sessions
name: Sessions
summary: Session cookie and login-session lifecycle behavior.

claim_globs:
  - claims/sessions/**/*.md

recipe_globs:
  - recipes/sessions/**/*.yaml

default_queries:
  - session cookie
  - login session
  - fixation

watched_files:
  - src/auth.js

tags:
  - sessions
  - security
INDEX

  cat > "$root/docs/agent-memory/recipes/sessions/harden_login_sessions.yaml" <<'RECIPE'
id: recipe.sessions.harden_login_sessions
title: Harden login sessions
system: sessions
status: current

required_claims:
  - sessions.cookie.http_only
  - sessions.rotation.after_login

intent_triggers:
  - change login session
  - harden cookies
  - fix session fixation

relevant_files:
  - src/auth.js

steps:
  - Query current session claims.
  - Keep session cookies HTTP only.
  - Rotate session identifiers after login.

verification:
  - bun test
RECIPE

  cat > "$root/docs/agent-memory/waivers/demo-readme.yaml" <<'WAIVER'
id: waiver.demo_readme
reason: The mock UI README can change without durable memory updates.
scope:
  files:
    - README.md
expires_on: 2099-01-01
WAIVER
}

if ((build)); then
  (cd "$repo_root" && bun run build)
fi

if [[ ! -f "$repo_root/dist/web/index.html" ]]; then
  echo "Missing built UI assets at $repo_root/dist/web. Run bun run build or omit --no-build." >&2
  exit 1
fi

cli="$repo_root/packages/cli/src/index.ts"

tmpdir="$(mktemp -d -t agent-memory-mock-ui-XXXXXX)"
cp -R "$repo_root/examples/mock-app/." "$tmpdir"

if ((seed_demo)); then
  claim="$tmpdir/docs/agent-memory/claims/auth/student_oauth_uid_is_tenant_scoped.md"
  sed -i '0,/^status: current$/s//status: proposed/' "$claim"
  sed -i '0,/^confidence: high$/s//confidence: low/' "$claim"
  seed_graph_demo "$tmpdir"
fi

has_port=0
for arg in "${ui_args[@]}"; do
  if [[ "$arg" == "--port" || "$arg" == --port=* ]]; then
    has_port=1
    break
  fi
done

if ((!has_port)); then
  ui_args=(--port 0 "${ui_args[@]}")
fi

echo "Mock app copied to: $tmpdir"
if ((seed_demo)); then
  echo "Seeded graph demo claims and review queue item: auth.student_oauth.uid_is_tenant_scoped"
fi
echo "Starting Agent Memory UI..."

cd "$tmpdir"
exec bun "$cli" ui "${ui_args[@]}"

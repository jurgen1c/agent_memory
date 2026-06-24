---
id: auth.student_oauth.uid_is_tenant_scoped
type: fact
system: auth
status: current
confidence: high
severity: important

title: Student OAuth UID is tenant scoped

claim: Student OAuth identity resolution depends on both the provider user ID and tenant context.

source_files:
  - src/auth.js

related_files:
  - src/tenant.js

symbols:
  - resolveStudentOAuthIdentity
  - requireTenant

routes: []

tags:
  - auth
  - oauth
  - tenancy

verification:
  - bun test

last_verified_commit: null
---

# Student OAuth UID is tenant scoped

## Claim

Student OAuth identity resolution depends on both the provider user ID and tenant context.

## Why It Matters

Provider user IDs can overlap across tenants, so auth code must retain tenant context.

## Evidence

- `src/auth.js`
- `src/tenant.js`

## Verification

- bun test

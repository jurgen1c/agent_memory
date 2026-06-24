---
id: auth.student_oauth.uid_is_tenant_scoped
type: fact
system: auth
status: current
confidence: high
severity: important

title: Student OAuth UID is tenant scoped

claim: Student OAuth identity resolution depends on the provider user ID and tenant ID.

source_files:
  - src/auth.js

tags:
  - auth
  - oauth
  - tenancy

verification:
  - Run the auth resolver test with duplicate provider user IDs across tenants.

last_verified_commit: null
---

# Student OAuth UID is tenant scoped

## Claim

Student OAuth identity resolution depends on the provider user ID and tenant ID.

## Evidence

- `src/auth.js`

## Verification

- Run the auth resolver test with duplicate provider user IDs across tenants.

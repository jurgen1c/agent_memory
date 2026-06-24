---
id: tenancy.current_tenant.required_for_student_auth
type: constraint
system: tenancy
status: current
confidence: high
severity: critical

title: Current tenant is required for student auth

claim: Student auth requests must resolve a tenant before constructing an OAuth identity.

source_files:
  - src/tenant.js

related_files:
  - src/auth.js

symbols:
  - requireTenant

routes: []

tags:
  - tenancy
  - auth
  - constraint

verification:
  - bun test

last_verified_commit: null
---

# Current tenant is required for student auth

## Claim

Student auth requests must resolve a tenant before constructing an OAuth identity.

## Constraint

Do not call the student OAuth identity resolver without a tenant ID.

## Why It Matters

Missing tenant context can resolve the wrong student when provider user IDs overlap.

## Verification

- bun test

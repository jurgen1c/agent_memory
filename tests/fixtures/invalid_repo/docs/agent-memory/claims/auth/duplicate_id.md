---
id: auth.broken.missing_source
type: fact
system: auth
status: current
confidence: high
severity: normal

title: Duplicate ID claim

claim: >
  This claim intentionally duplicates another claim ID.

source_files:
  - src/auth.js

tags:
  - auth

verification:
  - Confirm duplicate claim IDs are rejected.
---

# Duplicate ID claim

## Claim

This claim intentionally duplicates another claim ID.

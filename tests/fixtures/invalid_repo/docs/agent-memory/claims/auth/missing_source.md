---
id: auth.broken.missing_source
type: fact
system: auth
status: current
confidence: high
severity: normal

title: Missing source claim

claim: >
  This claim intentionally references a missing source file.

source_files:
  - src/missing.js

tags:
  - auth

verification:
  - Confirm the validator detects the missing file.
---

# Missing source claim

## Claim 1

This heading intentionally violates one-claim-per-file rules.

## Claim 2

This second heading should also be rejected.

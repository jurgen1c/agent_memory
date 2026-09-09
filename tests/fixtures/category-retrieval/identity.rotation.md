---
id: "identity.rotation"
type: "fact"
system: "identity"
status: "current"
confidence: "medium"
severity: "important"
title: "Rotate signing keys"
claim: "Rotate signing keys without invalidating active sessions."
tags: ["concern:security"]
source_files: ["src/keys.ts"]
verification: ["bun test tests/identity.test.ts"]
last_verified_commit: null
requires: ["identity.overlap"]
---
## Invariants
Retain previous verification keys through the session lifetime.
## Failure modes
An unknown key rejects authentication without logging the bearer token.

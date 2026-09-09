---
id: "identity.overlap"
type: "fact"
system: "identity"
status: "current"
confidence: "medium"
severity: "important"
title: "Signing key overlap"
claim: "Keep a verification overlap for active sessions during key rotation."
tags: ["concern:security", "concern:reliability"]
source_files: ["src/session.ts"]
verification: ["bun test tests/identity.test.ts"]
last_verified_commit: null
requires: []
---
## Invariants
The overlap must exceed maximum session lifetime.

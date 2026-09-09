---
id: "accounts.diagnostics_retry"
type: "fact"
system: "accounts"
status: "current"
confidence: "medium"
severity: "important"
title: "Diagnostics receipt retry endpoint"
claim: "Retry failed receipt processing from ingestion diagnostics."
tags: ["concern:security", "concern:reliability"]
source_files: ["src/diagnostics-controller.ts"]
verification: ["bun test tests/accounts.test.ts"]
last_verified_commit: null
requires: ["ingestion.recovery"]
---
## Authorization
Require owner or admin in the receipt account.
## Failure modes
A forbidden actor cannot retry; attempts_exhausted leaves dispatch unchanged.

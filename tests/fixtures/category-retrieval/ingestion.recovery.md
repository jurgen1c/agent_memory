---
id: "ingestion.recovery"
type: "fact"
system: "ingestion"
status: "current"
confidence: "medium"
severity: "important"
title: "Receipt retry recovery"
claim: "Bound receipt retry attempts and reuse active processing dispatch."
tags: ["concern:reliability"]
source_files: ["src/recovery.ts"]
verification: ["bun test tests/ingestion.test.ts"]
last_verified_commit: null
requires: ["ingestion.outbox", "accounts.receipt_retry"]
---
## Invariants
Lock the receipt; cap attempts at three; preserve attachment and notification behavior.
## Failure modes
Concurrent duplicate requests reuse active work; exhausted requests do not enqueue.

---
id: "ingestion.outbox"
type: "fact"
system: "ingestion"
status: "current"
confidence: "medium"
severity: "important"
title: "Receipt processing outbox"
claim: "Persist durable receipt dispatch and preserve pipeline handoffs."
tags: ["concern:reliability", "concern:delivery"]
source_files: ["src/outbox.ts"]
verification: ["bun test tests/ingestion.test.ts"]
last_verified_commit: null
requires: []
---
## Invariants
One durable outbox handoff owns processing dispatch; retries reuse it.

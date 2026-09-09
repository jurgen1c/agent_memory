---
id: "accounts.receipt_retry"
type: "fact"
system: "accounts"
status: "current"
confidence: "medium"
severity: "important"
title: "Receipt retry endpoint"
claim: "Retry failed receipt processing from receipt detail."
tags: ["concern:security", "concern:reliability"]
source_files: ["src/receipts-controller.ts"]
verification: ["bun test tests/accounts.test.ts"]
last_verified_commit: null
requires: ["ingestion.recovery", "accounts.diagnostics_retry"]
---
## Authorization
Require actor_user_id(owner|admin) and an account-scoped receipt lookup.
## Inputs and outputs
Input receipt_id and actor_user_id. Return reused_dispatch or queued.
## Invariants
Keep storage usage, attachment identity, notifications and Spanish/English messages.
## Failure modes
attempts_exhausted and forbidden never enqueue work.

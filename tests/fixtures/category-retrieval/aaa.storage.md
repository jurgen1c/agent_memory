---
id: "aaa.storage"
type: "fact"
system: "storage"
status: "current"
confidence: "medium"
severity: "important"
title: "Storage usage overview"
claim: "Storage attachment notifications processing Spanish English account usage report."
tags: ["concern:billing"]
source_files: ["src/storage.ts"]
verification: ["bun test tests/storage.test.ts"]
last_verified_commit: null
requires: []
---
## Details
Report storage usage only. This does not authorize endpoint retries.

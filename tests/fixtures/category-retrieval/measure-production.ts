/** Explicit offline production evidence runner; disposable canonical fixtures only. */
import fs from "node:fs";
import { compileMemory, queryClaims, queryClaimsV2 } from "../../../packages/core/src/index";
import { productionFixture } from "./production";
import { requiredIds, tasks } from "./corpus";

const rows: unknown[] = [];
for (const variant of ["original", "corrected"] as const) {
  const cwd = productionFixture(variant);
  try {
    await compileMemory({ cwd });
    const legacy = await queryClaims({ cwd, query: "actor_user_id", limit: 20, includeStale: false });
    rows.push({ variant, probe: "legacy_body_disabled", ids: legacy.matches.map(claim => claim.id) });
    for (const [probe, request] of Object.entries({ full: { task: tasks.full }, short: { task: tasks.short }, files: { changedFiles: ["src/receipts-controller.ts", "src/diagnostics-controller.ts"] }, taskFiles: { task: tasks.full, changedFiles: ["src/receipts-controller.ts", "src/diagnostics-controller.ts"] }, body: { task: "actor_user_id" }, heldOut: { task: tasks.heldOut }, negative: { task: "zzznomatchxyz" } })) {
      const result = await queryClaimsV2({ cwd, ...request, budget: "medium" });
      if (result.exitCode !== 0) throw new Error(result.stdout);
      const ids = result.model.claims.map(claim => claim.id);
      rows.push({ variant, probe, ids, roots: result.model.roots, taskMatches: result.model.taskMatches, referenceHits: requiredIds.filter(id => ids.includes(id)).length, identityHits: ["identity.rotation", "identity.overlap"].filter(id => ids.includes(id)).length, bytes: result.model.budget.usedBytes, completeness: result.model.completeness, warnings: result.model.warnings });
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}
console.log(JSON.stringify(rows, null, 2));

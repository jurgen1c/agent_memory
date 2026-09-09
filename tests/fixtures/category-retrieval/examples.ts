/** Complete JSON design examples; not a public CLI adapter. */
import { corpus } from "./corpus";
import { adoptionPlan, caps, gitDiagnostic, retrieve } from "./prototype";
const stress = corpus();
stress.find(claim => claim.id === "ingestion.outbox")!.body += 'ñ😀\\"\n'.repeat(4000);
const baseline = corpus();
baseline.find(claim => claim.id === "legacy.notes")!.baseline = true;
const examples = {
  normal: retrieve(corpus(), { task: "receipt retry" }),
  browse: retrieve(corpus(), { categories: ["reliability"], systems: ["ingestion"] }),
  invalidCategory: { schemaVersion: 2, error: { code: "UNKNOWN_CATEGORY", message: "Unknown category SECURITY; browse categories list." }, exitCode: 2 },
  noMatch: retrieve(corpus(), { task: "zzzauditnohitxyz", maxBytes: caps.small }),
  baseline: retrieve(baseline, { task: "zzzauditnohitxyz", baseline: true, maxBytes: caps.small }),
  truncated: retrieve(stress, { files: ["src/receipts-controller.ts"], maxBytes: caps.small }),
  unknownObject: gitDiagnostic({ status: 0, stdout: "a".repeat(40) + " missing", unknownObject: true }),
  unavailableGit: gitDiagnostic({ error: "EPERM", status: 0, stdout: "a".repeat(40) }),
  adoption: adoptionPlan(corpus("original"), "global"),
  calibration: {
    small: retrieve(corpus(), { systems: ["identity"], maxBytes: caps.full }).budget.usedBytes,
    medium: retrieve(corpus(), { files: ["src/receipts-controller.ts"] }, ["src/"]).budget.usedBytes,
    full: retrieve(stress, { files: ["src/receipts-controller.ts"], maxBytes: caps.full }).budget.usedBytes
  }
};
console.log(JSON.stringify(examples, null, 2));

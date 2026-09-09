import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readClaim, type Claim } from "./prototype";
const directory = path.dirname(fileURLToPath(import.meta.url));
export const requiredIds = ["accounts.receipt_retry", "accounts.diagnostics_retry", "ingestion.recovery", "ingestion.outbox"];
export const tasks = {
  full: "Make failed receipt retries safe against duplicate requests while preserving account role authority bounded retries existing processing dispatch attachment storage usage notifications and Spanish English behavior",
  short: "receipt retry",
  heldOut: "rotate signing keys without invalidating active sessions"
};
export function corpus(variant: "original" | "corrected" = "corrected"): Claim[] {
  return fs.readdirSync(directory).filter(name => name.endsWith(".md")).sort().map(name => {
    const claim = readClaim(fs.readFileSync(path.join(directory, name), "utf8"), `docs/agent-memory/claims/${name}`);
    if (variant === "original" && claim.id.startsWith("accounts.")) {
      claim.claim = "This interaction preserves the documented data contract and failure modes.";
      claim.tags = [claim.id];
      claim.source_files = ["src/remove-member.ts"];
    }
    return claim;
  });
}

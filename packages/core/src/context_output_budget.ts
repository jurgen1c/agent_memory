import type { ContextOutputModel } from "./context_output_types";

type OutputList = "roots" | "claims" | "edges" | "files" | "commands" | "recipes" | "plans" | "profiles";
const lists: OutputList[] = ["roots", "claims", "edges", "files", "commands", "recipes", "plans", "profiles"];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Internal accounting for immutable candidate records and mutable retained lists. */
export class ContextOutputByteCounter {
  private readonly baseBytes: number;
  private readonly baseBudgetBytes: number;
  private readonly totals = new Map<OutputList, { bytes: number; count: number }>();
  private readonly encoded = new Map<unknown, number>();

  constructor(model: ContextOutputModel) {
    const empty = { ...model, roots: [], claims: [], edges: [], files: [], commands: [],
      recipes: { ...model.recipes, items: [] }, plans: { ...model.plans, items: [] }, profiles: { ...model.profiles, items: [] },
      warnings: [], completeness: "complete", budget: { ...model.budget, usedBytes: 0 } };
    this.baseBytes = bytes(empty) + 1;
    this.baseBudgetBytes = bytes(empty.budget);
    for (const name of lists) {
      const items = name === "recipes" || name === "plans" || name === "profiles" ? model[name].items : model[name];
      this.totals.set(name, { bytes: items.reduce((total, item) => total + this.recordBytes(item), 0), count: items.length });
    }
  }

  recordBytes(value: unknown): number {
    let size = this.encoded.get(value);
    if (size === undefined) { size = bytes(value); this.encoded.set(value, size); }
    return size;
  }

  remove(name: OutputList, value: unknown): void { this.removeBytes(name, this.recordBytes(value)); }

  removeBytes(name: OutputList, size: number): void {
    const total = this.totals.get(name)!;
    total.count--;
    total.bytes -= size;
  }

  shrink(name: OutputList, size: number): void { this.totals.get(name)!.bytes -= size; }

  measure(model: ContextOutputModel): number {
    const arrayBytes = [...this.totals.values()].reduce((sum, list) => sum + list.bytes + Math.max(0, list.count - 1), 0);
    const fixed = this.baseBytes + arrayBytes + bytes(model.warnings) - 2 + (model.completeness === "incomplete" ? 2 : 0);
    let usedBytes = 0;
    for (;;) {
      const total = fixed + bytes({ ...model.budget, usedBytes }) - this.baseBudgetBytes;
      if (total === usedBytes) return total;
      usedBytes = total;
    }
  }
}

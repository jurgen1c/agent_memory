import crypto from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { ContextOutputSection } from "./context_output_types";

export const normalizeClaimBody = (body: string): string => body.replace(/\r\n?/g, "\n");
export const claimBodyDigest = (body: string): string => crypto.createHash("sha256").update(normalizeClaimBody(body)).digest("hex");

/** CommonMark supplies heading positions; slicing preserves authored bytes, including code. */
export function parseClaimSections(input: string): ContextOutputSection[] {
  const body = normalizeClaimBody(input);
  const headings: Array<{ heading: string; offset: number; line: number }> = [];
  const tree = fromMarkdown(body);
  const text = (node: { value?: string; children?: unknown[] }): string => node.value ?? (node.children ?? []).map(child => text(child as typeof node)).join("");
  const visit = (node: { type: string; children?: unknown[]; position?: { start: { offset?: number; line: number } } }) => {
    if (node.type === "heading" && node.position?.start.offset !== undefined) headings.push({ heading: text(node), offset: node.position.start.offset, line: node.position.start.line });
    for (const child of node.children ?? []) visit(child as typeof node);
  };
  visit(tree);
  const starts = headings.length && headings[0].offset === 0 ? headings : [{ heading: "preamble", offset: 0, line: 1 }, ...headings];
  const occurrences = new Map<string, number>();
  return starts.map((start, index) => {
    const occurrence = (occurrences.get(start.heading) ?? 0) + 1;
    occurrences.set(start.heading, occurrence);
    return { heading: start.heading, occurrence, startLine: start.line, text: body.slice(start.offset, starts[index + 1]?.offset ?? body.length) };
  }).filter(section => section.text.length > 0);
}

export function claimSearchTokens(text: string): string[] {
  return [...new Set(text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].sort();
}

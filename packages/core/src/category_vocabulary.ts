import { ConfigError } from "./errors";

/** Repository extensions cannot redefine these reviewed meanings. */
export const BUILTIN_CATEGORY_VOCABULARY: Readonly<Record<string, string>> = Object.freeze({
  security: "Authority, privacy, and access constraints",
  reliability: "Recovery, idempotency, and durable handoffs",
  billing: "Charges, entitlements, and usage accounting",
  localization: "Language and locale behavior",
  delivery: "Review and verification requirements"
});
export const UNCATEGORIZED_DESCRIPTION = "Claims without a concern tag";
export function isCategorySlug(value: string): boolean {
  return value.length <= 48 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}
export function readCategoryVocabulary(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("category_vocabulary must be a mapping of slugs to descriptions.");
  const entries = Object.entries(value);
  for (const [slug, description] of entries) {
    if (!isCategorySlug(slug) || slug === "uncategorized") throw new ConfigError("category_vocabulary slugs must match [a-z][a-z0-9]*(?:-[a-z0-9]+)*, at most 48 ASCII bytes; uncategorized is reserved.");
    if (Object.hasOwn(BUILTIN_CATEGORY_VOCABULARY, slug)) throw new ConfigError(`category_vocabulary cannot redefine built-in ${slug}.`);
    if (typeof description !== "string" || !description.trim() || Buffer.byteLength(description, "utf8") > 512) throw new ConfigError("category_vocabulary descriptions must be nonempty strings of at most 512 UTF-8 bytes.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
export function categoryVocabulary(extension?: Record<string, string>): Record<string, string> {
  return { ...BUILTIN_CATEGORY_VOCABULARY, ...extension, uncategorized: UNCATEGORIZED_DESCRIPTION };
}
export function claimCategories(tags: string[]): string[] {
  const categories = [...new Set(tags.filter(tag => tag.startsWith("concern:")).map(tag => tag.slice(8)))];
  return categories.length ? categories.sort() : ["uncategorized"];
}

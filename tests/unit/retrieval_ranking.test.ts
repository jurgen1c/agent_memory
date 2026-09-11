import { expect, test } from "bun:test";
import { rankClaimsV2, codePointCompare } from "../../packages/core/src/retrieval_ranking";
import type { CachedClaim, RetrievalCache } from "../../packages/core/src/retrieval_cache";

test("prefix evidence groups postings in linear work and scores each distinct token once", () => {
  const count = 10_000;
  let idReads = 0;
  let postingReads = 0;
  const claims: CachedClaim[] = Array.from({ length: count }, (_, index) => ({
    get id() { idReads++; return `test.${String(index).padStart(5, "0")}`; },
    title: "alpha", claim: "alpha", status: "current", system: "test", sourcePath: `claims/${index}.md`, memoryPath: `claims/${index}.md`, tags: [], sections: [], associations: { files: [], symbols: [], routes: [] }, relatedFiles: [], verification: []
  }));
  const terms = claims.flatMap(claim => {
    const id = claim.id;
    return Array.from({ length: 20 }, (_, index) => ({ get claim_id() { postingReads++; return id; }, field: "title", section_ordinal: -1, token: `alpha${index}` }));
  });
  const cache = { claims, terms, edges: [], indexes: [] } as unknown as RetrievalCache;
  const roots = rankClaimsV2(cache, { task: "alp alp", files: [], symbols: [], routes: [], browse: false });
  expect(roots).toHaveLength(count);
  expect(roots[0].claimId).toBe("test.00000");
  expect(roots[0].evidence!.textScore).toBe(Math.log(1 + count / (1 + count)));
  expect(roots[0].evidence!.matchedTokens).toEqual(["alp"]);
  expect(roots[0].evidence!.fields).toEqual([{ field: "title" }]);
  expect(idReads).toBeLessThan(count * 20);
  expect(postingReads).toBeLessThan(terms.length * 10);
  expect(codePointCompare("\uE000", "\u{10000}")).toBeLessThan(0);
});

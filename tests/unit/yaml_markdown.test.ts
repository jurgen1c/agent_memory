import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../../packages/core/src/markdown";
import { parseYaml } from "../../packages/core/src/yaml";

describe("parseYaml", () => {
  test("parses folded block scalars", () => {
    const parsed = parseYaml(`claim: >
  Student OAuth identity resolution depends on tenant context.
  The provider ID alone is not sufficient.
tags:
  - auth
`);

    expect(parsed).toEqual({
      claim: "Student OAuth identity resolution depends on tenant context. The provider ID alone is not sufficient.",
      tags: ["auth"]
    });
  });
});

describe("parseMarkdown", () => {
  test("parses YAML frontmatter and body", () => {
    const parsed = parseMarkdown(`---
id: auth.example
claim: >
  Example claim.
---

# Example
`);

    expect(parsed.frontmatter).toEqual({
      id: "auth.example",
      claim: "Example claim."
    });
    expect(parsed.body).toContain("# Example");
  });
});

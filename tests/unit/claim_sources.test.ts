import { describe, expect, test } from "bun:test";
import { evaluateClaimSourcePath } from "../../packages/core/src/claim_sources";

describe("claim source policy", () => {
  test("allows every repository path when allow and deny are empty", () => {
    expect(evaluateClaimSourcePath("src/auth.ts", { allow: [], deny: [] })).toEqual({
      eligible: true,
      reason: "allowed"
    });
  });

  test("requires allow matches when an allowlist is configured", () => {
    expect(evaluateClaimSourcePath("src/auth.ts", { allow: ["src/**"], deny: [] })).toMatchObject({
      eligible: true,
      reason: "allowed",
      pattern: "src/**"
    });
    expect(evaluateClaimSourcePath("docs/notes.md", { allow: ["src/**"], deny: [] })).toEqual({
      eligible: false,
      reason: "not_allowed"
    });
  });

  test("gives deny patterns precedence and normalizes path separators", () => {
    expect(
      evaluateClaimSourcePath("src\\generated\\client.ts", {
        allow: ["src/**"],
        deny: ["src/generated/**"]
      })
    ).toEqual({
      eligible: false,
      reason: "denied",
      pattern: "src/generated/**"
    });
  });

  test("normalizes dot segments before applying allow and deny patterns", () => {
    expect(
      evaluateClaimSourcePath("src/../vendor/secret.ts", {
        allow: ["src/**"],
        deny: ["vendor/**"]
      })
    ).toEqual({
      eligible: false,
      reason: "denied",
      pattern: "vendor/**"
    });

    expect(
      evaluateClaimSourcePath("src/nested/../../docs/notes.md", {
        allow: ["src/**"],
        deny: []
      })
    ).toEqual({
      eligible: false,
      reason: "not_allowed"
    });
  });
});

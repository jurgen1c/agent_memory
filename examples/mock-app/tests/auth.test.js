import { describe, expect, test } from "bun:test";
import { resolveStudentOAuthIdentity } from "../src/auth.js";

describe("resolveStudentOAuthIdentity", () => {
  test("scopes provider user IDs by tenant", () => {
    expect(resolveStudentOAuthIdentity({ providerUserId: "student-1", tenantId: "north" }).uid).toBe("north:student-1");
    expect(resolveStudentOAuthIdentity({ providerUserId: "student-1", tenantId: "south" }).uid).toBe("south:student-1");
  });
});

import { describe, expect, test } from "bun:test";
import { buildGraph } from "../../packages/web/src/App";

describe("graph layout", () => {
  test("separates claims in the same system into distinct rows", () => {
    const claims = [
      claim("auth.first", "auth", "First auth claim"),
      claim("auth.second", "auth", "Second auth claim"),
      claim("billing.first", "billing", "First billing claim"),
      claim("auth.third", "auth", "Third auth claim")
    ];

    const graph = buildGraph(claims, [], new Set(claims.map((item) => item.id)), new Set(["explicit"]));
    const authNodes = graph.nodes.filter((node) => String(node.id).startsWith("auth."));
    const authRows = new Set(authNodes.map((node) => node.position.y));

    expect(authNodes).toHaveLength(3);
    expect(authRows.size).toBe(3);
    expect(authNodes[1].position.y - authNodes[0].position.y).toBeGreaterThanOrEqual(180);
    expect(authNodes[2].position.y - authNodes[1].position.y).toBeGreaterThanOrEqual(180);
  });

  test("renders reciprocal bidirectional relations as one two-way edge", () => {
    const claims = [
      claim("auth.first", "auth", "First auth claim"),
      claim("auth.second", "auth", "Second auth claim")
    ];
    const relations = [
      relation("explicit:auth.first:same_area:auth.second", "auth.first", "auth.second", true),
      relation("explicit:auth.second:same_area:auth.first", "auth.second", "auth.first", true)
    ];

    const graph = buildGraph(claims, relations, new Set(claims.map((item) => item.id)), new Set(["explicit"]));

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].markerStart).toBeDefined();
    expect(graph.edges[0].markerEnd).toBeDefined();
  });

  test("aligns related claims from different systems when rows are available", () => {
    const claims = [
      claim("auth.first", "auth", "First auth claim"),
      claim("auth.unrelated", "auth", "Unrelated auth claim"),
      claim("billing.first", "billing", "First billing claim")
    ];
    const relations = [relation("explicit:auth.first:requires:billing.first", "auth.first", "billing.first", false)];

    const graph = buildGraph(claims, relations, new Set(claims.map((item) => item.id)), new Set(["explicit"]));
    const authNode = graph.nodes.find((node) => node.id === "auth.first");
    const billingNode = graph.nodes.find((node) => node.id === "billing.first");

    expect(authNode?.position.y).toBe(billingNode?.position.y);
  });

  test("places related claims in the same system on nearby rows", () => {
    const claims = [
      claim("auth.first", "auth", "First auth claim"),
      claim("auth.unrelated", "auth", "Unrelated auth claim"),
      claim("auth.second", "auth", "Second auth claim")
    ];
    const relations = [relation("explicit:auth.first:same_area:auth.second", "auth.first", "auth.second", true)];

    const graph = buildGraph(claims, relations, new Set(claims.map((item) => item.id)), new Set(["explicit"]));
    const firstNode = graph.nodes.find((node) => node.id === "auth.first");
    const secondNode = graph.nodes.find((node) => node.id === "auth.second");

    expect(firstNode).toBeDefined();
    expect(secondNode).toBeDefined();
    expect(Math.abs((firstNode?.position.y ?? 0) - (secondNode?.position.y ?? 0))).toBe(190);
  });
});

function claim(id: string, system: string, title: string) {
  return {
    id,
    system,
    title,
    status: "current",
    severity: "normal"
  } as never;
}

function relation(id: string, source: string, target: string, bidirectional: boolean) {
  return {
    id,
    source,
    target,
    relation: "same_area",
    strength: 60,
    origin: "explicit",
    bidirectional
  } as never;
}

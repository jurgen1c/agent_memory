import { describe, expect, test } from "bun:test";
import { buildExpandedClaimGraph, buildGraph, moveSystemChildren } from "../../packages/web/src/App";

type GraphSummary = Parameters<typeof buildGraph>[0];
type SystemGraph = Parameters<typeof buildGraph>[1][string];
type GraphClaim = Parameters<typeof buildExpandedClaimGraph>[0][number];
type GraphRelation = Parameters<typeof buildExpandedClaimGraph>[1][number];

describe("graph layout", () => {
  test("renders collapsed systems before claims are loaded", () => {
    const summary = graphSummary();
    const graph = buildGraph(summary, {}, new Set(), new Set(["explicit"]));

    expect(graph.nodes.map((node) => node.id)).toEqual(["system:auth", "system:billing"]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].source).toBe("system:auth");
    expect(graph.edges[0].target).toBe("system:billing");
  });

  test("renders expanded claim nodes and only shows claim relations when both claims are visible", () => {
    const authClaim = claim("auth.first", "auth", "First auth claim");
    const billingClaim = claim("billing.first", "billing", "First billing claim");
    const graphRelation = relation("explicit:auth.first:requires:billing.first", "auth.first", "billing.first", false, "requires");
    const systemGraphs = {
      auth: systemGraph("auth", [authClaim], [graphRelation]),
      billing: systemGraph("billing", [billingClaim], [graphRelation])
    };

    const authOnly = buildGraph(graphSummary(), systemGraphs, new Set(["auth"]), new Set(["explicit"]));
    expect(authOnly.nodes.map((node) => node.id)).toEqual(["system:auth", "system:billing", "claim:auth.first"]);
    expect(authOnly.edges.map((edge) => edge.id)).toEqual([
      "system-claim:auth:auth.first",
      "system:explicit:requires:auth:billing"
    ]);

    const bothExpanded = buildGraph(graphSummary(), systemGraphs, new Set(["auth", "billing"]), new Set(["explicit"]));
    expect(bothExpanded.nodes.map((node) => node.id)).toEqual(["system:auth", "system:billing", "claim:auth.first", "claim:billing.first"]);
    expect(bothExpanded.edges.map((edge) => edge.id)).toEqual([
      "system-claim:auth:auth.first",
      "system-claim:billing:billing.first",
      "explicit:auth.first:requires:billing.first"
    ]);
    expect(bothExpanded.edges[2].source).toBe("claim:auth.first");
    expect(bothExpanded.edges[2].target).toBe("claim:billing.first");
  });

  test("moves loaded claim children with their system parent", () => {
    const authClaim = claim("auth.first", "auth", "First auth claim");
    const billingClaim = claim("billing.first", "billing", "First billing claim");
    const graph = buildGraph(
      graphSummary(),
      {
        auth: systemGraph("auth", [authClaim], []),
        billing: systemGraph("billing", [billingClaim], [])
      },
      new Set(["auth", "billing"]),
      new Set(["explicit"])
    );
    const moved = moveSystemChildren(graph.nodes, "auth", { x: 24, y: 12 });
    const originalAuth = graph.nodes.find((node) => node.id === "claim:auth.first");
    const movedAuth = moved.find((node) => node.id === "claim:auth.first");
    const originalBilling = graph.nodes.find((node) => node.id === "claim:billing.first");
    const movedBilling = moved.find((node) => node.id === "claim:billing.first");

    expect(movedAuth?.position).toEqual({
      x: (originalAuth?.position.x ?? 0) + 24,
      y: (originalAuth?.position.y ?? 0) + 12
    });
    expect(movedBilling?.position).toEqual(originalBilling?.position);
  });

  test("spaces expanded claim children without overlapping node boxes", () => {
    const claims = [
      claim("auth.first", "auth", "First auth claim"),
      claim("auth.second", "auth", "Second auth claim"),
      claim("auth.third", "auth", "Third auth claim"),
      claim("auth.fourth", "auth", "Fourth auth claim")
    ];
    const graph = buildGraph(
      graphSummary(),
      {
        auth: systemGraph("auth", claims, [])
      },
      new Set(["auth"]),
      new Set(["explicit"])
    );
    const claimNodes = graph.nodes.filter((node) => String(node.id).startsWith("claim:"));

    for (let left = 0; left < claimNodes.length; left += 1) {
      for (let right = left + 1; right < claimNodes.length; right += 1) {
        expect(nodesOverlap(claimNodes[left], claimNodes[right], 184, 58)).toBe(false);
      }
    }
  });

  test("spaces dense adjacent expanded systems without claim or parent overlaps", () => {
    const systems = ["admin", "analytics", "auth", "billing", "exports", "ingestion", "integrations", "notifications", "reporting", "search", "sessions", "tenancy"];
    const summary: GraphSummary = {
      systems: systems.map((system) => ({
        id: system,
        system,
        color: "#2563eb",
        claimCount: 20,
        statusCounts: { current: 20 },
        severityCounts: { normal: 20 },
        reviewCount: 0
      })),
      systemRelations: []
    };
    const systemGraphs = Object.fromEntries(
      systems.map((system) => [system, systemGraph(system, Array.from({ length: 20 }, (_value, index) => claim(`${system}.claim_${index}`, system, `${system} claim ${index}`)), [])])
    );
    const graph = buildGraph(summary, systemGraphs, new Set(systems), new Set(["explicit"]));
    const layoutNodes = graph.nodes.filter((node) => String(node.id).startsWith("system:") || String(node.id).startsWith("claim:"));

    for (let left = 0; left < layoutNodes.length; left += 1) {
      for (let right = left + 1; right < layoutNodes.length; right += 1) {
        expect(layoutBoxesOverlap(layoutNodeBox(layoutNodes[left]), layoutNodeBox(layoutNodes[right]))).toBe(false);
      }
    }
  });

  test("collapses repeated parent relations into one larger readable label", () => {
    const graph = buildGraph(
      {
        ...graphSummary(),
        systemRelations: [
          {
            id: "system:explicit:requires:auth:billing",
            source: "auth",
            target: "billing",
            relation: "requires",
            origin: "explicit",
            count: 1,
            strength: 95,
            bidirectional: false
          },
          {
            id: "system:explicit:verifies:billing:auth",
            source: "billing",
            target: "auth",
            relation: "verifies",
            origin: "explicit",
            count: 1,
            strength: 60,
            bidirectional: false
          }
        ]
      },
      {},
      new Set(),
      new Set(["explicit"])
    );

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].label).toBe("2 relations");
    expect(graph.edges[0].markerStart).toBeDefined();
    expect(graph.edges[0].labelStyle).toMatchObject({ fontSize: 13 });
  });

  test("separates claims in the same system into distinct rows", () => {
    const claims = [
      claim("auth.first", "auth", "First auth claim"),
      claim("auth.second", "auth", "Second auth claim"),
      claim("billing.first", "billing", "First billing claim"),
      claim("auth.third", "auth", "Third auth claim")
    ];

    const graph = buildExpandedClaimGraph(claims, [], new Set(claims.map((item) => item.id)), new Set(["explicit"]));
    const authNodes = graph.nodes.filter((node) => String(node.id).startsWith("claim:auth."));
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

    const graph = buildExpandedClaimGraph(claims, relations, new Set(claims.map((item) => item.id)), new Set(["explicit"]));

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
    const relations = [relation("explicit:auth.first:requires:billing.first", "auth.first", "billing.first", false, "requires")];

    const graph = buildExpandedClaimGraph(claims, relations, new Set(claims.map((item) => item.id)), new Set(["explicit"]));
    const authNode = graph.nodes.find((node) => node.id === "claim:auth.first");
    const billingNode = graph.nodes.find((node) => node.id === "claim:billing.first");

    expect(authNode?.position.y).toBe(billingNode?.position.y);
  });

  test("places related claims in the same system on nearby rows", () => {
    const claims = [
      claim("auth.first", "auth", "First auth claim"),
      claim("auth.unrelated", "auth", "Unrelated auth claim"),
      claim("auth.second", "auth", "Second auth claim")
    ];
    const relations = [relation("explicit:auth.first:same_area:auth.second", "auth.first", "auth.second", true)];

    const graph = buildExpandedClaimGraph(claims, relations, new Set(claims.map((item) => item.id)), new Set(["explicit"]));
    const firstNode = graph.nodes.find((node) => node.id === "claim:auth.first");
    const secondNode = graph.nodes.find((node) => node.id === "claim:auth.second");

    expect(firstNode).toBeDefined();
    expect(secondNode).toBeDefined();
    expect(Math.abs((firstNode?.position.y ?? 0) - (secondNode?.position.y ?? 0))).toBe(190);
  });
});

function graphSummary(): GraphSummary {
  return {
    systems: [
      {
        id: "auth",
        system: "auth",
        color: "#0f766e",
        claimCount: 1,
        statusCounts: { current: 1 },
        severityCounts: { normal: 1 },
        reviewCount: 0
      },
      {
        id: "billing",
        system: "billing",
        color: "#2563eb",
        claimCount: 1,
        statusCounts: { current: 1 },
        severityCounts: { normal: 1 },
        reviewCount: 0
      }
    ],
    systemRelations: [
      {
        id: "system:explicit:requires:auth:billing",
        source: "auth",
        target: "billing",
        relation: "requires",
        origin: "explicit",
        count: 1,
        strength: 95,
        bidirectional: false
      }
    ]
  };
}

function systemGraph(system: string, claims: GraphClaim[], relations: GraphRelation[]): SystemGraph {
  return {
    system,
    claims,
    relations
  };
}

function claim(id: string, system: string, title: string): GraphClaim {
  return {
    id,
    type: "fact",
    system,
    status: "current",
    confidence: "high",
    severity: "normal",
    title,
    claim: title,
    sourcePath: `docs/agent-memory/claims/${system}/${id.replaceAll(".", "_")}.md`,
    tags: [],
    reviewPriority: 0
  };
}

function relation(id: string, source: string, target: string, bidirectional: boolean, relationName = "same_area"): GraphRelation {
  return {
    id,
    source,
    target,
    relation: relationName,
    strength: 60,
    origin: "explicit",
    bidirectional
  };
}

function nodesOverlap(left: { position: { x: number; y: number } }, right: { position: { x: number; y: number } }, width: number, height: number): boolean {
  return !(
    left.position.x + width <= right.position.x ||
    right.position.x + width <= left.position.x ||
    left.position.y + height <= right.position.y ||
    right.position.y + height <= left.position.y
  );
}

function layoutNodeBox(node: { id: string; position: { x: number; y: number } }): { x: number; y: number; width: number; height: number } {
  const isSystem = node.id.startsWith("system:");

  return {
    x: node.position.x,
    y: node.position.y,
    width: isSystem ? 128 : 184,
    height: isSystem ? 128 : 58
  };
}

function layoutBoxesOverlap(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

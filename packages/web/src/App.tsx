import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type OnNodeDrag
} from "@xyflow/react";
import { type CSSProperties, type PointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Mode = "graph" | "files" | "review";
type Origin = "explicit" | "inferred" | "recipe" | "replacement";

const edgeLabelStyle: CSSProperties = { fill: "#1f2937", fontSize: 13, fontWeight: 700 };
const edgeLabelBgStyle: CSSProperties = { fill: "#f8fafc", fillOpacity: 0.94 };
const edgeLabelBgPadding: [number, number] = [8, 5];

interface UiMemoryModel {
  repoRoot: string;
  memoryRoot: string;
  databasePath: string;
  commandPrefix: string;
  health: UiHealth;
  graph: UiGraphSummary;
  files: UiFileNode;
  validation: ValidationResult;
  doctor: DoctorResult;
  reviewQueue: UiReviewItem[];
}

interface UiHealth {
  healthy: boolean;
  validationValid: boolean;
  doctorHealthy: boolean;
}

interface UiClaimSummary {
  id: string;
  type: string;
  system: string;
  status: string;
  confidence: string;
  severity: string;
  title: string;
  claim: string;
  sourcePath: string;
  tags: string[];
  reviewPriority: number;
  reviewReason?: string;
}

interface UiClaim extends UiClaimSummary {
  sourceFiles: string[];
  relatedFiles: string[];
  symbols: string[];
  routes: string[];
  verification: string[];
  body: string;
  raw: Record<string, unknown>;
}

interface UiRelation {
  id: string;
  source: string;
  target: string;
  relation: string;
  reason?: string;
  strength: number;
  origin: Origin;
  sourcePath?: string;
  bidirectional: boolean;
}

interface UiGraphSummary {
  systems: UiSystemNode[];
  systemRelations: UiSystemRelation[];
}

interface UiSystemNode {
  id: string;
  system: string;
  color: string;
  claimCount: number;
  statusCounts: Record<string, number>;
  severityCounts: Record<string, number>;
  reviewCount: number;
  searchText: string;
}

interface UiSystemRelation {
  id: string;
  source: string;
  target: string;
  relation: string;
  origin: Origin;
  count: number;
  strength: number;
  bidirectional: boolean;
}

interface UiSystemGraph {
  system: string;
  claims: UiClaimSummary[];
  relations: UiRelation[];
}

interface UiFileNode {
  name: string;
  path: string;
  kind: "directory" | "claim" | "graph" | "index" | "recipe" | "waiver" | "file";
  claimId?: string;
  children?: UiFileNode[];
}

interface UiReviewItem {
  claimId: string;
  title: string;
  system: string;
  status: string;
  confidence: string;
  severity: string;
  sourcePath: string;
  priority: number;
  reason: string;
}

interface ValidationResult {
  valid: boolean;
  errors: Array<{ message: string; path?: string; id?: string }>;
  warnings: Array<{ message: string; path?: string; id?: string }>;
  counts: { claims: number; graphs: number; indexes: number; recipes: number };
}

interface DoctorResult {
  healthy: boolean;
  checks: Array<{ name: string; status: "ok" | "warning"; message: string; remediation?: string }>;
}

interface ClaimDetail {
  claim: UiClaim;
  relations: UiRelation[];
  relatedClaims: UiClaim[];
}

const statuses = ["current", "proposed", "stale", "deprecated", "experimental", "needs_verification", "needs_review", "rejected"];
const confidences = ["low", "medium", "high", "verified"];
const origins: Origin[] = ["explicit", "inferred", "recipe", "replacement"];
const defaultDrawerWidth = 360;
const minDrawerWidth = 320;
const maxDrawerWidth = 860;
const drawerWidthKey = "agent-memory.drawer-width";

export default function App() {
  const [memory, setMemory] = useState<UiMemoryModel | null>(null);
  const [detail, setDetail] = useState<ClaimDetail | null>(null);
  const [drawerWidth, setDrawerWidth] = useState(readStoredDrawerWidth);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("graph");
  const [query, setQuery] = useState("");
  const [system, setSystem] = useState("all");
  const [status, setStatus] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [enabledOrigins, setEnabledOrigins] = useState<Set<Origin>>(new Set(["explicit"]));
  const [expandedSystems, setExpandedSystems] = useState<Set<string>>(new Set());
  const [systemGraphs, setSystemGraphs] = useState<Record<string, UiSystemGraph>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const [notice, setNotice] = useState("Loading memory...");
  const [busy, setBusy] = useState(false);
  const systemGraphLoads = useRef(new Map<string, Promise<UiSystemGraph>>());
  const token = useMemo(() => new URLSearchParams(window.location.search).get("token") ?? "", []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await api<UiMemoryModel>("/api/memory");
      setMemory(next);
      setExpandedSystems(new Set());
      setSystemGraphs({});
      systemGraphLoads.current.clear();
      setNotice("Memory loaded.");

      if (detail) {
        setDetail(await api<ClaimDetail>(`/api/claims/${encodeURIComponent(detail.claim.id)}`));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [detail]);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(drawerWidthKey, String(drawerWidth));
  }, [drawerWidth]);

  useEffect(() => {
    if (!detail) {
      setReaderOpen(false);
    }
  }, [detail]);

  const loadedRelations = useMemo(() => compactGraphRelations(Object.values(systemGraphs).flatMap((item) => item.relations)), [systemGraphs]);

  const filteredSystemGraphs = useMemo(() => {
    if (!memory) {
      return {};
    }

    const byFocus = focusId ? focusedClaimIds(focusId, loadedRelations) : null;
    const normalizedQuery = query.trim().toLowerCase();
    const next: Record<string, UiSystemGraph> = {};

    for (const [key, value] of Object.entries(systemGraphs)) {
      next[key] = {
        ...value,
        claims: value.claims.filter((claim) => {
          if (!expandedSystems.has(claim.system)) {
            return false;
          }

          if (byFocus && !byFocus.has(claim.id)) {
            return false;
          }

          if (system !== "all" && claim.system !== system) {
            return false;
          }

          if (status !== "all" && claim.status !== status) {
            return false;
          }

          if (severity !== "all" && claim.severity !== severity) {
            return false;
          }

          if (!normalizedQuery) {
            return true;
          }

          return searchableText(claim).includes(normalizedQuery);
        })
      };
    }

    return next;
  }, [expandedSystems, focusId, loadedRelations, memory, query, severity, status, system, systemGraphs]);

  const visibleGraphSummary = useMemo(() => {
    if (!memory) {
      return { systems: [], systemRelations: [] };
    }

    const normalizedQuery = query.trim().toLowerCase();
    const systems = memory.graph.systems.filter((item) => {
      if (system !== "all" && item.system !== system) {
        return false;
      }

      if (status !== "all" && !item.statusCounts[status]) {
        return false;
      }

      if (severity !== "all" && !item.severityCounts[severity]) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return (
        item.system.toLowerCase().includes(normalizedQuery) ||
        item.searchText.includes(normalizedQuery) ||
        (filteredSystemGraphs[item.system]?.claims ?? []).some((claim) => searchableText(claim).includes(normalizedQuery))
      );
    });
    const visibleSystems = new Set(systems.map((item) => item.system));

    return {
      systems,
      systemRelations: memory.graph.systemRelations.filter(
        (relation) => visibleSystems.has(relation.source) && visibleSystems.has(relation.target)
      )
    };
  }, [filteredSystemGraphs, memory, query, severity, status, system]);

  const graph = useMemo(
    () => buildGraph(visibleGraphSummary, filteredSystemGraphs, expandedSystems, enabledOrigins),
    [enabledOrigins, expandedSystems, filteredSystemGraphs, visibleGraphSummary]
  );
  const systems = useMemo(() => memory?.graph.systems.map((item) => item.system) ?? [], [memory]);
  const severities = useMemo(() => unique(memory?.graph.systems.flatMap((item) => Object.keys(item.severityCounts)) ?? []), [memory]);

  async function selectClaim(id: string) {
    setDetail(await api<ClaimDetail>(`/api/claims/${encodeURIComponent(id)}`));
    setDrawerOpen(true);
  }

  async function toggleSystem(systemName: string) {
    if (expandedSystems.has(systemName)) {
      setExpandedSystems((current) => {
        const next = new Set(current);
        next.delete(systemName);
        return next;
      });
      return;
    }

    if (!systemGraphs[systemName]) {
      setBusy(true);
      try {
        const load =
          systemGraphLoads.current.get(systemName) ?? api<UiSystemGraph>(`/api/graph/systems/${encodeURIComponent(systemName)}`);
        systemGraphLoads.current.set(systemName, load);

        const systemGraph = await load;
        setSystemGraphs((current) => (current[systemName] ? current : { ...current, [systemName]: systemGraph }));
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        systemGraphLoads.current.delete(systemName);
        setBusy(false);
      }
    }

    setExpandedSystems((current) => new Set(current).add(systemName));
  }

  function resizeDrawer(clientX: number) {
    const viewportMax = Math.floor(window.innerWidth * 0.6);
    setDrawerWidth(clamp(window.innerWidth - clientX, minDrawerWidth, Math.min(maxDrawerWidth, viewportMax)));
  }

  function resizeDrawerBy(delta: number) {
    const viewportMax = Math.floor(window.innerWidth * 0.6);
    setDrawerWidth((current) => clamp(current + delta, minDrawerWidth, Math.min(maxDrawerWidth, viewportMax)));
  }

  function startDrawerResize(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeDrawer(event.clientX);
  }

  async function approveClaim(id: string) {
    await reviewClaim(id, "current", "high");
  }

  async function reviewClaim(id: string, nextStatus: string, nextConfidence: string) {
    setBusy(true);
    try {
      await api(`/api/claims/${encodeURIComponent(id)}/review`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-agent-memory-token": token },
        body: JSON.stringify({ status: nextStatus, confidence: nextConfidence })
      });
      setNotice(`Updated ${id}.`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function syncMemory() {
    setBusy(true);
    try {
      await api("/api/sync", {
        method: "POST",
        headers: { "x-agent-memory-token": token }
      });
      setNotice("Memory synced.");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const shellStyle = {
    "--sidebar-width": sidebarOpen ? "300px" : "0px",
    "--drawer-width": drawerOpen ? `${drawerWidth}px` : "0px"
  } as CSSProperties;

  return (
    <main className="shell" style={shellStyle}>
      {sidebarOpen && (
        <aside className="sidebar">
          <div className="brand">
            <div>
              <h1>Agent Memory</h1>
              <p>{memory?.memoryRoot ?? "Loading repository memory"}</p>
            </div>
            <div className="brand-actions">
              <span className={memory?.validation.valid && memory.doctor.healthy ? "health ok" : "health warn"} />
              <button className="panel-button" onClick={() => setSidebarOpen(false)}>
                Hide
              </button>
            </div>
          </div>

          <nav className="tabs" aria-label="Views">
            <button className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>
              Graph
            </button>
            <button className={mode === "files" ? "active" : ""} onClick={() => setMode("files")}>
              Files
            </button>
            <button className={mode === "review" ? "active" : ""} onClick={() => setMode("review")}>
              Review
            </button>
          </nav>

          <label className="field">
            <span>Search</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="title, claim, tag, file" />
          </label>

          <div className="filters">
            <label>
              <span>System</span>
              <select value={system} onChange={(event) => setSystem(event.target.value)}>
                <option value="all">All</option>
                {systems.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="all">All</option>
                {statuses.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Severity</span>
              <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
                <option value="all">All</option>
                {severities.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="origin-list">
            {origins.map((origin) => (
              <label key={origin}>
                <input
                  type="checkbox"
                  checked={enabledOrigins.has(origin)}
                  onChange={() => setEnabledOrigins(toggleSet(enabledOrigins, origin))}
                />
                <span>{origin}</span>
              </label>
            ))}
          </div>

          <HealthPanel memory={memory} notice={notice} busy={busy} onSync={syncMemory} />
        </aside>
      )}

      <section className="workspace">
        {!sidebarOpen && (
          <button className="panel-toggle left" onClick={() => setSidebarOpen(true)}>
            Filters
          </button>
        )}
        {!drawerOpen && detail && (
          <button className="panel-toggle right" onClick={() => setDrawerOpen(true)}>
            Details
          </button>
        )}
        {mode === "graph" && (
          <GraphView
            nodes={graph.nodes}
            edges={graph.edges}
            onSelectClaim={selectClaim}
            onToggleSystem={toggleSystem}
            onFocus={setFocusId}
            focusId={focusId}
            onClearFocus={() => setFocusId(null)}
          />
        )}
        {mode === "files" && memory && <FileView root={memory.files} onSelectClaim={selectClaim} />}
        {mode === "review" && memory && <ReviewView items={memory.reviewQueue} onSelect={selectClaim} onApprove={approveClaim} />}
      </section>

      {drawerOpen && (
        <ClaimDrawer
          detail={detail}
          commandPrefix={memory?.commandPrefix ?? "agent-memory"}
          onClose={() => {
            setDetail(null);
            setDrawerOpen(false);
          }}
          onHide={() => setDrawerOpen(false)}
          onOpenReader={() => setReaderOpen(true)}
          onResize={resizeDrawer}
          onResizeBy={resizeDrawerBy}
          onResizeStart={startDrawerResize}
          onReview={reviewClaim}
        />
      )}
      {readerOpen && detail && (
        <ClaimReader
          detail={detail}
          commandPrefix={memory?.commandPrefix ?? "agent-memory"}
          onClose={() => setReaderOpen(false)}
          onReview={reviewClaim}
        />
      )}
    </main>
  );
}

type GraphNodeData = (
  | {
      kind: "system";
      system: string;
    }
  | {
      kind: "claim";
      claimId: string;
      system: string;
    }
) & {
  color: string;
  label: ReactNode;
};

function GraphView(props: {
  nodes: Node[];
  edges: Edge[];
  focusId: string | null;
  onSelectClaim(id: string): void;
  onToggleSystem(system: string): void;
  onFocus(id: string): void;
  onClearFocus(): void;
}) {
  const [nodes, setNodes] = useState(props.nodes);
  const dragOrigin = useRef<{ id: string; x: number; y: number } | null>(null);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);
  const onNodeDragStart: OnNodeDrag = useCallback((_event, node) => {
    const data = node.data as GraphNodeData;

    if (data.kind === "system") {
      dragOrigin.current = { id: node.id, x: node.position.x, y: node.position.y };
    }
  }, []);
  const onNodeDrag: OnNodeDrag = useCallback((_event, node) => {
    const data = node.data as GraphNodeData;
    const origin = dragOrigin.current;

    if (data.kind !== "system" || !origin || origin.id !== node.id) {
      return;
    }

    const delta = {
      x: node.position.x - origin.x,
      y: node.position.y - origin.y
    };

    if (delta.x === 0 && delta.y === 0) {
      return;
    }

    dragOrigin.current = { id: node.id, x: node.position.x, y: node.position.y };
    setNodes((current) => moveSystemChildren(current, data.system, delta));
  }, []);
  const onNodeDragStop: OnNodeDrag = useCallback(() => {
    dragOrigin.current = null;
  }, []);

  useEffect(() => {
    setNodes((current) => mergeGraphNodes(current, props.nodes));
  }, [props.nodes]);

  return (
    <div className="graph-surface">
      <ReactFlow
        nodes={nodes}
        edges={props.edges}
        fitView
        minZoom={0.15}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_event, node) => {
          const data = node.data as GraphNodeData;

          if (data.kind === "system") {
            void props.onToggleSystem(data.system);
          } else {
            void props.onSelectClaim(data.claimId);
          }
        }}
        onNodeDoubleClick={(_event, node) => {
          const data = node.data as GraphNodeData;

          if (data.kind === "claim") {
            props.onFocus(data.claimId);
          }
        }}
      >
        <Background gap={28} size={1} />
        <Controls showInteractive={false} />
        <MiniMap nodeColor={(node) => String(node.data.color ?? "#94a3b8")} pannable zoomable />
        <Panel position="top-left" className="graph-panel">
          <strong>{props.nodes.length}</strong> nodes · <strong>{props.edges.length}</strong> relations
          {props.focusId && <button onClick={props.onClearFocus}>Clear focus</button>}
        </Panel>
      </ReactFlow>
    </div>
  );
}

function mergeGraphNodes(currentNodes: Node[], nextNodes: Node[]): Node[] {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));

  return nextNodes.map((node) => {
    const current = currentById.get(node.id);
    return current ? { ...node, position: current.position } : node;
  });
}

export function moveSystemChildren(nodes: Node[], system: string, delta: { x: number; y: number }): Node[] {
  return nodes.map((node) => {
    const data = node.data as GraphNodeData;

    if (data.kind !== "claim" || data.system !== system) {
      return node;
    }

    return {
      ...node,
      position: {
        x: node.position.x + delta.x,
        y: node.position.y + delta.y
      }
    };
  });
}

function HealthPanel(props: { memory: UiMemoryModel | null; notice: string; busy: boolean; onSync(): void }) {
  const warnings = [
    ...(props.memory?.validation.errors.map((issue) => issue.message) ?? []),
    ...(props.memory?.doctor.checks.filter((check) => check.status === "warning").map((check) => check.message) ?? [])
  ];

  return (
    <section className="health-panel">
      <div className="health-row">
        <strong>{props.memory?.validation.valid && props.memory.doctor.healthy ? "Healthy" : "Needs attention"}</strong>
        <button onClick={props.onSync} disabled={props.busy}>
          Sync
        </button>
      </div>
      <p>{props.notice}</p>
      {warnings.slice(0, 4).map((warning) => (
        <div className="warning" key={warning}>
          {warning}
        </div>
      ))}
    </section>
  );
}

function FileView(props: { root: UiFileNode; onSelectClaim(id: string): void }) {
  return (
    <div className="file-view">
      <h2>Memory Files</h2>
      <FileNode node={props.root} onSelectClaim={props.onSelectClaim} />
    </div>
  );
}

function FileNode(props: { node: UiFileNode; onSelectClaim(id: string): void }) {
  const node = props.node;

  if (node.kind === "directory") {
    return (
      <details open={node.path === "" || node.path.endsWith("agent-memory")}>
        <summary>{node.name}</summary>
        <div className="file-children">
          {(node.children ?? []).map((child) => (
            <FileNode key={child.path} node={child} onSelectClaim={props.onSelectClaim} />
          ))}
        </div>
      </details>
    );
  }

  return (
    <button className={`file-node ${node.kind}`} onClick={() => node.claimId && props.onSelectClaim(node.claimId)} disabled={!node.claimId}>
      <span>{node.name}</span>
      <small>{node.kind}</small>
    </button>
  );
}

function ReviewView(props: { items: UiReviewItem[]; onSelect(id: string): void; onApprove(id: string): void }) {
  return (
    <div className="review-view">
      <h2>Review Queue</h2>
      {props.items.length === 0 && <p className="empty">No claims currently need review.</p>}
      {props.items.map((item) => (
        <article className="review-item" key={item.claimId}>
          <div>
            <strong>{item.title}</strong>
            <p>{item.reason}</p>
            <small>
              {item.system} · {item.status} · {item.confidence}
            </small>
          </div>
          <div className="review-actions">
            <button onClick={() => props.onSelect(item.claimId)}>Open</button>
            <button onClick={() => props.onApprove(item.claimId)}>Approve</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function ClaimDrawer(props: {
  detail: ClaimDetail | null;
  commandPrefix: string;
  onClose(): void;
  onHide(): void;
  onOpenReader(): void;
  onResize(clientX: number): void;
  onResizeBy(delta: number): void;
  onResizeStart(event: PointerEvent<HTMLDivElement>): void;
  onReview(id: string, status: string, confidence: string): void;
}) {
  const claim = props.detail?.claim;

  if (!claim) {
    return (
      <aside className="drawer empty-drawer">
        <DrawerResizeHandle onResize={props.onResize} onResizeBy={props.onResizeBy} onResizeStart={props.onResizeStart} />
        <button className="panel-button" onClick={props.onHide}>
          Hide
        </button>
        <p>Select a claim to inspect its contents.</p>
      </aside>
    );
  }

  return (
    <aside className="drawer">
      <DrawerResizeHandle onResize={props.onResize} onResizeBy={props.onResizeBy} onResizeStart={props.onResizeStart} />
      <div className="drawer-header">
        <div>
          <h2>{claim.title}</h2>
          <p>{claim.id}</p>
        </div>
        <div className="button-row drawer-actions">
          <button onClick={props.onOpenReader}>Read</button>
          <button onClick={props.onHide}>Hide</button>
          <button onClick={props.onClose}>Close</button>
        </div>
      </div>

      <div className="badge-row">
        <span className={`badge status-${claim.status}`}>{claim.status}</span>
        <span className="badge">{claim.confidence}</span>
        <span className="badge">{claim.severity}</span>
        <span className="badge">{claim.system}</span>
      </div>

      <section>
        <h3>Claim</h3>
        <p>{claim.claim}</p>
      </section>

      <ClaimReviewControls claim={claim} onReview={props.onReview} />

      <section>
        <h3>Files</h3>
        <List values={[claim.sourcePath, ...claim.sourceFiles, ...claim.relatedFiles]} />
      </section>

      <section>
        <h3>Tags</h3>
        <List values={claim.tags} />
      </section>

      <section>
        <h3>Related Claims</h3>
        <List values={(props.detail?.relatedClaims ?? []).map((related) => `${related.id} · ${related.title}`)} />
      </section>

      <section>
        <h3>Copy</h3>
        <div className="button-row wrap">
          <button onClick={() => copyText(claim.id)}>Claim ID</button>
          <button onClick={() => copyText(`${props.commandPrefix} show ${claim.id} --include-related`)}>Show command</button>
          <button onClick={() => copyText(claim.sourcePath)}>Source path</button>
        </div>
      </section>

      <details>
        <summary>Markdown body</summary>
        <MarkdownBody markdown={claim.body} compact />
      </details>
    </aside>
  );
}

function DrawerResizeHandle(props: {
  onResize(clientX: number): void;
  onResizeBy(delta: number): void;
  onResizeStart(event: PointerEvent<HTMLDivElement>): void;
}) {
  return (
    <div
      className="drawer-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize claim drawer"
      tabIndex={0}
      onPointerDown={props.onResizeStart}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          props.onResize(event.clientX);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          props.onResizeBy(24);
        }

        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onResizeBy(-24);
        }
      }}
    />
  );
}

function ClaimReader(props: {
  detail: ClaimDetail;
  commandPrefix: string;
  onClose(): void;
  onReview(id: string, status: string, confidence: string): void;
}) {
  const claim = props.detail.claim;

  return (
    <div className="reader-shell" role="dialog" aria-modal="true" aria-label={`Claim ${claim.title}`}>
      <button className="reader-backdrop" onClick={props.onClose} aria-label="Close reader" />
      <article className="reader-document">
        <header className="reader-header">
          <div>
            <h2>{claim.title}</h2>
            <p>{claim.id}</p>
          </div>
          <button onClick={props.onClose}>Close</button>
        </header>

        <div className="badge-row">
          <span className={`badge status-${claim.status}`}>{claim.status}</span>
          <span className="badge">{claim.confidence}</span>
          <span className="badge">{claim.severity}</span>
          <span className="badge">{claim.system}</span>
        </div>

        <ClaimReviewControls claim={claim} onReview={props.onReview} />

        <section className="reader-section">
          <h3>Claim</h3>
          <p className="reader-claim">{claim.claim}</p>
        </section>

        <section className="reader-section">
          <h3>Markdown body</h3>
          <MarkdownBody markdown={claim.body} />
        </section>

        <section className="reader-section">
          <h3>Verification</h3>
          <List values={claim.verification} />
        </section>

        <section className="reader-section">
          <h3>Related Claims</h3>
          <List values={props.detail.relatedClaims.map((related) => `${related.id} · ${related.title}`)} />
        </section>

        <section className="reader-section">
          <h3>Files</h3>
          <List values={[claim.sourcePath, ...claim.sourceFiles, ...claim.relatedFiles]} />
        </section>

        <section className="reader-section">
          <h3>Copy</h3>
          <div className="button-row wrap">
            <button onClick={() => copyText(claim.id)}>Claim ID</button>
            <button onClick={() => copyText(`${props.commandPrefix} show ${claim.id} --include-related`)}>Show command</button>
            <button onClick={() => copyText(claim.sourcePath)}>Source path</button>
          </div>
        </section>
      </article>
    </div>
  );
}

function ClaimReviewControls(props: {
  claim: UiClaim;
  onReview(id: string, status: string, confidence: string): void;
}) {
  const [status, setStatus] = useState(props.claim.status);
  const [confidence, setConfidence] = useState(props.claim.confidence);

  useEffect(() => {
    setStatus(props.claim.status);
    setConfidence(props.claim.confidence);
  }, [props.claim]);

  return (
    <section className="review-form">
      <h3>Review</h3>
      <label>
        Status
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          {statuses.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        Confidence
        <select value={confidence} onChange={(event) => setConfidence(event.target.value)}>
          {confidences.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <div className="button-row">
        <button onClick={() => props.onReview(props.claim.id, "current", "high")}>Approve</button>
        <button onClick={() => props.onReview(props.claim.id, status, confidence)}>Apply</button>
      </div>
    </section>
  );
}

function MarkdownBody(props: { markdown: string; compact?: boolean }) {
  if (props.markdown.trim().length === 0) {
    return <p className="empty">No body content.</p>;
  }

  return (
    <div className={`markdown-body${props.compact ? " compact" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {props.markdown}
      </ReactMarkdown>
    </div>
  );
}

function List(props: { values: string[] }) {
  const values = unique(props.values.filter(Boolean));

  if (values.length === 0) {
    return <p className="empty">None</p>;
  }

  return (
    <ul>
      {values.map((value) => (
        <li key={value}>{value}</li>
      ))}
    </ul>
  );
}

export function buildGraph(
  graph: UiGraphSummary,
  systemGraphs: Record<string, UiSystemGraph>,
  expandedSystems: Set<string>,
  enabledOrigins: Set<Origin>
): { nodes: Node[]; edges: Edge[] } {
  const systems = orderSystemsForGraph(graph.systems, graph.systemRelations);
  const visibleSystemIds = new Set(systems.map((item) => item.system));
  const systemIndex = new Map(systems.map((value, index) => [value.system, index]));
  const systemNodeSize = 128;
  const claimNodeWidth = 184;
  const claimNodeHeight = 58;
  const claimNodeGap = 26;
  const systemOrbitRadius = Math.max(460, systems.length * 170);
  const graphCenter = { x: systemOrbitRadius, y: systemOrbitRadius };
  const loadedClaims = systems.flatMap((item) => (expandedSystems.has(item.system) ? (systemGraphs[item.system]?.claims ?? []) : []));
  const visibleClaimIds = new Set(loadedClaims.map((claim) => claim.id));
  const loadedClaimSystems = new Map(loadedClaims.map((claim) => [claim.id, claim.system]));
  const visibleClaimRelations = compactGraphRelations(
    Object.values(systemGraphs)
      .flatMap((item) => item.relations)
      .filter((relation) => enabledOrigins.has(relation.origin) && visibleClaimIds.has(relation.source) && visibleClaimIds.has(relation.target))
  );
  const relationCounts = relationCountsByClaim(visibleClaimRelations);
  const systemPositions = new Map(
    systems.map((item) => {
      const index = systemIndex.get(item.system) ?? 0;
      return [item.system, systemPosition(index, systems.length, systemOrbitRadius)] as const;
    })
  );
  const nodes: Node[] = systems.map((item) => {
    const expanded = expandedSystems.has(item.system);
    const position = systemPositions.get(item.system) ?? { x: 0, y: 0 };

    return {
      id: systemNodeId(item.system),
      position,
      data: {
        kind: "system",
        system: item.system,
        color: item.color,
        label: (
          <div className="system-node" title={`${item.system}\n${item.claimCount} claims\n${formatCounts("status", item.statusCounts)}\n${formatCounts("severity", item.severityCounts)}`}>
            <strong>{item.system}</strong>
            <span>
              {item.claimCount}
              <small>claims</small>
            </span>
            {item.reviewCount > 0 && <em>{item.reviewCount}</em>}
            <small>{expanded ? "expanded" : "system"}</small>
          </div>
        )
      },
      style: {
        borderColor: item.color,
        background: item.color,
        borderRadius: "999px",
        width: systemNodeSize,
        height: systemNodeSize,
        boxShadow: "0 14px 34px rgba(15, 23, 42, 0.16)"
      }
    };
  });
  const hierarchyEdges: Edge[] = [];
  const occupiedBoxes: LayoutBox[] = nodes.map((node) => ({
    x: node.position.x,
    y: node.position.y,
    width: systemNodeSize,
    height: systemNodeSize
  }));

  for (const system of systems) {
    if (!expandedSystems.has(system.system)) {
      continue;
    }

    const parent = systemPositions.get(system.system) ?? { x: 0, y: 0 };
    const claims = systemGraphs[system.system]?.claims ?? [];
    const claimPositions = clusterClaimPositions({
      parent,
      parentSystem: system.system,
      claims,
      relations: visibleClaimRelations,
      claimSystems: loadedClaimSystems,
      systemPositions,
      graphCenter,
      occupiedBoxes,
      parentSize: systemNodeSize,
      claimWidth: claimNodeWidth,
      claimHeight: claimNodeHeight,
      gap: claimNodeGap
    });

    for (let index = 0; index < claims.length; index += 1) {
      const claim = claims[index];
      const color = statusColor(claim.status);
      const relationCount = relationCounts.get(claim.id) ?? 0;
      const claimPosition = claimPositions[index];

      occupiedBoxes.push({
        x: claimPosition.x,
        y: claimPosition.y,
        width: claimNodeWidth,
        height: claimNodeHeight
      });
      nodes.push({
        id: claimNodeId(claim.id),
        position: claimPosition,
        data: {
          kind: "claim",
          claimId: claim.id,
          system: claim.system,
          color,
          label: (
            <div
              className="claim-node compact"
              title={`${claim.title}\n${claim.id}\n${claim.sourcePath}\n${relationCount} visible relations\n${claim.claim}`}
            >
              <span className="node-system">{claim.system}</span>
              <strong>{claim.title}</strong>
              <span>
                {claim.status} · {claim.severity} · {relationCount} rel
              </span>
            </div>
          )
        },
        style: {
          borderColor: color,
          background: "#ffffff",
          borderRadius: 999,
          width: claimNodeWidth,
          minHeight: claimNodeHeight,
          boxShadow: "0 8px 20px rgba(15, 23, 42, 0.10)"
        }
      });
      hierarchyEdges.push({
        id: `system-claim:${system.system}:${claim.id}`,
        source: systemNodeId(system.system),
        target: claimNodeId(claim.id),
        type: "straight",
        selectable: false,
        focusable: false,
        style: { stroke: system.color, strokeWidth: 1.1, strokeDasharray: "3 7", opacity: 0.3 },
        data: { kind: "hierarchy", system: system.system, claimId: claim.id }
      });
    }
  }

  const systemEdges = graph.systemRelations
    .filter((relation) => enabledOrigins.has(relation.origin))
    .filter((relation) => visibleSystemIds.has(relation.source) && visibleSystemIds.has(relation.target))
    .filter((relation) => !(expandedSystems.has(relation.source) && expandedSystems.has(relation.target)))
    .reduce(groupSystemRelations, new Map<string, SystemRelationGroup>());

  const groupedSystemEdges = [...systemEdges.values()].map((group) => ({
    id: group.id,
    source: systemNodeId(group.source),
    target: systemNodeId(group.target),
    label: systemRelationLabel(group),
    type: "bezier",
    markerStart: group.bidirectional ? { type: MarkerType.ArrowClosed } : undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: originColor(group.origin), strokeWidth: Math.max(1, Math.round(group.strength / 42)), opacity: 0.72 },
    labelStyle: edgeLabelStyle,
    labelBgStyle: edgeLabelBgStyle,
    labelBgPadding: edgeLabelBgPadding,
    labelBgBorderRadius: 4,
    data: { ...group }
  }));

  const claimEdges = visibleClaimRelations.map((relation) => ({
    id: relation.id,
    source: claimNodeId(relation.source),
    target: claimNodeId(relation.target),
    label: relation.relation,
    type: "bezier",
    markerStart: relation.bidirectional ? { type: MarkerType.ArrowClosed } : undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: originColor(relation.origin), strokeWidth: Math.max(1, Math.round(relation.strength / 42)), opacity: 0.72 },
    labelStyle: edgeLabelStyle,
    labelBgStyle: edgeLabelBgStyle,
    labelBgPadding: edgeLabelBgPadding,
    labelBgBorderRadius: 4,
    data: { ...relation }
  }));

  return { nodes, edges: [...hierarchyEdges, ...groupedSystemEdges, ...claimEdges] };
}

interface SystemRelationGroup {
  id: string;
  source: string;
  target: string;
  origin: Origin;
  count: number;
  strength: number;
  bidirectional: boolean;
  relations: string[];
}

function groupSystemRelations(groups: Map<string, SystemRelationGroup>, relation: UiSystemRelation): Map<string, SystemRelationGroup> {
  const [left, right] = [relation.source, relation.target].sort();
  const key = `${relation.origin}:${left}:${right}`;
  const existing = groups.get(key);

  if (!existing) {
    groups.set(key, {
      id: relation.id,
      source: relation.source,
      target: relation.target,
      origin: relation.origin,
      count: relation.count,
      strength: relation.strength,
      bidirectional: relation.bidirectional,
      relations: [relation.relation]
    });
    return groups;
  }

  const hasReverseDirection = existing.source === relation.target && existing.target === relation.source;
  existing.id = `system:${relation.origin}:${left}:${right}`;
  existing.count += relation.count;
  existing.strength = Math.max(existing.strength, relation.strength);
  existing.bidirectional = existing.bidirectional || relation.bidirectional || hasReverseDirection;

  if (!existing.relations.includes(relation.relation)) {
    existing.relations.push(relation.relation);
  }

  return groups;
}

function systemRelationLabel(group: SystemRelationGroup): string {
  if (group.relations.length === 1) {
    return `${group.relations[0]} (${group.count})`;
  }

  return `${group.count} relations`;
}

function orderSystemsForGraph(systems: UiSystemNode[], relations: UiSystemRelation[]): UiSystemNode[] {
  if (systems.length < 3) {
    return systems;
  }

  const bySystem = new Map(systems.map((system) => [system.system, system]));
  const neighbors = new Map<string, Set<string>>();

  for (const relation of relations) {
    if (!bySystem.has(relation.source) || !bySystem.has(relation.target)) {
      continue;
    }

    neighbors.set(relation.source, (neighbors.get(relation.source) ?? new Set()).add(relation.target));
    neighbors.set(relation.target, (neighbors.get(relation.target) ?? new Set()).add(relation.source));
  }

  const remaining = new Set(systems.map((system) => system.system));
  const ordered: string[] = [];
  let current = systems
    .map((system) => system.system)
    .sort((left, right) => (neighbors.get(right)?.size ?? 0) - (neighbors.get(left)?.size ?? 0) || left.localeCompare(right))[0];

  while (current) {
    ordered.push(current);
    remaining.delete(current);

    const next = [...(neighbors.get(current) ?? [])]
      .filter((system) => remaining.has(system))
      .sort((left, right) => (neighbors.get(right)?.size ?? 0) - (neighbors.get(left)?.size ?? 0) || left.localeCompare(right))[0];

    current = next ?? [...remaining].sort()[0];
  }

  return ordered.map((system) => bySystem.get(system)).filter((system): system is UiSystemNode => Boolean(system));
}

function systemPosition(index: number, total: number, radius: number): { x: number; y: number } {
  if (total <= 1) {
    return { x: radius, y: radius };
  }

  const angle = (-90 + (360 * index) / total) * (Math.PI / 180);

  return {
    x: radius + Math.cos(angle) * radius,
    y: radius + Math.sin(angle) * radius
  };
}

function clusterClaimPositions(options: {
  parent: { x: number; y: number };
  parentSystem: string;
  claims: UiClaimSummary[];
  relations: UiRelation[];
  claimSystems: Map<string, string>;
  systemPositions: Map<string, { x: number; y: number }>;
  graphCenter: { x: number; y: number };
  occupiedBoxes: LayoutBox[];
  parentSize: number;
  claimWidth: number;
  claimHeight: number;
  gap: number;
}): Array<{ x: number; y: number }> {
  if (options.claims.length === 0) {
    return [];
  }

  const center = {
    x: options.parent.x + options.parentSize / 2,
    y: options.parent.y + options.parentSize / 2
  };
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(options.claims.length))));
  const rowGap = options.gap + 18;
  const columnGap = options.gap + 18;
  const outward = unitVector(center.x - options.graphCenter.x, center.y - options.graphCenter.y, 0, 1);
  const tangent = { x: -outward.y, y: outward.x };
  const orderedClaims = options.claims.map((claim, index) => ({
    claim,
    index,
    angle: desiredClaimAngle(claim, index, options)
  }));
  const positions: Array<{ x: number; y: number }> = [];
  const occupied = [...options.occupiedBoxes];

  for (const [slot, item] of orderedClaims.sort((left, right) => left.angle - right.angle || left.claim.id.localeCompare(right.claim.id)).entries()) {
    const position = placeClaimInGridSlot({
      slot,
      columns,
      center,
      outward,
      tangent,
      occupied,
      parentSize: options.parentSize,
      claimWidth: options.claimWidth,
      claimHeight: options.claimHeight,
      rowGap,
      columnGap
    });

    positions[item.index] = position;
    occupied.push({ ...position, width: options.claimWidth, height: options.claimHeight });
  }

  return positions;
}

function desiredClaimAngle(
  claim: UiClaimSummary,
  index: number,
  options: {
    parent: { x: number; y: number };
    parentSystem: string;
    claims: UiClaimSummary[];
    relations: UiRelation[];
    claimSystems: Map<string, string>;
    systemPositions: Map<string, { x: number; y: number }>;
    parentSize: number;
  }
): number {
  const center = {
    x: options.parent.x + options.parentSize / 2,
    y: options.parent.y + options.parentSize / 2
  };
  let x = 0;
  let y = 0;

  for (const relation of options.relations) {
    const otherId = relation.source === claim.id ? relation.target : relation.target === claim.id ? relation.source : null;

    if (!otherId) {
      continue;
    }

    const otherSystem = options.claimSystems.get(otherId);
    const otherPosition = otherSystem ? options.systemPositions.get(otherSystem) : undefined;

    if (!otherPosition || otherSystem === options.parentSystem) {
      continue;
    }

    x += otherPosition.x + options.parentSize / 2 - center.x;
    y += otherPosition.y + options.parentSize / 2 - center.y;
  }

  if (x !== 0 || y !== 0) {
    return Math.atan2(y, x);
  }

  return ((-90 + (360 * index) / options.claims.length) * Math.PI) / 180;
}

interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function placeClaimInGridSlot(options: {
  slot: number;
  columns: number;
  center: { x: number; y: number };
  outward: { x: number; y: number };
  tangent: { x: number; y: number };
  occupied: LayoutBox[];
  parentSize: number;
  claimWidth: number;
  claimHeight: number;
  rowGap: number;
  columnGap: number;
}): { x: number; y: number } {
  const row = Math.floor(options.slot / options.columns);
  const column = options.slot % options.columns;
  const tangentOffset = (column - (options.columns - 1) / 2) * (options.claimWidth + options.columnGap);
  const baseDistance = options.parentSize / 2 + options.claimHeight / 2 + 110;
  const rowDistance = options.claimHeight + options.rowGap;

  for (let push = 0; push < 24; push += 1) {
    const distance = baseDistance + (row + push) * rowDistance;
    const candidateCenter = {
      x: options.center.x + options.outward.x * distance + options.tangent.x * tangentOffset,
      y: options.center.y + options.outward.y * distance + options.tangent.y * tangentOffset
    };
    const candidate = {
      x: candidateCenter.x - options.claimWidth / 2,
      y: candidateCenter.y - options.claimHeight / 2
    };

    if (!options.occupied.some((box) => layoutBoxesOverlap(candidate, box, options.claimWidth, options.claimHeight))) {
      return candidate;
    }
  }

  const fallbackDistance = baseDistance + (row + options.occupied.length) * rowDistance;
  const fallbackCenter = {
    x: options.center.x + options.outward.x * fallbackDistance + options.tangent.x * tangentOffset,
    y: options.center.y + options.outward.y * fallbackDistance + options.tangent.y * tangentOffset
  };

  return {
    x: fallbackCenter.x - options.claimWidth / 2,
    y: fallbackCenter.y - options.claimHeight / 2
  };
}

function layoutBoxesOverlap(left: { x: number; y: number }, right: LayoutBox, width: number, height: number): boolean {
  const gap = 22;

  return !(
    left.x + width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.y + height + gap <= right.y ||
    right.y + right.height + gap <= left.y
  );
}

function unitVector(x: number, y: number, fallbackX: number, fallbackY: number): { x: number; y: number } {
  const length = Math.hypot(x, y);

  if (length === 0) {
    return { x: fallbackX, y: fallbackY };
  }

  return { x: x / length, y: y / length };
}

function relationCountsByClaim(relations: UiRelation[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const relation of relations) {
    counts.set(relation.source, (counts.get(relation.source) ?? 0) + 1);
    counts.set(relation.target, (counts.get(relation.target) ?? 0) + 1);
  }

  return counts;
}

function systemNodeId(system: string): string {
  return `system:${system}`;
}

function claimNodeId(id: string): string {
  return `claim:${id}`;
}

function formatCounts(label: string, counts: Record<string, number>): string {
  const values = Object.entries(counts).map(([key, value]) => `${key}: ${value}`);
  return `${label}: ${values.length > 0 ? values.join(", ") : "none"}`;
}

/*
 * The helpers below are retained for stable graph-layout tests that exercise
 * related-claim placement independently of the collapsed system renderer.
 */
export function buildExpandedClaimGraph(
  claims: UiClaimSummary[],
  relations: UiRelation[],
  claimIds: Set<string>,
  enabledOrigins: Set<Origin>
): { nodes: Node[]; edges: Edge[] } {
  const systems = unique(claims.map((claim) => claim.system));
  const systemIndex = new Map(systems.map((value, index) => [value, index]));
  const nodeWidth = 260;
  const laneGap = 120;
  const rowHeight = 190;
  const visibleRelations = compactGraphRelations(
    relations.filter((relation) => enabledOrigins.has(relation.origin) && claimIds.has(relation.source) && claimIds.has(relation.target))
  );
  const positions = layoutGraphClaims(claims, visibleRelations, systemIndex, nodeWidth, laneGap, rowHeight);
  const nodes = claims.map((claim) => {
    const color = statusColor(claim.status);

    return {
      id: claimNodeId(claim.id),
      position: positions.get(claim.id) ?? { x: 0, y: 0 },
      data: {
        kind: "claim",
        claimId: claim.id,
        color,
        label: (
          <div className="claim-node">
            <span className="node-system">{claim.system}</span>
            <strong>{claim.title}</strong>
            <span>
              {claim.status} · {claim.severity}
            </span>
          </div>
        )
      },
      style: {
        borderColor: color,
        background: "#ffffff",
        borderRadius: 8,
        width: nodeWidth
      }
    };
  });

  const edges = visibleRelations.map((relation) => ({
    id: relation.id,
    source: claimNodeId(relation.source),
    target: claimNodeId(relation.target),
    label: relation.relation,
    markerStart: relation.bidirectional ? { type: MarkerType.ArrowClosed } : undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: originColor(relation.origin), strokeWidth: Math.max(1, Math.round(relation.strength / 35)) },
    labelStyle: { fill: "#334155", fontSize: 11 },
    data: { ...relation }
  }));

  return { nodes, edges };
}

function layoutGraphClaims(
  claims: UiClaimSummary[],
  relations: UiRelation[],
  systemIndex: Map<string, number>,
  nodeWidth: number,
  laneGap: number,
  rowHeight: number
): Map<string, { x: number; y: number }> {
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const claimOrder = new Map(claims.map((claim, index) => [claim.id, index]));
  const adjacency = buildRelationAdjacency(relations, claimOrder);
  const occupiedRows = new Map<string, Set<number>>();
  const positions = new Map<string, { x: number; y: number }>();

  for (const claim of claims) {
    if (positions.has(claim.id)) {
      continue;
    }

    const desiredRow = firstAvailableRow(occupiedRows.get(claim.system));
    const queue = [{ id: claim.id, desiredRow }];

    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];

      if (positions.has(item.id)) {
        continue;
      }

      const current = claimById.get(item.id);

      if (!current) {
        continue;
      }

      const row = reserveNearestRow(current.system, item.desiredRow, occupiedRows);
      const lane = systemIndex.get(current.system) ?? 0;
      positions.set(current.id, {
        x: lane * (nodeWidth + laneGap),
        y: row * rowHeight
      });

      for (const neighborId of adjacency.get(current.id) ?? []) {
        if (positions.has(neighborId)) {
          continue;
        }

        const neighbor = claimById.get(neighborId);

        if (!neighbor) {
          continue;
        }

        queue.push({
          id: neighbor.id,
          desiredRow: neighbor.system === current.system ? row + 1 : row
        });
      }
    }
  }

  return positions;
}

function buildRelationAdjacency(relations: UiRelation[], claimOrder: Map<string, number>): Map<string, string[]> {
  const adjacency = new Map<string, Set<string>>();

  for (const relation of relations) {
    if (!adjacency.has(relation.source)) {
      adjacency.set(relation.source, new Set());
    }

    if (!adjacency.has(relation.target)) {
      adjacency.set(relation.target, new Set());
    }

    adjacency.get(relation.source)?.add(relation.target);
    adjacency.get(relation.target)?.add(relation.source);
  }

  return new Map(
    [...adjacency].map(([id, neighbors]) => [
      id,
      [...neighbors].sort((left, right) => (claimOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (claimOrder.get(right) ?? Number.MAX_SAFE_INTEGER))
    ])
  );
}

function reserveNearestRow(system: string, desiredRow: number, occupiedRows: Map<string, Set<number>>): number {
  let rows = occupiedRows.get(system);

  if (!rows) {
    rows = new Set();
    occupiedRows.set(system, rows);
  }

  const row = nearestAvailableRow(rows, Math.max(0, desiredRow));
  rows.add(row);
  return row;
}

function firstAvailableRow(rows: Set<number> | undefined): number {
  return nearestAvailableRow(rows ?? new Set(), 0);
}

function nearestAvailableRow(rows: Set<number>, desiredRow: number): number {
  if (!rows.has(desiredRow)) {
    return desiredRow;
  }

  for (let offset = 1; ; offset += 1) {
    const after = desiredRow + offset;

    if (!rows.has(after)) {
      return after;
    }

    const before = desiredRow - offset;

    if (before >= 0 && !rows.has(before)) {
      return before;
    }
  }
}

function compactGraphRelations(relations: UiRelation[]): UiRelation[] {
  const compacted: UiRelation[] = [];
  const seen = new Set<string>();

  for (const relation of relations) {
    const key = relation.bidirectional
      ? [
          relation.origin,
          relation.relation,
          ...[relation.source, relation.target].sort()
        ].join(":")
      : relation.id;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    compacted.push(relation);
  }

  return compacted;
}

function focusedClaimIds(id: string, relations: UiRelation[]): Set<string> {
  const ids = new Set([id]);

  for (const relation of relations) {
    if (relation.source === id) {
      ids.add(relation.target);
    }

    if (relation.target === id) {
      ids.add(relation.source);
    }
  }

  return ids;
}

function searchableText(claim: UiClaimSummary): string {
  return [
    claim.id,
    claim.title,
    claim.claim,
    claim.system,
    claim.status,
    claim.severity,
    ...claim.tags,
    claim.sourcePath
  ]
    .join(" ")
    .toLowerCase();
}

function toggleSet<T>(values: Set<T>, value: T): Set<T> {
  const next = new Set(values);

  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }

  return next;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function readStoredDrawerWidth(): number {
  const stored = window.localStorage.getItem(drawerWidthKey);
  const parsed = stored ? Number(stored) : defaultDrawerWidth;
  return clamp(Number.isFinite(parsed) ? parsed : defaultDrawerWidth, minDrawerWidth, maxDrawerWidth);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function statusColor(status: string): string {
  const colors: Record<string, string> = {
    current: "#0f766e",
    proposed: "#7c3aed",
    stale: "#b45309",
    deprecated: "#64748b",
    experimental: "#2563eb",
    needs_verification: "#dc2626",
    needs_review: "#be123c",
    rejected: "#1f2937"
  };

  return colors[status] ?? "#475569";
}

function originColor(origin: Origin): string {
  return {
    explicit: "#0f766e",
    inferred: "#64748b",
    recipe: "#7c3aed",
    replacement: "#b45309"
  }[origin];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body);
  }

  return (await response.json()) as T;
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

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
  type NodeChange
} from "@xyflow/react";
import { type CSSProperties, type PointerEvent, useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Mode = "graph" | "files" | "review";
type Origin = "explicit" | "inferred" | "recipe" | "replacement";

interface UiMemoryModel {
  repoRoot: string;
  memoryRoot: string;
  databasePath: string;
  commandPrefix: string;
  claims: UiClaim[];
  relations: UiRelation[];
  files: UiFileNode;
  validation: ValidationResult;
  doctor: DoctorResult;
  reviewQueue: UiReviewItem[];
}

interface UiClaim {
  id: string;
  type: string;
  system: string;
  status: string;
  confidence: string;
  severity: string;
  title: string;
  claim: string;
  sourcePath: string;
  sourceFiles: string[];
  relatedFiles: string[];
  symbols: string[];
  routes: string[];
  tags: string[];
  verification: string[];
  body: string;
  raw: Record<string, unknown>;
  reviewPriority: number;
  reviewReason?: string;
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
  const [focusId, setFocusId] = useState<string | null>(null);
  const [notice, setNotice] = useState("Loading memory...");
  const [busy, setBusy] = useState(false);
  const token = useMemo(() => new URLSearchParams(window.location.search).get("token") ?? "", []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await api<UiMemoryModel>("/api/memory");
      setMemory(next);
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

  const claims = useMemo(() => {
    if (!memory) {
      return [];
    }

    const byFocus = focusId ? focusedClaimIds(focusId, memory.relations) : null;
    const normalizedQuery = query.trim().toLowerCase();

    return memory.claims.filter((claim) => {
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
    });
  }, [focusId, memory, query, severity, status, system]);

  const claimIds = useMemo(() => new Set(claims.map((claim) => claim.id)), [claims]);
  const graph = useMemo(() => buildGraph(claims, memory?.relations ?? [], claimIds, enabledOrigins), [claimIds, claims, enabledOrigins, memory]);
  const systems = useMemo(() => unique(memory?.claims.map((claim) => claim.system) ?? []), [memory]);
  const severities = useMemo(() => unique(memory?.claims.map((claim) => claim.severity) ?? []), [memory]);

  async function selectClaim(id: string) {
    setDetail(await api<ClaimDetail>(`/api/claims/${encodeURIComponent(id)}`));
    setDrawerOpen(true);
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
            onSelect={selectClaim}
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

function GraphView(props: {
  nodes: Node[];
  edges: Edge[];
  focusId: string | null;
  onSelect(id: string): void;
  onFocus(id: string): void;
  onClearFocus(): void;
}) {
  const [nodes, setNodes] = useState(props.nodes);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
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
        onNodeClick={(_event, node) => void props.onSelect(node.id)}
        onNodeDoubleClick={(_event, node) => props.onFocus(node.id)}
      >
        <Background gap={28} size={1} />
        <Controls showInteractive={false} />
        <MiniMap nodeColor={(node) => String(node.data.color ?? "#94a3b8")} pannable zoomable />
        <Panel position="top-left" className="graph-panel">
          <strong>{props.nodes.length}</strong> claims · <strong>{props.edges.length}</strong> relations
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
  claims: UiClaim[],
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
      id: claim.id,
      position: positions.get(claim.id) ?? { x: 0, y: 0 },
      data: {
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
    source: relation.source,
    target: relation.target,
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
  claims: UiClaim[],
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

function searchableText(claim: UiClaim): string {
  return [
    claim.id,
    claim.title,
    claim.claim,
    claim.system,
    claim.status,
    claim.severity,
    ...claim.tags,
    ...claim.sourceFiles,
    ...claim.relatedFiles,
    ...claim.symbols,
    ...claim.routes
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

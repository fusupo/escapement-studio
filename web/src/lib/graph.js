import * as d3 from "d3";
import dagre from "dagre";

const STATE_COLORS = {
  done: "#238636",
  in_progress: "#d29922",
  open_pr: "#a371f7",
  planned: "#58a6ff",
  deferred: "#8b949e",
  cancelled: "#f85149",
};

const EDGE_STYLES = {
  depends_on: { color: "#58a6ff", dash: null, width: 1.5 },
  is_part_of: { color: "#3fb950", dash: "6,3", width: 1.5 },
  implemented_by: { color: "#d29922", dash: "2,3", width: 1.5 },
};

const PR_RING_COLOR = "#a371f7";
const PR_MERGED_RING_COLOR = "#238636";

const KIND_RADIUS = {
  issue: 8,
  capability: 12,
  phase: 16,
  track: 14,
};

function edgeStyle(rel) {
  return EDGE_STYLES[rel] ?? { color: "#484f58", dash: null, width: 1.2 };
}

/**
 * Extract pull request info from a work item.
 */
function extractPullRequest(item) {
  const pr =
    item.pull_request ??
    item.meta?.pull_request ??
    item.meta?.studio_post_merge_sync?.pull_request ??
    null;
  if (!pr || !pr.number) return null;
  return pr;
}

/**
 * Classify PR status: "merged" | "open" | "draft" | "closed" | null
 */
function classifyPrStatus(pr) {
  if (!pr) return null;
  if (pr.merged_at) return "merged";
  if (pr.is_draft) return "draft";
  if (pr.state === "closed") return "closed";
  return "open";
}

function ensureTooltip() {
  const existing = document.querySelector(".graph-tooltip");
  if (existing) existing.remove();

  const tooltip = document.createElement("div");
  tooltip.className = "graph-tooltip";
  Object.assign(tooltip.style, {
    position: "fixed",
    pointerEvents: "none",
    display: "none",
    zIndex: "9999",
    maxWidth: "360px",
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1px solid #30363d",
    background: "#1c2128",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    color: "#c9d1d9",
    fontSize: "12px",
    fontFamily: "inherit",
  });
  document.body.appendChild(tooltip);
  return tooltip;
}

function showTooltip(tooltip, event, content) {
  if (!tooltip) return;
  tooltip.innerHTML = content;
  tooltip.style.display = "block";
  tooltip.style.left = (event.clientX + 14) + "px";
  tooltip.style.top = (event.clientY + 14) + "px";
}

function hideTooltip(tooltip) {
  if (!tooltip) return;
  tooltip.style.display = "none";
}

/**
 * Render the dependency graph using dagre for layout, D3 for rendering.
 */
export function renderGraph(svgElement, graph, selectedId, onSelect, options = {}) {
  if (!svgElement) return () => {};

  const width = svgElement.clientWidth || 900;
  const height = svgElement.clientHeight || 640;

  const svg = d3.select(svgElement);
  svg.selectAll("*").remove();
  svg.attr("viewBox", [0, 0, width, height]);

  const tooltip = ensureTooltip();

  // Build PR map from execution runs
  const runPrByWorkItem = new Map();
  if (options.executionRuns) {
    for (const run of options.executionRuns) {
      if (run.pull_request && run.work_item_id) {
        runPrByWorkItem.set(run.work_item_id, run.pull_request);
      }
    }
  }

  const nodes = graph.items.map((item) => {
    const node = { ...item };
    if (!extractPullRequest(node) && runPrByWorkItem.has(node.id)) {
      node.pull_request = runPrByWorkItem.get(node.id);
    }
    node._pr = extractPullRequest(node);
    node._prStatus = classifyPrStatus(node._pr);
    return node;
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const links = graph.edges
    .filter((e) => nodeById.has(e.from_id) && nodeById.has(e.to_id))
    .map((e) => ({
      source: e.from_id,
      target: e.to_id,
      rel: e.rel,
      confidence: e.confidence,
    }));

  // --- Dagre layout ---
  const g_layout = new dagre.graphlib.Graph();
  g_layout.setGraph({
    rankdir: "LR",       // left-to-right
    nodesep: 25,          // vertical spacing between nodes
    ranksep: 80,          // horizontal spacing between ranks
    edgesep: 10,
    marginx: 30,
    marginy: 30,
  });
  g_layout.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    const r = KIND_RADIUS[node.kind] ?? 8;
    g_layout.setNode(node.id, {
      width: Math.max(node.id.length * 7 + r * 2, 50),
      height: r * 2 + 6,
    });
  }

  for (const link of links) {
    // Edge direction: dependency flows from target → source (target is upstream)
    // dagre wants edges pointing in rank direction, so upstream → downstream
    g_layout.setEdge(link.target, link.source);
  }

  dagre.layout(g_layout);

  // Apply dagre positions to nodes
  for (const node of nodes) {
    const pos = g_layout.node(node.id);
    if (pos) {
      node.x = pos.x;
      node.y = pos.y;
    }
  }

  // Get dagre edge points for routing
  const edgePoints = new Map();
  for (const link of links) {
    const edge = g_layout.edge(link.target, link.source);
    if (edge?.points) {
      edgePoints.set(`${link.source}->${link.target}`, edge.points);
    }
  }

  // --- D3 Rendering ---

  // Arrow markers
  const defs = svg.append("defs");
  for (const [rel, style] of Object.entries(EDGE_STYLES)) {
    defs.append("marker")
      .attr("id", `arrow-${rel}`)
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 6)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", style.color);
  }

  const g = svg.append("g");

  // Zoom + pan
  const zoom = d3.zoom()
    .scaleExtent([0.1, 6])
    .on("zoom", (event) => g.attr("transform", event.transform));
  svg.call(zoom);
  svg.on("dblclick.zoom", null);

  // Auto-fit: compute bounding box and center
  const graphInfo = g_layout.graph();
  if (graphInfo.width && graphInfo.height) {
    const pad = 60;
    const gw = graphInfo.width + pad * 2;
    const gh = graphInfo.height + pad * 2;
    const scale = Math.min(width / gw, height / gh, 1.5);
    const tx = (width - graphInfo.width * scale) / 2;
    const ty = (height - graphInfo.height * scale) / 2;
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }

  // Shorten a point towards another point by `dist` pixels
  function shortenPoint(p, toward, dist) {
    const dx = toward.x - p.x;
    const dy = toward.y - p.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.1) return { ...p };
    const ratio = dist / len;
    return { x: p.x + dx * ratio, y: p.y + dy * ratio };
  }

  // Build path from dagre edge points, trimmed to node circle edges
  function buildEdgePath(d) {
    const key = `${d.source}->${d.target}`;
    const pts = edgePoints.get(key);
    const src = nodeById.get(d.source);
    const tgt = nodeById.get(d.target);
    if (pts && pts.length >= 2 && src && tgt) {
      const srcR = KIND_RADIUS[src.kind] ?? 8;
      const tgtR = KIND_RADIUS[tgt.kind] ?? 8;
      // Trim start and end points to circle edge
      const trimmed = [...pts];
      trimmed[0] = shortenPoint(trimmed[0], trimmed[1], srcR);
      trimmed[trimmed.length - 1] = shortenPoint(trimmed[trimmed.length - 1], trimmed[trimmed.length - 2], tgtR);
      const line = d3.line().x((p) => p.x).y((p) => p.y).curve(d3.curveBasis);
      return line(trimmed);
    }
    // Fallback: straight line
    if (src && tgt) {
      return `M${src.x},${src.y} L${tgt.x},${tgt.y}`;
    }
    return "";
  }

  // Edges
  const link_el = g.append("g")
    .attr("fill", "none")
    .selectAll("path")
    .data(links)
    .join("path")
    .attr("d", buildEdgePath)
    .attr("stroke", (d) => edgeStyle(d.rel).color)
    .attr("stroke-width", (d) => d.confidence === "ambiguous" ? 1 : edgeStyle(d.rel).width)
    .attr("stroke-dasharray", (d) => edgeStyle(d.rel).dash)
    .attr("stroke-opacity", 0.5)
    .attr("marker-end", (d) => `url(#arrow-${d.rel})`);

  // Edge hover hitbox
  const linkHitbox = g.append("g")
    .attr("fill", "none")
    .selectAll("path")
    .data(links)
    .join("path")
    .attr("d", buildEdgePath)
    .attr("stroke", "transparent")
    .attr("stroke-width", 16)
    .style("cursor", "default");

  // Nodes
  const node_el = g.append("g")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("transform", (d) => `translate(${d.x},${d.y})`)
    .style("cursor", "pointer");

  // PR ring — only for merged PRs on done items
  node_el.filter((d) => d._prStatus === "merged" && d.state === "done")
    .append("circle")
    .attr("class", "pr-ring")
    .attr("r", (d) => (KIND_RADIUS[d.kind] ?? 8) + 4)
    .attr("fill", "none")
    .attr("stroke", PR_MERGED_RING_COLOR)
    .attr("stroke-width", 2)
    .attr("opacity", 0.85);

  // Node circles
  node_el.append("circle")
    .attr("r", (d) => KIND_RADIUS[d.kind] ?? 8)
    .attr("fill", (d) => STATE_COLORS[d.state] ?? "#484f58")
    .attr("stroke", (d) => d.id === selectedId ? "#e6edf3" : "#0d1117")
    .attr("stroke-width", (d) => d.id === selectedId ? 2.5 : 1.5);

  // PR badge
  node_el.filter((d) => d._prStatus === "merged" && d.state === "done")
    .append("text")
    .text("✓PR")
    .attr("dy", (d) => (KIND_RADIUS[d.kind] ?? 8) + 13)
    .attr("text-anchor", "middle")
    .attr("fill", PR_MERGED_RING_COLOR)
    .attr("font-size", "9px")
    .attr("font-weight", "600")
    .attr("font-family", "inherit")
    .attr("pointer-events", "none");

  // Labels
  node_el.append("text")
    .text((d) => d.id)
    .attr("dx", (d) => (KIND_RADIUS[d.kind] ?? 8) + 5)
    .attr("dy", "0.35em")
    .attr("fill", "#8b949e")
    .attr("font-size", "11px")
    .attr("font-family", "inherit")
    .attr("pointer-events", "none");

  // Click to select
  node_el.on("click", (_, d) => onSelect(d));

  // Node hover
  node_el.on("mouseenter", (event, d) => {
    d3.select(event.currentTarget).select("circle:not(.pr-ring)")
      .attr("stroke", "#e6edf3").attr("stroke-width", 2.5);

    const inbound = links.filter((l) => l.target === d.id).length;
    const outbound = links.filter((l) => l.source === d.id).length;

    let body = `<div style="font-weight:600;color:#e6edf3;margin-bottom:4px;">${d.id}: ${d.name}</div>`;
    body += `<div style="color:#8b949e;margin:2px 0;">Kind: <span style="color:#c9d1d9">${d.kind}</span></div>`;
    body += `<div style="color:#8b949e;margin:2px 0;">State: <span style="color:#c9d1d9">${d.state}</span></div>`;
    body += `<div style="color:#8b949e;margin:2px 0;">Edges: <span style="color:#c9d1d9">${inbound} in / ${outbound} out</span></div>`;
    if (d.issue_number) body += `<div style="color:#8b949e;margin:2px 0;">Issue: <span style="color:#c9d1d9">#${d.issue_number}</span></div>`;
    if (d.repo) body += `<div style="color:#8b949e;margin:2px 0;">Repo: <span style="color:#c9d1d9">${d.repo}</span></div>`;
    if (d.scope_hint) body += `<div style="color:#8b949e;margin:2px 0;">Scope: <span style="color:#c9d1d9">${d.scope_hint}</span></div>`;
    if (d._pr) {
      const prColor = d._prStatus === "merged" ? PR_MERGED_RING_COLOR
        : d._prStatus === "draft" ? "#8b949e"
        : PR_RING_COLOR;
      const statusLabel = d._prStatus === "merged" ? "Merged"
        : d._prStatus === "draft" ? "Draft"
        : d._prStatus === "closed" ? "Closed"
        : "Open";
      body += `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #30363d;">`;
      body += `<div style="color:${prColor};font-weight:600;margin-bottom:2px;">PR #${d._pr.number} · ${statusLabel}</div>`;
      if (d._pr.title) body += `<div style="color:#c9d1d9;font-size:11px;">${d._pr.title}</div>`;
      if (d._pr.url) body += `<div style="color:#58a6ff;font-size:11px;margin-top:2px;">${d._pr.url}</div>`;
      if (d._pr.head_ref) body += `<div style="color:#8b949e;font-size:11px;margin-top:2px;">${d._pr.head_ref} → ${d._pr.base_ref ?? "?"}</div>`;
      body += `</div>`;
    }

    showTooltip(tooltip, event, body);
  })
  .on("mousemove", (event) => {
    if (!tooltip) return;
    tooltip.style.left = (event.clientX + 14) + "px";
    tooltip.style.top = (event.clientY + 14) + "px";
  })
  .on("mouseleave", (event) => {
    const d = d3.select(event.currentTarget).datum();
    d3.select(event.currentTarget).select("circle:not(.pr-ring)")
      .attr("stroke", d.id === selectedId ? "#e6edf3" : "#0d1117")
      .attr("stroke-width", d.id === selectedId ? 2.5 : 1.5);
    hideTooltip(tooltip);
  });

  // Edge hover
  linkHitbox.on("mouseenter", (event, d) => {
    const src = nodeById.get(d.source);
    const tgt = nodeById.get(d.target);

    let body = `<div style="font-weight:600;color:#e6edf3;margin-bottom:4px;">${d.rel.replace(/_/g, " ")}</div>`;
    body += `<div style="color:#c9d1d9;">${src?.name ?? d.source} → ${tgt?.name ?? d.target}</div>`;
    body += `<div style="color:#8b949e;font-size:11px;margin-top:2px;">${src?.id ?? d.source} → ${tgt?.id ?? d.target}</div>`;

    showTooltip(tooltip, event, body);
  })
  .on("mousemove", (event) => {
    if (!tooltip) return;
    tooltip.style.left = (event.clientX + 14) + "px";
    tooltip.style.top = (event.clientY + 14) + "px";
  })
  .on("mouseleave", () => hideTooltip(tooltip));

  return () => {
    hideTooltip(tooltip);
    tooltip?.remove();
  };
}

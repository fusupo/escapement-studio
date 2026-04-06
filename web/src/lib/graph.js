import * as d3 from "d3";

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

const PR_RING_COLOR = "#a371f7"; // purple ring for open PRs
const PR_MERGED_RING_COLOR = "#238636"; // green ring for merged PRs

const KIND_RADIUS = {
  issue: 8,
  capability: 12,
  phase: 16,
  track: 14,
};

function edgeStyle(rel) {
  return EDGE_STYLES[rel] ?? { color: "#484f58", dash: null, width: 1.2 };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Extract pull request info from a work item, checking multiple locations:
 * - item.pull_request (backend-enriched)
 * - item.meta.pull_request (direct meta)
 * - item.meta.studio_post_merge_sync.pull_request (post-merge sync)
 * Returns { number, url, title, state, merged_at, is_draft, head_ref, base_ref } or null.
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
 * Classify PR status for visual rendering.
 * Returns "merged" | "open" | "draft" | "closed" | null
 */
function classifyPrStatus(pr) {
  if (!pr) return null;
  if (pr.merged_at) return "merged";
  if (pr.is_draft) return "draft";
  if (pr.state === "closed") return "closed";
  return "open";
}

function computeLayers(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));

  // Build adjacency: upstream → downstream
  // All edge types: "to" is upstream of "from"
  const children = new Map();
  const parentCount = new Map();
  for (const id of ids) {
    children.set(id, []);
    parentCount.set(id, 0);
  }

  for (const e of edges) {
    if (!ids.has(e.from_id) || !ids.has(e.to_id)) continue;
    children.get(e.to_id).push(e.from_id);
    parentCount.set(e.from_id, parentCount.get(e.from_id) + 1);
  }

  // BFS longest-path layering
  const depth = new Map();
  const queue = [];
  for (const id of ids) {
    if (parentCount.get(id) === 0) {
      depth.set(id, 0);
      queue.push(id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    const d = depth.get(u);
    for (const v of children.get(u)) {
      const newD = d + 1;
      if (!depth.has(v) || depth.get(v) < newD) {
        depth.set(v, newD);
      }
      parentCount.set(v, parentCount.get(v) - 1);
      if (parentCount.get(v) === 0) queue.push(v);
    }
  }

  // Handle cycles or disconnected nodes
  const maxDepth = Math.max(0, ...depth.values());
  for (const id of ids) {
    if (!depth.has(id)) depth.set(id, maxDepth + 1);
  }

  return depth;
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
 * Render the dependency graph.
 * @param {SVGElement} svgElement
 * @param {{ items: Array, edges: Array }} graph
 * @param {string|null} selectedId
 * @param {function} onSelect
 * @param {{ executionRuns?: Array }} options - Optional. executionRuns: array of
 *   execution run records keyed by work_item_id, used to enrich nodes with open PR data.
 */
export function renderGraph(svgElement, graph, selectedId, onSelect, options = {}) {
  if (!svgElement) return () => {};

  const width = svgElement.clientWidth || 900;
  const height = svgElement.clientHeight || 640;

  const svg = d3.select(svgElement);
  svg.selectAll("*").remove();
  svg.attr("viewBox", [0, 0, width, height]);

  const tooltip = ensureTooltip();

  // Build a map of work_item_id → PR from execution runs (for open PRs)
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
    // Enrich with PR data from execution runs if not already present
    if (!extractPullRequest(node) && runPrByWorkItem.has(node.id)) {
      node.pull_request = runPrByWorkItem.get(node.id);
    }
    // Cache extracted PR info
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

  // Compute topological layers
  const depthMap = computeLayers(nodes, graph.edges);
  const maxLayer = Math.max(0, ...depthMap.values());

  const MARGIN_X = 120;
  const MARGIN_Y = 60;
  const layerSpacing = maxLayer > 0
    ? (width - MARGIN_X * 2) / maxLayer
    : width / 2;

  // Group nodes by layer
  const layers = new Map();
  for (const n of nodes) {
    const d = depthMap.get(n.id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n);
  }

  // Assign initial positions
  for (const [layer, group] of layers) {
    const x = MARGIN_X + layer * layerSpacing;
    const ySpacing = Math.min(50, (height - MARGIN_Y * 2) / (group.length + 1));
    const yStart = height / 2 - ((group.length - 1) * ySpacing) / 2;
    group.forEach((n, i) => {
      n.x = x;
      n.y = yStart + i * ySpacing;
      n._layerX = x;
      n._layer = layer;
    });
  }

  // Defs for arrow markers
  const defs = svg.append("defs");
  for (const [rel, style] of Object.entries(EDGE_STYLES)) {
    defs.append("marker")
      .attr("id", `arrow-${rel}`)
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", style.color);
  }

  const g = svg.append("g");

  // Zoom
  svg.call(d3.zoom()
    .scaleExtent([0.1, 6])
    .on("zoom", (event) => g.attr("transform", event.transform))
  );
  svg.on("dblclick.zoom", null);

  // Force simulation
  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance(layerSpacing * 0.8).strength(0.1))
    .force("x", d3.forceX((d) => d._layerX).strength(0.8))
    .force("y", d3.forceY(height / 2).strength(0.02))
    .force("charge", d3.forceManyBody().strength(-150))
    .force("collision", d3.forceCollide().radius(25))
    .alphaDecay(0.03);

  // Edges
  const link = g.append("g")
    .attr("fill", "none")
    .selectAll("path")
    .data(links)
    .join("path")
    .attr("stroke", (d) => edgeStyle(d.rel).color)
    .attr("stroke-width", (d) => d.confidence === "ambiguous" ? 1 : edgeStyle(d.rel).width)
    .attr("stroke-dasharray", (d) => edgeStyle(d.rel).dash)
    .attr("stroke-opacity", 0.5)
    .attr("marker-end", (d) => `url(#arrow-${d.rel})`);

  // Edge hover — invisible wider hitbox
  const linkHitbox = g.append("g")
    .attr("fill", "none")
    .selectAll("path")
    .data(links)
    .join("path")
    .attr("stroke", "transparent")
    .attr("stroke-width", 16)
    .style("cursor", "default");

  // Nodes
  const node = g.append("g")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (event) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on("drag", (event) => {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      })
      .on("end", (event) => {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      })
    );

  // PR ring — only for merged PRs (open_pr state handles open/draft via node color)
  node.filter((d) => d._prStatus === "merged" && d.state === "done")
    .append("circle")
    .attr("class", "pr-ring")
    .attr("r", (d) => (KIND_RADIUS[d.kind] ?? 8) + 4)
    .attr("fill", "none")
    .attr("stroke", PR_MERGED_RING_COLOR)
    .attr("stroke-width", 2)
    .attr("opacity", 0.85);

  // Node circles — colored by state
  node.append("circle")
    .attr("r", (d) => KIND_RADIUS[d.kind] ?? 8)
    .attr("fill", (d) => STATE_COLORS[d.state] ?? "#484f58")
    .attr("stroke", (d) => d.id === selectedId ? "#e6edf3" : "#0d1117")
    .attr("stroke-width", (d) => d.id === selectedId ? 2.5 : 1.5);

  // PR badge — only for merged PRs on done items
  node.filter((d) => d._prStatus === "merged" && d.state === "done")
    .append("text")
    .text("✓PR")
    .attr("dy", (d) => (KIND_RADIUS[d.kind] ?? 8) + 13)
    .attr("text-anchor", "middle")
    .attr("fill", PR_MERGED_RING_COLOR)
    .attr("font-size", "9px")
    .attr("font-weight", "600")
    .attr("font-family", "inherit")
    .attr("pointer-events", "none");

  // Labels — beside the node
  node.append("text")
    .text((d) => d.id)
    .attr("dx", (d) => (KIND_RADIUS[d.kind] ?? 8) + 5)
    .attr("dy", "0.35em")
    .attr("fill", "#8b949e")
    .attr("font-size", "11px")
    .attr("font-family", "inherit")
    .attr("pointer-events", "none");

  // Click to select
  node.on("click", (_, d) => onSelect(d));

  // Node hover
  node.on("mouseenter", (event, d) => {
    d3.select(event.currentTarget).select("circle:not(.pr-ring)")
      .attr("stroke", "#e6edf3").attr("stroke-width", 2.5);

    const inbound = links.filter((l) => l.target === d.id || l.target.id === d.id).length;
    const outbound = links.filter((l) => l.source === d.id || l.source.id === d.id).length;

    let body = `<div style="font-weight:600;color:#e6edf3;margin-bottom:4px;">${d.id}: ${d.name}</div>`;
    body += `<div style="color:#8b949e;margin:2px 0;">Kind: <span style="color:#c9d1d9">${d.kind}</span></div>`;
    body += `<div style="color:#8b949e;margin:2px 0;">State: <span style="color:#c9d1d9">${d.state}</span></div>`;
    body += `<div style="color:#8b949e;margin:2px 0;">Layer: <span style="color:#c9d1d9">${depthMap.get(d.id) ?? "?"}</span></div>`;
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
    const src = typeof d.source === "object" ? d.source : nodeById.get(d.source);
    const tgt = typeof d.target === "object" ? d.target : nodeById.get(d.target);
    const style = edgeStyle(d.rel);

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

  // Tick
  simulation.on("tick", () => {
    const curvePath = (d) => {
      const sx = d.source.x, sy = d.source.y;
      const tx = d.target.x, ty = d.target.y;
      const dx = tx - sx;
      const cp = dx * 0.4;
      return `M${sx},${sy} C${sx + cp},${sy} ${tx - cp},${ty} ${tx},${ty}`;
    };

    link.attr("d", curvePath);
    linkHitbox.attr("d", curvePath);
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  return () => {
    simulation.stop();
    hideTooltip(tooltip);
    tooltip?.remove();
  };
}

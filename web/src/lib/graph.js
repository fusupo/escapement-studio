import * as d3 from "d3";
import * as dagreD3 from "dagre-d3-es";

const STATE_COLORS = {
  done: "#238636",
  in_progress: "#d29922",
  open_pr: "#a371f7",
  planned: "#58a6ff",
  deferred: "#8b949e",
  cancelled: "#f85149",
};

const EDGE_COLORS = {
  depends_on: "#58a6ff",
  is_part_of: "#3fb950",
  implemented_by: "#d29922",
};

const EDGE_DASH = {
  depends_on: "",
  is_part_of: "6,3",
  implemented_by: "2,3",
};

const PR_MERGED_RING_COLOR = "#238636";
const PR_RING_COLOR = "#a371f7";

function extractPullRequest(item) {
  const pr =
    item.pull_request ??
    item.meta?.pull_request ??
    item.meta?.studio_post_merge_sync?.pull_request ??
    null;
  if (!pr || !pr.number) return null;
  return pr;
}

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
 * Render the dependency graph using dagre-d3 natively.
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

  // --- Build dagre-d3 graph ---
  const g = new dagreD3.graphlib.Graph().setGraph({
    rankdir: "LR",
    nodesep: 20,
    ranksep: 40,
    edgesep: 8,
    marginx: 20,
    marginy: 20,
  }).setDefaultEdgeLabel(() => ({}));

  // Nodes — rounded rects with label inside, colored by state
  for (const node of nodes) {
    const color = STATE_COLORS[node.state] ?? "#484f58";
    const isSelected = node.id === selectedId;
    const borderColor = isSelected ? "#e6edf3" : "rgba(255,255,255,0.15)";
    const borderWidth = isSelected ? "2.5px" : "1px";

    g.setNode(node.id, {
      label: node.id,
      style: `fill: ${color}; stroke: ${borderColor}; stroke-width: ${borderWidth};`,
      labelStyle: "fill: #fff; font-size: 11px; font-weight: 500;",
      rx: 5,
      ry: 5,
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 4,
      paddingBottom: 4,
      _data: node,
    });
  }

  // Edges
  for (const link of links) {
    const color = EDGE_COLORS[link.rel] ?? "#484f58";
    const dash = EDGE_DASH[link.rel] ?? "";
    const w = link.confidence === "ambiguous" ? 1 : 1.5;

    g.setEdge(link.target, link.source, {
      style: `stroke: ${color}; stroke-width: ${w}px; fill: none; stroke-opacity: 0.6;${dash ? ` stroke-dasharray: ${dash};` : ""}`,
      arrowheadStyle: `fill: ${color}; stroke: none; opacity: 0.8;`,
      curve: d3.curveBasis,
      _data: link,
    });
  }

  // --- Render ---
  const inner = svg.append("g");
  const render = dagreD3.render();
  render(inner, g);

  // --- Zoom + pan ---
  const zoom = d3.zoom()
    .scaleExtent([0.1, 6])
    .on("zoom", (event) => inner.attr("transform", event.transform));
  svg.call(zoom);
  svg.on("dblclick.zoom", null);

  // Auto-fit
  const graphInfo = g.graph();
  if (graphInfo.width && graphInfo.height) {
    const pad = 20;
    const gw = graphInfo.width + pad * 2;
    const gh = graphInfo.height + pad * 2;
    const scale = Math.min(width / gw, height / gh, 1.5);
    const tx = (width - graphInfo.width * scale) / 2;
    const ty = (height - graphInfo.height * scale) / 2;
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }

  // --- Post-render: add merged PR badges ---
  inner.selectAll("g.node").each(function (id) {
    const nodeData = g.node(id);
    if (!nodeData?._data) return;
    const data = nodeData._data;
    if (data._prStatus === "merged" && data.state === "done") {
      const el = d3.select(this);
      const bbox = el.select("rect").node()?.getBBox();
      if (bbox) {
        el.append("text")
          .text("✓PR")
          .attr("x", bbox.x + bbox.width / 2)
          .attr("y", bbox.y + bbox.height + 12)
          .attr("text-anchor", "middle")
          .attr("fill", PR_MERGED_RING_COLOR)
          .attr("font-size", "9px")
          .attr("font-weight", "600")
          .attr("pointer-events", "none");
      }
    }
  });

  // --- Interactions ---

  // Node click + cursor
  inner.selectAll("g.node")
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
  node.on("click", (event, d) => {
    event.stopPropagation();
    onSelect(d);
  });

  // Click background to deselect
  svg.on("click", () => onSelect(null));
    .on("click", function (event, id) {
      const data = g.node(id)?._data;
      if (data) onSelect(data);
    });

  // Node hover
  inner.selectAll("g.node")
    .on("mouseenter", function (event) {
      const id = d3.select(this).datum();
      const data = g.node(id)?._data;
      if (!data) return;

      d3.select(this).select("rect")
        .attr("stroke", "#e6edf3").attr("stroke-width", "2.5px");

      const inbound = links.filter((l) => l.target === data.id).length;
      const outbound = links.filter((l) => l.source === data.id).length;

      let body = `<div style="font-weight:600;color:#e6edf3;margin-bottom:4px;">${data.id}: ${data.name}</div>`;
      body += `<div style="color:#8b949e;margin:2px 0;">Kind: <span style="color:#c9d1d9">${data.kind}</span></div>`;
      body += `<div style="color:#8b949e;margin:2px 0;">State: <span style="color:#c9d1d9">${data.state}</span></div>`;
      body += `<div style="color:#8b949e;margin:2px 0;">Edges: <span style="color:#c9d1d9">${inbound} in / ${outbound} out</span></div>`;
      if (data.issue_number) body += `<div style="color:#8b949e;margin:2px 0;">Issue: <span style="color:#c9d1d9">#${data.issue_number}</span></div>`;
      if (data.repo) body += `<div style="color:#8b949e;margin:2px 0;">Repo: <span style="color:#c9d1d9">${data.repo}</span></div>`;
      if (data.scope_hint) body += `<div style="color:#8b949e;margin:2px 0;">Scope: <span style="color:#c9d1d9">${data.scope_hint}</span></div>`;
      if (data._pr) {
        const prColor = data._prStatus === "merged" ? PR_MERGED_RING_COLOR
          : data._prStatus === "draft" ? "#8b949e" : PR_RING_COLOR;
        const statusLabel = data._prStatus === "merged" ? "Merged"
          : data._prStatus === "draft" ? "Draft"
          : data._prStatus === "closed" ? "Closed" : "Open";
        body += `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #30363d;">`;
        body += `<div style="color:${prColor};font-weight:600;margin-bottom:2px;">PR #${data._pr.number} · ${statusLabel}</div>`;
        if (data._pr.title) body += `<div style="color:#c9d1d9;font-size:11px;">${data._pr.title}</div>`;
        if (data._pr.url) body += `<div style="color:#58a6ff;font-size:11px;margin-top:2px;">${data._pr.url}</div>`;
        if (data._pr.head_ref) body += `<div style="color:#8b949e;font-size:11px;margin-top:2px;">${data._pr.head_ref} → ${data._pr.base_ref ?? "?"}</div>`;
        body += `</div>`;
      }

      showTooltip(tooltip, event, body);
    })
    .on("mousemove", (event) => {
      if (!tooltip) return;
      tooltip.style.left = (event.clientX + 14) + "px";
      tooltip.style.top = (event.clientY + 14) + "px";
    })
    .on("mouseleave", function () {
      const id = d3.select(this).datum();
      const data = g.node(id)?._data;
      if (!data) return;
      const isSelected = data.id === selectedId;
      d3.select(this).select("rect")
        .attr("stroke", isSelected ? "#e6edf3" : "rgba(255,255,255,0.15)")
        .attr("stroke-width", isSelected ? "2.5px" : "1px");
      hideTooltip(tooltip);
    });

  // Edge hover
  inner.selectAll("g.edgePath")
    .on("mouseenter", function (event) {
      const edgeId = d3.select(this).datum();
      const edgeData = g.edge(edgeId);
      if (!edgeData?._data) return;
      const d = edgeData._data;
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

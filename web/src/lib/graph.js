import * as d3 from "d3";
import * as dagreD3 from "dagre-d3-es";

const STATE_COLORS = {
  planned: "#58a6ff",
  drafting: "#79c0ff",
  ready: "#56d364",
  in_progress: "#d29922",
  open_pr: "#a371f7",
  merged_pr: "#2ea08f",
  done: "#238636",
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
    position: "fixed", pointerEvents: "none", display: "none", zIndex: "9999",
    maxWidth: "360px", padding: "10px 14px", borderRadius: "8px",
    border: "1px solid #30363d", background: "#1c2128",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)", color: "#c9d1d9",
    fontSize: "12px", fontFamily: "inherit",
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

function buildTooltipHtml(data, links) {
  const inbound = links.filter((l) => l.target === data.id).length;
  const outbound = links.filter((l) => l.source === data.id).length;

  let body = `<div style="font-weight:600;color:#e6edf3;margin-bottom:4px;">${data.id}: ${data.name}</div>`;
  body += `<div style="color:#8b949e;margin:2px 0;">Kind: <span style="color:#c9d1d9">${data.kind}</span></div>`;
  body += `<div style="color:#8b949e;margin:2px 0;">State: <span style="color:#c9d1d9">${data.state}</span></div>`;
  if (data._isFrontier) body += `<div style="color:#8b949e;margin:2px 0;">Frontier: <span style="color:#c9d1d9">dispatchable</span></div>`;
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
  return body;
}

// Persist zoom transform across renders
let _savedTransform = null;

export function renderGraph(svgElement, graph, selectedId, onSelect, options = {}) {
  if (!svgElement) return { cleanup() {}, updateSelection() {} };

  const width = svgElement.clientWidth || 900;
  const height = svgElement.clientHeight || 640;
  const svg = d3.select(svgElement);
  svg.selectAll("*").remove();
  svg.attr("viewBox", [0, 0, width, height]);
  const tooltip = ensureTooltip();

  // Enrich nodes with PR data from execution runs
  const runPrByWorkItem = new Map();
  if (options.executionRuns) {
    for (const run of options.executionRuns) {
      if (run.pull_request && run.work_item_id) {
        runPrByWorkItem.set(run.work_item_id, run.pull_request);
      }
    }
  }

  const frontierIds = new Set(options.frontierIds ?? []);

  const nodes = graph.items.map((item) => {
    const node = { ...item };
    if (!extractPullRequest(node) && runPrByWorkItem.has(node.id)) {
      node.pull_request = runPrByWorkItem.get(node.id);
    }
    node._pr = extractPullRequest(node);
    node._prStatus = classifyPrStatus(node._pr);
    node._isFrontier = frontierIds.has(node.id);
    return node;
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const links = graph.edges
    .filter((e) => nodeById.has(e.from_id) && nodeById.has(e.to_id))
    .map((e) => ({ source: e.from_id, target: e.to_id, rel: e.rel, confidence: e.confidence }));

  // Build dagre-d3 graph
  const g = new dagreD3.graphlib.Graph().setGraph({
    rankdir: "LR",
    nodesep: 20,
    ranksep: 40,
    edgesep: 8,
    marginx: 20,
    marginy: 20,
  }).setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    const color = STATE_COLORS[node.state] ?? "#484f58";
    const isSelected = node.id === selectedId;
    const classes = ["graph-node"];
    if (node._isFrontier) classes.push("graph-node--frontier");
    if (node.state === "in_progress") classes.push("graph-node--in-progress");

    g.setNode(node.id, {
      label: node.id,
      class: classes.join(" "),
      style: `fill: ${color}; stroke: ${isSelected ? "#e6edf3" : "rgba(255,255,255,0.15)"}; stroke-width: ${isSelected ? "2.5px" : "1px"};`,
      labelStyle: "fill: #fff; font-size: 11px; font-weight: 500;",
      rx: 5, ry: 5,
      paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
      _data: node,
    });
  }

  for (const link of links) {
    const color = EDGE_COLORS[link.rel] ?? "#484f58";
    const dash = EDGE_DASH[link.rel] ?? "";
    const w = link.confidence === "ambiguous" ? 1 : 1.5;
    // target (dependency) ranks first in LR layout
    g.setEdge(link.target, link.source, {
      style: `stroke: ${color}; stroke-width: ${w}px; fill: none; stroke-opacity: 0.6;${dash ? ` stroke-dasharray: ${dash};` : ""}`,
      arrowheadStyle: `fill: none; stroke: none;`,
      curve: d3.curveBasis,
      _data: link,
    });
  }

  // Render
  const inner = svg.append("g");
  const render = dagreD3.render();
  render(inner, g);

  // Post-render: swap arrowheads to source end (reversed direction)
  // Add reversed arrow markers to defs
  const defs = inner.select("defs").empty() ? inner.append("defs") : inner.select("defs");
  const markerColors = new Set();
  for (const link of links) {
    markerColors.add(EDGE_COLORS[link.rel] ?? "#484f58");
  }
  for (const color of markerColors) {
    const markerId = `arrow-rev-${color.replace("#", "")}`;
    defs.append("marker")
      .attr("id", markerId)
      .attr("viewBox", "0 0 10 10")
      .attr("refX", 9)
      .attr("refY", 5)
      .attr("markerUnits", "strokeWidth")
      .attr("markerWidth", 8)
      .attr("markerHeight", 6)
      .attr("orient", "auto-start-reverse")
      .append("path")
      .attr("d", "M 0 0 L 10 5 L 0 10 z")
      .attr("fill", color)
      .attr("opacity", 0.8);
  }

  const frontierPattern = defs.append("pattern")
    .attr("id", "graph-frontier-diagonal-stripes")
    .attr("patternUnits", "userSpaceOnUse")
    .attr("width", 8)
    .attr("height", 8)
    .attr("patternTransform", "rotate(45)");

  frontierPattern.append("rect")
    .attr("width", 8)
    .attr("height", 8)
    .attr("fill", "transparent");

  frontierPattern.append("line")
    .attr("x1", 0)
    .attr("y1", 0)
    .attr("x2", 0)
    .attr("y2", 8)
    .attr("stroke", "rgba(240, 246, 252, 0.92)")
    .attr("stroke-width", 8);

  // Swap marker-end to marker-start on all edge paths
  inner.selectAll("g.edgePath path.path").each(function () {
    const path = d3.select(this);
    const markerEnd = path.attr("marker-end");
    path.attr("marker-end", null);
    // Extract color from the edge's stroke
    const stroke = path.style("stroke") || path.attr("stroke") || "#484f58";
    // Convert rgb to hex if needed
    let hex = stroke;
    const rgbMatch = stroke.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      hex = "#" + [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map(c => parseInt(c).toString(16).padStart(2, "0")).join("");
    }
    const markerId = `arrow-rev-${hex.replace("#", "")}`;
    path.attr("marker-start", `url(#${markerId})`);
  });

  // Zoom + pan
  const zoom = d3.zoom()
    .scaleExtent([0.1, 6])
    .on("zoom", (event) => {
      inner.attr("transform", event.transform);
      _savedTransform = event.transform;
    });
  svg.call(zoom);
  svg.on("dblclick.zoom", null);

  // Restore saved transform or auto-fit
  if (_savedTransform) {
    svg.call(zoom.transform, _savedTransform);
  } else {
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
  }

  // Post-render: state overlays + merged PR badges
  inner.selectAll("g.node").each(function (id) {
    const nodeGroup = d3.select(this);
    const data = g.node(id)?._data;
    if (!data) return;

    nodeGroup
      .classed("selected", data.id === selectedId)
      .classed("graph-node--in-progress", data.state === "in_progress")
      .attr("data-frontier", data._isFrontier ? "true" : "false")
      .attr("data-state", data.state ?? "unknown");

    const baseRect = nodeGroup.select("rect");
    const rectNode = baseRect.node();
    if (rectNode) {
      const x = Number(baseRect.attr("x"));
      const y = Number(baseRect.attr("y"));
      const width = Number(baseRect.attr("width"));
      const height = Number(baseRect.attr("height"));
      const rx = Number(baseRect.attr("rx") || 0);
      const ry = Number(baseRect.attr("ry") || 0);

      if (data._isFrontier) {
        const frontierInset = Math.min(1.5, width / 6, height / 6);
        nodeGroup.insert("rect", "g.label")
          .attr("class", "frontier-overlay")
          .attr("fill", "url(#graph-frontier-diagonal-stripes)")
          .attr("x", x + frontierInset)
          .attr("y", y + frontierInset)
          .attr("width", Math.max(0, width - frontierInset * 2))
          .attr("height", Math.max(0, height - frontierInset * 2))
          .attr("rx", Math.max(0, rx - frontierInset / 2))
          .attr("ry", Math.max(0, ry - frontierInset / 2));
      }

      if (data.state === "in_progress") {
        const progressInset = Math.min(3, width / 5, height / 5);
        nodeGroup.insert("rect", "g.label")
          .attr("class", "in-progress-overlay")
          .attr("x", x + progressInset)
          .attr("y", y + progressInset)
          .attr("width", Math.max(0, width - progressInset * 2))
          .attr("height", Math.max(0, height - progressInset * 2))
          .attr("rx", Math.max(0, rx - progressInset / 2))
          .attr("ry", Math.max(0, ry - progressInset / 2));
      }
    }

    if (data._prStatus !== "merged" || (data.state !== "done" && data.state !== "merged_pr") || !rectNode) return;
    const bbox = rectNode.getBBox();
    nodeGroup.append("text")
      .text("✓PR")
      .attr("x", bbox.x + bbox.width / 2)
      .attr("y", bbox.y + bbox.height + 12)
      .attr("text-anchor", "middle")
      .attr("fill", PR_MERGED_RING_COLOR)
      .attr("font-size", "9px")
      .attr("font-weight", "600")
      .attr("pointer-events", "none");
  });

  // Node interactions
  inner.selectAll("g.node")
    .style("cursor", "pointer")
    .on("click", function (event, id) {
      event.stopPropagation();
      const data = g.node(id)?._data;
      if (data) onSelect(data);
    })
    .on("contextmenu", function (event, id) {
      event.preventDefault();
      event.stopPropagation();
      const data = g.node(id)?._data;
      if (data) {
        onSelect(data);
        options.onContextMenu?.({ item: data, x: event.clientX, y: event.clientY });
      }
      hideTooltip(tooltip);
    })
    .on("mouseenter", function (event) {
      const id = d3.select(this).datum();
      const data = g.node(id)?._data;
      if (!data) return;
      d3.select(this).select("rect").style("stroke", "#8b95a5").style("stroke-width", "1.5px");
      showTooltip(tooltip, event, buildTooltipHtml(data, links));
    })
    .on("mousemove", (event) => {
      if (tooltip) { tooltip.style.left = (event.clientX + 14) + "px"; tooltip.style.top = (event.clientY + 14) + "px"; }
    })
    .on("mouseleave", function () {
      const id = d3.select(this).datum();
      const data = g.node(id)?._data;
      if (!data) return;
      const sel = data.id === selectedId;
      d3.select(this).select("rect")
        .style("stroke", sel ? "#e6edf3" : "rgba(255,255,255,0.15)")
        .style("stroke-width", sel ? "2.5px" : "1px");
      hideTooltip(tooltip);
    });

  // Click background to deselect
  svg.on("click", () => onSelect(null));
  svg.on("contextmenu", (event) => {
    event.preventDefault();
    options.onContextMenu?.(null);
  });

  // Edge hover
  inner.selectAll("g.edgePath")
    .on("mouseenter", function (event) {
      const edgeId = d3.select(this).datum();
      const d = g.edge(edgeId)?._data;
      if (!d) return;
      const src = nodeById.get(d.source);
      const tgt = nodeById.get(d.target);
      let body = `<div style="font-weight:600;color:#e6edf3;margin-bottom:4px;">${d.rel.replace(/_/g, " ")}</div>`;
      body += `<div style="color:#c9d1d9;">${src?.name ?? d.source} → ${tgt?.name ?? d.target}</div>`;
      body += `<div style="color:#8b949e;font-size:11px;margin-top:2px;">${src?.id ?? d.source} → ${tgt?.id ?? d.target}</div>`;
      showTooltip(tooltip, event, body);
    })
    .on("mousemove", (event) => {
      if (tooltip) { tooltip.style.left = (event.clientX + 14) + "px"; tooltip.style.top = (event.clientY + 14) + "px"; }
    })
    .on("mouseleave", () => hideTooltip(tooltip));

  function updateSelection(newSelectedId) {
    selectedId = newSelectedId;
    inner.selectAll("g.node").each(function (nodeId) {
      const data = g.node(nodeId)?._data;
      if (!data) return;
      const sel = data.id === newSelectedId;
      d3.select(this)
        .classed("selected", sel)
        .select("rect")
        .style("stroke", sel ? "#e6edf3" : "rgba(255,255,255,0.15)")
        .style("stroke-width", sel ? "2.5px" : "1px");
    });
  }

  function resize() {
    const newWidth = svgElement.clientWidth || 900;
    const newHeight = svgElement.clientHeight || 640;
    svg.attr("viewBox", [0, 0, newWidth, newHeight]);
  }

  return {
    cleanup() {
      hideTooltip(tooltip);
      tooltip?.remove();
    },
    updateSelection,
    resize,
  };
}

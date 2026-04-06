import * as d3 from "d3";

const KIND_COLORS = {
  issue: "#60a5fa",
  capability: "#34d399",
  phase: "#f59e0b",
  track: "#c084fc",
};

const RELATION_STYLES = {
  depends_on: { color: "#f97316", dash: "7 5", width: 2, label: "depends on" },
  implemented_by: { color: "#22c55e", dash: "0", width: 2.4, label: "implemented by" },
  is_part_of: { color: "#a78bfa", dash: "3 5", width: 1.8, label: "part of" },
  default: { color: "#64748b", dash: "0", width: 1.6, label: "related" },
};

function relationStyle(rel) {
  return RELATION_STYLES[rel] ?? RELATION_STYLES.default;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function summarize(text, max = 180) {
  if (!text) return "No description available.";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function wrapText(value, max = 22) {
  const words = `${value ?? ""}`.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ["Untitled"];

  const lines = [];
  let line = "";

  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }

    if (`${line} ${word}`.length <= max) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines.slice(0, 3).map((entry, index, all) => {
    if (index === all.length - 1 && all.length === 3 && entry.length > max - 1) {
      return `${entry.slice(0, max - 1)}…`;
    }
    return entry;
  });
}

function buildLayeredLayout(nodes, links, width, height) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));

  for (const link of links) {
    incoming.set(link.target.id, (incoming.get(link.target.id) ?? 0) + 1);
    outgoing.get(link.source.id)?.push(link.target.id);
  }

  const queue = nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`))
    .map((node) => node.id);

  const depthById = new Map(nodes.map((node) => [node.id, 0]));
  const visited = new Set();

  while (queue.length > 0) {
    const currentId = queue.shift();
    visited.add(currentId);

    for (const nextId of outgoing.get(currentId) ?? []) {
      depthById.set(nextId, Math.max(depthById.get(nextId) ?? 0, (depthById.get(currentId) ?? 0) + 1));
      incoming.set(nextId, (incoming.get(nextId) ?? 1) - 1);
      if ((incoming.get(nextId) ?? 0) === 0) {
        queue.push(nextId);
      }
    }
  }

  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const fallbackDepth = Math.max(0, ...links.filter((link) => link.target.id === node.id).map((link) => (depthById.get(link.source.id) ?? 0) + 1));
    depthById.set(node.id, fallbackDepth);
  }

  const layers = d3.group(nodes, (node) => depthById.get(node.id) ?? 0);
  const layerKeys = Array.from(layers.keys()).sort((a, b) => a - b);
  const maxLayerSize = Math.max(...Array.from(layers.values(), (layer) => layer.length), 1);
  const horizontalPadding = 110;
  const verticalPadding = 90;
  const layerSpacing = layerKeys.length > 1
    ? (width - horizontalPadding * 2) / (layerKeys.length - 1)
    : 0;
  const bandHeight = Math.max(height - verticalPadding * 2, 240);

  for (const layerKey of layerKeys) {
    const layerNodes = [...(layers.get(layerKey) ?? [])].sort((a, b) => {
      if (a.kind !== b.kind) return `${a.kind}`.localeCompare(`${b.kind}`);
      return `${a.name}`.localeCompare(`${b.name}`);
    });

    const rowSpacing = layerNodes.length > 1
      ? Math.max(92, Math.min(150, bandHeight / (layerNodes.length - 1)))
      : 0;
    const layerVisualHeight = rowSpacing * Math.max(layerNodes.length - 1, 0);
    const startY = height / 2 - layerVisualHeight / 2;

    layerNodes.forEach((node, index) => {
      node.x = horizontalPadding + layerKey * layerSpacing;
      node.y = layerNodes.length === 1 ? height / 2 : startY + index * rowSpacing;
      node.layer = layerKey;
      node.order = index;
      nodeById.set(node.id, node);
    });
  }

  for (const node of nodes) {
    node.x = clamp(node.x ?? width / 2, 72, width - 72);
    node.y = clamp(node.y ?? height / 2, 64, height - 64);
  }

  return {
    layerKeys,
    maxLayer: layerKeys[layerKeys.length - 1] ?? 0,
    maxLayerSize,
  };
}

function ensureTooltip(svgElement) {
  const host = svgElement.parentElement;
  if (!host) return null;

  const existing = host.querySelector(".graph-tooltip");
  if (existing) existing.remove();

  const tooltip = document.createElement("div");
  tooltip.className = "graph-tooltip";
  tooltip.style.position = "absolute";
  tooltip.style.pointerEvents = "none";
  tooltip.style.opacity = "0";
  tooltip.style.minWidth = "220px";
  tooltip.style.maxWidth = "320px";
  tooltip.style.padding = "0.75rem 0.9rem";
  tooltip.style.borderRadius = "14px";
  tooltip.style.border = "1px solid rgba(148, 163, 184, 0.26)";
  tooltip.style.background = "rgba(2, 6, 23, 0.94)";
  tooltip.style.boxShadow = "0 18px 45px rgba(15, 23, 42, 0.45)";
  tooltip.style.backdropFilter = "blur(10px)";
  tooltip.style.color = "#e2e8f0";
  tooltip.style.zIndex = "3";
  host.appendChild(tooltip);

  return tooltip;
}

function showTooltip(tooltip, hostRect, event, content) {
  if (!tooltip) return;
  tooltip.innerHTML = content;
  tooltip.style.opacity = "1";

  const tooltipRect = tooltip.getBoundingClientRect();
  const left = clamp(
    event.clientX - hostRect.left + 18,
    12,
    Math.max(12, hostRect.width - tooltipRect.width - 12),
  );
  const top = clamp(
    event.clientY - hostRect.top + 18,
    12,
    Math.max(12, hostRect.height - tooltipRect.height - 12),
  );

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip(tooltip) {
  if (!tooltip) return;
  tooltip.style.opacity = "0";
}

function edgePath(edge) {
  const sourceX = edge.source.x;
  const sourceY = edge.source.y;
  const targetX = edge.target.x;
  const targetY = edge.target.y;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const curve = Math.max(28, Math.min(96, Math.abs(dx) * 0.32 + Math.abs(dy) * 0.18));
  const c1x = sourceX + curve;
  const c1y = sourceY;
  const c2x = targetX - curve;
  const c2y = targetY;
  return `M ${sourceX} ${sourceY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${targetX} ${targetY}`;
}

function edgeMidpoint(edge) {
  const sourceX = edge.source.x;
  const sourceY = edge.source.y;
  const targetX = edge.target.x;
  const targetY = edge.target.y;
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;
  return [midX, midY - (Math.abs(targetX - sourceX) > 120 ? 14 : 10)];
}

export function renderGraph(svgElement, graph, selectedId, onSelect) {
  if (!svgElement) {
    return () => {};
  }

  const width = svgElement.clientWidth || 900;
  const height = svgElement.clientHeight || 640;

  const svg = d3.select(svgElement);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const tooltip = ensureTooltip(svgElement);
  const hostRect = () => svgElement.parentElement?.getBoundingClientRect() ?? svgElement.getBoundingClientRect();

  const nodes = graph.items.map((item) => ({ ...item }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links = graph.edges
    .map((edge) => ({
      ...edge,
      source: nodeById.get(edge.from_id),
      target: nodeById.get(edge.to_id),
      style: relationStyle(edge.rel),
    }))
    .filter((edge) => edge.source && edge.target);

  const { layerKeys } = buildLayeredLayout(nodes, links, width, height);

  const defs = svg.append("defs");
  Object.entries(RELATION_STYLES).forEach(([key, style]) => {
    defs.append("marker")
      .attr("id", `arrow-${key}`)
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 28)
      .attr("refY", 0)
      .attr("markerWidth", 7)
      .attr("markerHeight", 7)
      .attr("orient", "auto")
      .append("path")
      .attr("fill", style.color)
      .attr("d", "M0,-5L10,0L0,5");
  });

  const root = svg.append("g");

  const layerBackdrop = root.append("g").attr("opacity", 1);
  layerKeys.forEach((layerKey) => {
    const layerNodes = nodes.filter((node) => node.layer === layerKey);
    if (layerNodes.length === 0) return;
    const minY = d3.min(layerNodes, (node) => node.y) ?? height / 2;
    const maxY = d3.max(layerNodes, (node) => node.y) ?? height / 2;
    const x = layerNodes[0].x - 54;
    const bandWidth = 108;
    const bandHeight = Math.max(110, maxY - minY + 120);

    layerBackdrop.append("rect")
      .attr("x", x)
      .attr("y", clamp(minY - 60, 18, height - bandHeight - 18))
      .attr("width", bandWidth)
      .attr("height", bandHeight)
      .attr("rx", 28)
      .attr("fill", "rgba(15, 23, 42, 0.28)")
      .attr("stroke", "rgba(148, 163, 184, 0.08)");

    layerBackdrop.append("text")
      .attr("x", layerNodes[0].x)
      .attr("y", clamp(minY - 24, 24, height - 24))
      .attr("fill", "#64748b")
      .attr("font-size", 11)
      .attr("font-weight", 700)
      .attr("text-anchor", "middle")
      .attr("letter-spacing", "0.12em")
      .text(`LAYER ${layerKey + 1}`);
  });

  const edgeLayer = root.append("g").attr("fill", "none");
  const edge = edgeLayer.selectAll("g")
    .data(links)
    .join("g")
    .style("cursor", "default");

  edge.append("path")
    .attr("class", "edge-hitbox")
    .attr("stroke", "transparent")
    .attr("stroke-width", 18)
    .attr("d", edgePath);

  edge.append("path")
    .attr("class", "edge-line")
    .attr("stroke", (datum) => datum.style.color)
    .attr("stroke-width", (datum) => datum.style.width)
    .attr("stroke-dasharray", (datum) => datum.style.dash)
    .attr("stroke-opacity", 0.95)
    .attr("marker-end", (datum) => `url(#arrow-${RELATION_STYLES[datum.rel] ? datum.rel : "default"})`)
    .attr("d", edgePath);

  const edgeLabel = edge.append("g").attr("class", "edge-label");
  edgeLabel.append("rect")
    .attr("width", 100)
    .attr("height", 22)
    .attr("x", -50)
    .attr("y", -11)
    .attr("rx", 11)
    .attr("fill", "rgba(15, 23, 42, 0.92)")
    .attr("stroke", "rgba(148, 163, 184, 0.18)");

  edgeLabel.append("text")
    .attr("fill", "#cbd5e1")
    .attr("font-size", 10)
    .attr("font-weight", 700)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "central")
    .text((datum) => datum.rel.replace(/_/g, " "));

  edgeLabel.attr("transform", (datum) => {
    const [x, y] = edgeMidpoint(datum);
    return `translate(${x},${y})`;
  });

  const nodeLayer = root.append("g");
  const node = nodeLayer.selectAll("g")
    .data(nodes)
    .join("g")
    .attr("transform", (datum) => `translate(${datum.x},${datum.y})`)
    .style("cursor", "pointer")
    .on("click", (_, datum) => onSelect(datum));

  node.append("circle")
    .attr("r", 30)
    .attr("fill", "rgba(15, 23, 42, 0.95)")
    .attr("stroke", (datum) => datum.id === selectedId ? "#f8fafc" : "rgba(148, 163, 184, 0.26)")
    .attr("stroke-width", (datum) => datum.id === selectedId ? 3.5 : 1.25);

  node.append("circle")
    .attr("r", 25)
    .attr("fill", (datum) => KIND_COLORS[datum.kind] ?? "#64748b")
    .attr("fill-opacity", 0.2)
    .attr("stroke", (datum) => KIND_COLORS[datum.kind] ?? "#64748b")
    .attr("stroke-width", 2.4);

  node.append("circle")
    .attr("r", 4)
    .attr("cy", -16)
    .attr("fill", (datum) => KIND_COLORS[datum.kind] ?? "#64748b");

  node.selectAll("text.node-label")
    .data((datum) => wrapText(datum.name).map((line, index) => ({ datum, line, index })))
    .join("text")
    .attr("class", "node-label")
    .attr("fill", "#e2e8f0")
    .attr("font-size", 10.5)
    .attr("font-weight", 600)
    .attr("text-anchor", "middle")
    .attr("y", ({ index }) => index * 12 - 2)
    .text(({ line }) => line);

  node.append("text")
    .attr("fill", "#94a3b8")
    .attr("font-size", 9.5)
    .attr("font-weight", 700)
    .attr("letter-spacing", "0.08em")
    .attr("text-anchor", "middle")
    .attr("y", 21)
    .text((datum) => datum.kind.toUpperCase());

  const zoom = d3.zoom()
    .scaleExtent([0.6, 1.8])
    .on("zoom", (event) => {
      root.attr("transform", event.transform);
    });

  svg.call(zoom);
  svg.call(zoom.transform, d3.zoomIdentity.translate(36, 0));

  node.on("mouseenter", (event, datum) => {
    const inbound = links.filter((edge) => edge.target.id === datum.id).length;
    const outbound = links.filter((edge) => edge.source.id === datum.id).length;
    showTooltip(
      tooltip,
      hostRect(),
      event,
      `
        <div style="display:grid;gap:0.45rem;">
          <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center;">
            <strong style="font-size:0.95rem;line-height:1.25;">${datum.name}</strong>
            <span style="padding:0.18rem 0.45rem;border-radius:999px;background:${KIND_COLORS[datum.kind] ?? "#64748b"}22;color:${KIND_COLORS[datum.kind] ?? "#64748b"};font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">${datum.kind}</span>
          </div>
          <div style="font-size:0.78rem;color:#94a3b8;">${datum.id}</div>
          <div style="font-size:0.82rem;line-height:1.45;color:#cbd5e1;">${summarize(datum.scope_hint || datum.name)}</div>
          <div style="display:flex;gap:0.75rem;flex-wrap:wrap;font-size:0.76rem;color:#cbd5e1;">
            <span>Layer ${datum.layer + 1}</span>
            <span>${inbound} incoming</span>
            <span>${outbound} outgoing</span>
          </div>
        </div>
      `,
    );
  });

  node.on("mousemove", (event, datum) => {
    const inbound = links.filter((edge) => edge.target.id === datum.id).length;
    const outbound = links.filter((edge) => edge.source.id === datum.id).length;
    showTooltip(
      tooltip,
      hostRect(),
      event,
      `
        <div style="display:grid;gap:0.45rem;">
          <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center;">
            <strong style="font-size:0.95rem;line-height:1.25;">${datum.name}</strong>
            <span style="padding:0.18rem 0.45rem;border-radius:999px;background:${KIND_COLORS[datum.kind] ?? "#64748b"}22;color:${KIND_COLORS[datum.kind] ?? "#64748b"};font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">${datum.kind}</span>
          </div>
          <div style="font-size:0.78rem;color:#94a3b8;">${datum.id}</div>
          <div style="font-size:0.82rem;line-height:1.45;color:#cbd5e1;">${summarize(datum.scope_hint || datum.name)}</div>
          <div style="display:flex;gap:0.75rem;flex-wrap:wrap;font-size:0.76rem;color:#cbd5e1;">
            <span>Layer ${datum.layer + 1}</span>
            <span>${inbound} incoming</span>
            <span>${outbound} outgoing</span>
          </div>
        </div>
      `,
    );
  });

  node.on("mouseleave", () => hideTooltip(tooltip));

  edge.on("mouseenter", (event, datum) => {
    showTooltip(
      tooltip,
      hostRect(),
      event,
      `
        <div style="display:grid;gap:0.45rem;">
          <div style="display:flex;align-items:center;gap:0.55rem;">
            <span style="width:0.7rem;height:0.7rem;border-radius:999px;background:${datum.style.color};display:inline-block;"></span>
            <strong style="font-size:0.9rem;text-transform:capitalize;">${datum.rel.replace(/_/g, " ")}</strong>
          </div>
          <div style="font-size:0.82rem;color:#cbd5e1;line-height:1.4;">
            <strong>${datum.source.name}</strong> → <strong>${datum.target.name}</strong>
          </div>
          <div style="font-size:0.76rem;color:#94a3b8;">${datum.source.id} → ${datum.target.id}</div>
        </div>
      `,
    );
  });

  edge.on("mousemove", (event, datum) => {
    showTooltip(
      tooltip,
      hostRect(),
      event,
      `
        <div style="display:grid;gap:0.45rem;">
          <div style="display:flex;align-items:center;gap:0.55rem;">
            <span style="width:0.7rem;height:0.7rem;border-radius:999px;background:${datum.style.color};display:inline-block;"></span>
            <strong style="font-size:0.9rem;text-transform:capitalize;">${datum.rel.replace(/_/g, " ")}</strong>
          </div>
          <div style="font-size:0.82rem;color:#cbd5e1;line-height:1.4;">
            <strong>${datum.source.name}</strong> → <strong>${datum.target.name}</strong>
          </div>
          <div style="font-size:0.76rem;color:#94a3b8;">${datum.source.id} → ${datum.target.id}</div>
        </div>
      `,
    );
  });

  edge.on("mouseleave", () => hideTooltip(tooltip));

  svg.on("dblclick.zoom", null);

  return () => {
    hideTooltip(tooltip);
    tooltip?.remove();
  };
}

import * as d3 from "d3";

export function renderGraph(svgElement, graph, selectedId, onSelect) {
  if (!svgElement) {
    return () => {};
  }

  const width = svgElement.clientWidth || 900;
  const height = svgElement.clientHeight || 640;

  const svg = d3.select(svgElement);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const nodes = graph.items.map((item) => ({ ...item }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links = graph.edges
    .map((edge) => ({
      ...edge,
      source: nodeById.get(edge.from_id),
      target: nodeById.get(edge.to_id),
    }))
    .filter((edge) => edge.source && edge.target);

  const color = d3.scaleOrdinal()
    .domain(["issue", "capability", "phase", "track"])
    .range(["#5b8def", "#34c759", "#ff9f0a", "#af52de"]);

  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance(120))
    .force("charge", d3.forceManyBody().strength(-350))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide(34));

  const defs = svg.append("defs");
  defs.append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 24)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("fill", "#708090")
    .attr("d", "M0,-5L10,0L0,5");

  const link = svg.append("g")
    .attr("stroke", "#708090")
    .attr("stroke-opacity", 0.8)
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("stroke-width", 1.5)
    .attr("marker-end", "url(#arrow)");

  const label = svg.append("g")
    .selectAll("text")
    .data(links)
    .join("text")
    .attr("fill", "#94a3b8")
    .attr("font-size", 11)
    .attr("text-anchor", "middle")
    .text((edge) => edge.rel);

  const node = svg.append("g")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .style("cursor", "pointer")
    .on("click", (_, datum) => onSelect(datum));

  node.append("circle")
    .attr("r", 22)
    .attr("fill", (datum) => color(datum.kind))
    .attr("stroke", (datum) => datum.id === selectedId ? "#f8fafc" : "#0f172a")
    .attr("stroke-width", (datum) => datum.id === selectedId ? 4 : 1.5);

  node.append("text")
    .attr("fill", "#e2e8f0")
    .attr("font-size", 11)
    .attr("text-anchor", "middle")
    .attr("dy", 4)
    .text((datum) => datum.name.length > 14 ? `${datum.name.slice(0, 14)}…` : datum.name);

  const drag = d3.drag()
    .on("start", (event, datum) => {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      datum.fx = datum.x;
      datum.fy = datum.y;
    })
    .on("drag", (event, datum) => {
      datum.fx = event.x;
      datum.fy = event.y;
    })
    .on("end", (event, datum) => {
      if (!event.active) simulation.alphaTarget(0);
      datum.fx = null;
      datum.fy = null;
    });

  node.call(drag);

  simulation.on("tick", () => {
    link
      .attr("x1", (datum) => datum.source.x)
      .attr("y1", (datum) => datum.source.y)
      .attr("x2", (datum) => datum.target.x)
      .attr("y2", (datum) => datum.target.y);

    label
      .attr("x", (datum) => (datum.source.x + datum.target.x) / 2)
      .attr("y", (datum) => (datum.source.y + datum.target.y) / 2 - 6);

    node.attr("transform", (datum) => `translate(${datum.x},${datum.y})`);
  });

  return () => simulation.stop();
}

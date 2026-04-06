<script>
  import { onDestroy } from "svelte";
  import { renderGraph } from "../lib/graph.js";

  export let graph = { items: [], edges: [] };
  export let selectedId = null;
  export let onSelect = () => {};

  let svg;
  let cleanup = () => {};
  let resizeObserver;

  function redraw() {
    cleanup();
    cleanup = renderGraph(svg, graph, selectedId, onSelect);
  }

  $: if (svg) {
    redraw();
  }

  $: if (graph || selectedId) {
    if (svg) redraw();
  }

  $: if (svg && !resizeObserver) {
    resizeObserver = new ResizeObserver(() => redraw());
    resizeObserver.observe(svg);
  }

  onDestroy(() => {
    cleanup();
    resizeObserver?.disconnect();
  });

  const nodeLegend = [
    { label: "Issue", color: "#60a5fa" },
    { label: "Capability", color: "#34d399" },
    { label: "Phase", color: "#f59e0b" },
    { label: "Track", color: "#c084fc" },
  ];

  const edgeLegend = [
    { label: "depends_on", color: "#f97316", dash: "7 5" },
    { label: "implemented_by", color: "#22c55e", dash: "0" },
    { label: "is_part_of", color: "#a78bfa", dash: "3 5" },
  ];
</script>

{#if graph.items.length === 0}
  <div class="empty-state">No graph items match the current filters.</div>
{:else}
  <div class="graph-shell">
    <div class="graph-legend" aria-label="Graph legend">
      <div>
        <strong>Node kinds</strong>
        <div class="legend-list">
          {#each nodeLegend as entry}
            <span class="legend-chip">
              <span class="legend-dot" style={`background:${entry.color}`}></span>
              {entry.label}
            </span>
          {/each}
        </div>
      </div>

      <div>
        <strong>Relations</strong>
        <div class="legend-list relation-list">
          {#each edgeLegend as entry}
            <span class="legend-chip relation-chip">
              <svg viewBox="0 0 28 8" aria-hidden="true">
                <line x1="1" y1="4" x2="27" y2="4" stroke={entry.color} stroke-width="2" stroke-dasharray={entry.dash}></line>
              </svg>
              {entry.label}
            </span>
          {/each}
        </div>
      </div>

      <p>Scroll to zoom. Drag the canvas to pan. Hover nodes and edges for details.</p>
    </div>

    <svg bind:this={svg} class="graph-canvas" aria-label="Dependency graph"></svg>
  </div>
{/if}

<style>
  .graph-shell {
    position: relative;
  }

  .graph-legend {
    position: absolute;
    top: 0.85rem;
    right: 0.85rem;
    z-index: 2;
    max-width: min(320px, calc(100% - 1.5rem));
    display: grid;
    gap: 0.7rem;
    padding: 0.8rem 0.9rem;
    border-radius: 14px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    background: rgba(15, 23, 42, 0.78);
    backdrop-filter: blur(12px);
    box-shadow: 0 10px 30px rgba(15, 23, 42, 0.24);
    color: #cbd5e1;
  }

  .graph-legend strong {
    display: block;
    margin-bottom: 0.45rem;
    color: #f8fafc;
    font-size: 0.8rem;
  }

  .graph-legend p {
    margin: 0;
    color: #94a3b8;
    font-size: 0.76rem;
    line-height: 1.45;
  }

  .legend-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .legend-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.5rem;
    border-radius: 999px;
    background: rgba(30, 41, 59, 0.8);
    font-size: 0.72rem;
    color: #cbd5e1;
  }

  .legend-dot {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 999px;
    display: inline-block;
  }

  .relation-list {
    display: grid;
    gap: 0.35rem;
  }

  .relation-chip {
    justify-content: flex-start;
  }

  .relation-chip svg {
    width: 1.75rem;
    height: 0.5rem;
    overflow: visible;
  }

  @media (max-width: 960px) {
    .graph-legend {
      left: 0.85rem;
      right: 0.85rem;
      max-width: none;
    }
  }
</style>

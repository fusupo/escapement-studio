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
</script>

{#if graph.items.length === 0}
  <div class="empty-state">No graph items match the current filters.</div>
{:else}
  <div class="graph-shell">
    <svg bind:this={svg} class="graph-canvas" aria-label="Dependency graph"></svg>

    <div class="graph-legend" aria-label="Graph legend">
      <div>
        <h3>Node State</h3>
        <div class="legend-row"><span class="legend-swatch" style="background:#238636"></span><code>done</code></div>
        <div class="legend-row"><span class="legend-swatch" style="background:#d29922"></span><code>in_progress</code></div>
        <div class="legend-row"><span class="legend-swatch" style="background:#58a6ff"></span><code>planned</code></div>
        <div class="legend-row"><span class="legend-swatch" style="background:#8b949e"></span><code>deferred</code></div>
        <div class="legend-row"><span class="legend-swatch" style="background:#f85149"></span><code>cancelled</code></div>
      </div>
      <div>
        <h3>Edge Type</h3>
        <div class="legend-row">
          <svg class="legend-line" viewBox="0 0 28 4"><line x1="1" y1="2" x2="27" y2="2" stroke="#58a6ff" stroke-width="2"></line></svg>
          <code>depends_on</code>
        </div>
        <div class="legend-row">
          <svg class="legend-line" viewBox="0 0 28 4"><line x1="1" y1="2" x2="27" y2="2" stroke="#3fb950" stroke-width="2" stroke-dasharray="6,3"></line></svg>
          <code>is_part_of</code>
        </div>
        <div class="legend-row">
          <svg class="legend-line" viewBox="0 0 28 4"><line x1="1" y1="2" x2="27" y2="2" stroke="#d29922" stroke-width="2" stroke-dasharray="2,3"></line></svg>
          <code>implemented_by</code>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .graph-shell {
    position: relative;
  }

  .graph-legend {
    position: absolute;
    bottom: 16px;
    left: 16px;
    z-index: 2;
    display: grid;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 8px;
    border: 1px solid #30363d;
    background: #161b22;
    font-size: 12px;
    color: #c9d1d9;
  }

  .graph-legend h3 {
    font-size: 13px;
    margin: 0 0 8px 0;
    color: #e6edf3;
  }

  .legend-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
  }

  .legend-swatch {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-block;
  }

  .legend-line {
    width: 24px;
    height: 4px;
    flex-shrink: 0;
    overflow: visible;
  }

  .graph-legend code {
    font-family: inherit;
    font-size: 12px;
    color: #c9d1d9;
  }
</style>

<script>
  import { onDestroy } from "svelte";
  import { renderGraph } from "../lib/graph.js";

  export let graph = { items: [], edges: [] };
  export let selectedId = null;
  export let onSelect = () => {};

  let svg;
  let handle = { cleanup() {}, updateSelection() {}, resize() {} };
  let resizeObserver;
  let prevGraph = null;
  let prevFrontierSignature = "";
  let mounted = false;
  let frontierIds = [];
  let frontierSignature = "";
  let frontierLookupToken = 0;

  function fullRedraw() {
    handle.cleanup();
    handle = renderGraph(svg, graph, selectedId, onSelect, { frontierIds });
    prevGraph = graph;
    prevFrontierSignature = frontierSignature;
  }

  async function loadFrontier(currentGraph) {
    const token = ++frontierLookupToken;
    frontierIds = [];
    frontierSignature = "";
    if (!currentGraph?.items?.length) {
      return;
    }

    const params = new URLSearchParams();
    const repo = currentGraph.filters?.repo;
    if (repo) params.set("repo", repo);

    try {
      const response = await fetch(`/api/frontier${params.toString() ? `?${params.toString()}` : ""}`);
      if (!response.ok) throw new Error(`Failed to load frontier: ${response.status}`);
      const frontier = await response.json();
      if (token !== frontierLookupToken) return;
      const visibleIds = new Set(currentGraph.items.map((item) => item.id));
      frontierIds = frontier
        .map((item) => item.id)
        .filter((id) => visibleIds.has(id))
        .sort();
      frontierSignature = frontierIds.join("|");
    } catch (error) {
      if (token !== frontierLookupToken) return;
      console.warn("Failed to load frontier graph styling data", error);
      frontierIds = [];
      frontierSignature = "";
    }
  }

  $: void loadFrontier(graph);

  // Mount + graph/frontier data changes → full re-layout
  $: if (svg && graph) {
    if (!mounted || graph !== prevGraph || frontierSignature !== prevFrontierSignature) {
      mounted = true;
      fullRedraw();
    }
  }

  // Selection changes → lightweight stroke update (separate reactive statement)
  $: applySelection(selectedId);

  function applySelection(id) {
    if (!mounted) return;
    handle.updateSelection(id);
  }

  // Resize → viewBox only, no layout
  $: if (svg && !resizeObserver) {
    resizeObserver = new ResizeObserver(() => handle.resize());
    resizeObserver.observe(svg);
  }

  onDestroy(() => {
    handle.cleanup();
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
        <div class="legend-row"><span class="legend-swatch" style="background:#a371f7"></span><code>open_pr</code></div>
        <div class="legend-row"><span class="legend-swatch" style="background:#58a6ff"></span><code>planned</code></div>
        <div class="legend-row"><span class="legend-swatch frontier"></span><code>frontier</code></div>
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
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .graph-legend {
    position: absolute;
    bottom: 8px;
    right: 8px;
    z-index: 2;
    display: grid;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 3px;
    border: 1px solid var(--border, #2b3245);
    background: var(--bg-surface, #13171f);
    font-size: 10.5px;
    color: #c9d1d9;
  }

  .graph-legend h3 {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 4px 0;
    color: var(--text-secondary, #8b95a5);
  }

  .legend-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 0;
  }

  .legend-swatch {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    flex-shrink: 0;
    display: inline-block;
  }

  .legend-line {
    width: 20px;
    height: 4px;
    flex-shrink: 0;
    overflow: visible;
  }

  .graph-legend code {
    font-family: inherit;
    font-size: 10.5px;
    color: #c9d1d9;
  }
</style>

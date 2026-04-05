<script>
  import { onDestroy } from "svelte";
  import { renderGraph } from "../lib/graph.js";

  export let graph = { items: [], edges: [] };
  export let selectedId = null;
  export let onSelect = () => {};

  let svg;
  let cleanup = () => {};

  $: {
    cleanup();
    cleanup = renderGraph(svg, graph, selectedId, onSelect);
  }

  onDestroy(() => cleanup());
</script>

{#if graph.items.length === 0}
  <div class="empty-state">No graph items match the current filters.</div>
{:else}
  <svg bind:this={svg} class="graph-canvas" aria-label="Dependency graph"></svg>
{/if}

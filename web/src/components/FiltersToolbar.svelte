<script>
  export let filters = { repo: "", state: "", track: "", phase: "" };
  export let options = { repos: [], states: [], tracks: [], phases: [] };
  export let onChange = (..._args) => {};
  export let onReset = (..._args) => {};
  /**
   * #281: opens the GitHub issue import dialog; the button is hidden when not given.
   * @type {(() => void) | null}
   */
  export let onImport = null;

  function update(key, value) {
    onChange({ ...filters, [key]: value });
  }
</script>

<div class="toolbar">
  <label>
    Repo
    <select value={filters.repo} on:change={(event) => update("repo", event.currentTarget.value)}>
      <option value="">All</option>
      {#each options.repos as repo}
        <option value={repo}>{repo}</option>
      {/each}
    </select>
  </label>

  <label>
    State
    <select value={filters.state} on:change={(event) => update("state", event.currentTarget.value)}>
      <option value="">All</option>
      {#each options.states as state}
        <option value={state}>{state}</option>
      {/each}
    </select>
  </label>

  <label>
    Track
    <select value={filters.track} on:change={(event) => update("track", event.currentTarget.value)}>
      <option value="">All</option>
      {#each options.tracks as track}
        <option value={track.id}>{track.name}</option>
      {/each}
    </select>
  </label>

  <label>
    Phase
    <select value={filters.phase} on:change={(event) => update("phase", event.currentTarget.value)}>
      <option value="">All</option>
      {#each options.phases as phase}
        <option value={phase.id}>{phase.name}</option>
      {/each}
    </select>
  </label>

  <button class="secondary" on:click={onReset}>Reset</button>
  {#if onImport}<button class="secondary" on:click={() => onImport?.()} title="Add GitHub issues that are not in the graph yet">Import issues…</button>{/if}
</div>

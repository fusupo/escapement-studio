<script>
  export let tabs = [];
  export let activeTab = tabs[0]?.id ?? "";

  function handleKeydown(event, index) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }

    event.preventDefault();

    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + direction + tabs.length) % tabs.length;
    activeTab = tabs[nextIndex]?.id ?? activeTab;
  }
</script>

<nav class="workspace-tabs" aria-label="Studio workspace sections">
  <div class="workspace-tab-list" role="tablist" aria-orientation="horizontal">
    {#each tabs as tab, index}
      <button
        id={`${tab.id}-tab`}
        type="button"
        role="tab"
        class:active={activeTab === tab.id}
        aria-controls={`${tab.id}-panel`}
        aria-selected={activeTab === tab.id}
        tabindex={activeTab === tab.id ? 0 : -1}
        on:click={() => (activeTab = tab.id)}
        on:keydown={(event) => handleKeydown(event, index)}
      >
        <span>{tab.label}</span>
        {#if tab.description}
          <small>{tab.description}</small>
        {/if}
      </button>
    {/each}
  </div>
</nav>

<style>
  .workspace-tabs {
    width: min(1500px, 100%);
    margin: 0 auto;
  }

  .workspace-tab-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }

  button[role="tab"] {
    display: grid;
    gap: 0.2rem;
    justify-items: start;
    text-align: left;
    padding: 0.95rem 1rem;
    background: rgba(15, 23, 42, 0.72);
    border: 1px solid rgba(148, 163, 184, 0.16);
    color: #cbd5e1;
  }

  button[role="tab"] small {
    color: #94a3b8;
  }

  button[role="tab"].active {
    background: linear-gradient(180deg, rgba(37, 99, 235, 0.22), rgba(15, 23, 42, 0.92));
    border-color: rgba(96, 165, 250, 0.5);
    color: #eff6ff;
  }

  button[role="tab"].active small {
    color: #bfdbfe;
  }

  @media (max-width: 720px) {
    .workspace-tab-list {
      grid-template-columns: 1fr;
    }
  }
</style>

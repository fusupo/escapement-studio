<script>

/** @type {{ workspace: ReturnType<typeof import("../lib/planning/workspace.svelte.js").createWorkspace> }} */
let { workspace } = $props();
</script>
<aside class="activity-bar">
    <div class="activity-icons">
      {#each workspace.activityItems as item}
        <button
          class="activity-icon"
          class:active={workspace.activeTab === item.id}
          onclick={() => workspace.assign({ activeTab: item.id })}
          title={item.label}
          aria-label={item.label}
        >
          {#if item.icon === "plan"}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <line x1="12" y1="3" x2="12" y2="6"/>
              <line x1="12" y1="18" x2="12" y2="21"/>
              <line x1="3" y1="12" x2="6" y2="12"/>
              <line x1="18" y1="12" x2="21" y2="12"/>
              <line x1="5.6" y1="5.6" x2="7.8" y2="7.8"/>
              <line x1="16.2" y1="16.2" x2="18.4" y2="18.4"/>
              <line x1="5.6" y1="18.4" x2="7.8" y2="16.2"/>
              <line x1="16.2" y1="7.8" x2="18.4" y2="5.6"/>
            </svg>
          {:else if item.icon === "execute"}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5,3 19,12 5,21" fill="currentColor" stroke="none" opacity="0.85"/>
            </svg>
          {:else if item.icon === "reconcile"}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/>
            </svg>
          {:else if item.icon === "settings"}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          {/if}
        </button>
      {/each}
    </div>
    <div class="activity-bottom">
      <button
        class="activity-icon"
        onclick={workspace.refresh}
        disabled={workspace.loading}
        title="Refresh"
        aria-label="Refresh"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23,4 23,10 17,10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
      </button>
    </div>
  </aside>
<style>
  .activity-bar {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    background: #181d28;
    border-right: 1px solid #2b3245;
    padding: 4px 0;
    z-index: 10;
  }

  .activity-icons,
  .activity-bottom {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .activity-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    background: transparent;
    color: #6b7a94;
    border-radius: 0;
    transition: color 100ms, background 100ms;
    position: relative;
  }

  .activity-icon:hover {
    color: #c5cdd8;
    background: rgba(255,255,255,0.04);
  }

  .activity-icon.active {
    color: #e2e8f0;
  }

  .activity-icon.active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 2px;
    background: #e2e8f0;
    border-radius: 0 1px 1px 0;
  }
</style>

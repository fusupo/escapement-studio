<script>
  import { createEventDispatcher } from "svelte";

  export let menu = null;
  export let x = 0;
  export let y = 0;

  const dispatch = createEventDispatcher();

  function handleButtonAction(action) {
    if (action.disabled) return;
    dispatch("action", { id: action.id });
  }

  function handleLinkClick() {
    dispatch("requestclose");
  }

  function handleKeydown(event) {
    if (event.key === "Escape") {
      dispatch("requestclose");
    }
  }
</script>

{#if menu}
  <div
    class="graph-context-menu"
    style={`left:${x}px; top:${y}px;`}
    role="menu"
    tabindex="-1"
    aria-label={`Actions for ${menu.title}`}
    on:click|stopPropagation
    on:contextmenu|preventDefault|stopPropagation
    on:keydown|stopPropagation={handleKeydown}
  >
    <div class="graph-context-menu-header">
      <div>
        <div class="graph-context-menu-title">{menu.title}</div>
        <div class="graph-context-menu-name">{menu.subtitle}</div>
      </div>
      {#if menu.status}
        <span class="graph-context-menu-status {menu.status.tone}">{menu.status.label}</span>
      {/if}
    </div>

    {#each menu.sections as section}
      <section class="graph-context-menu-section" aria-label={section.label}>
        <div class="graph-context-menu-section-label">{section.label}</div>
        <div class="graph-context-menu-actions">
          {#each section.actions as action}
            <div class="graph-context-menu-action-row">
              {#if action.kind === "link"}
                <a
                  class="graph-context-menu-action"
                  href={action.href}
                  target={action.external ? "_blank" : undefined}
                  rel={action.external ? "noreferrer" : undefined}
                  role="menuitem"
                  on:click={handleLinkClick}
                >
                  {action.label}
                </a>
              {:else}
                <button
                  class="graph-context-menu-action"
                  class:primary={action.emphasis === "primary"}
                  on:click={() => handleButtonAction(action)}
                  disabled={action.disabled}
                  role="menuitem"
                >
                  {action.label}
                </button>
              {/if}
              {#if action.description}
                <div class="graph-context-menu-description">{action.description}</div>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/each}
  </div>
{/if}

<style>
  .graph-context-menu {
    position: fixed;
    z-index: 40;
    min-width: 240px;
    max-width: 300px;
    display: grid;
    gap: 10px;
    padding: 10px;
    border-radius: 8px;
    border: 1px solid #2b3245;
    background: #13171f;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
  }

  .graph-context-menu-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .graph-context-menu-title {
    font-size: 11px;
    font-weight: 700;
    color: #e2e8f0;
  }

  .graph-context-menu-name {
    margin-top: 2px;
    font-size: 11px;
    color: #8b95a5;
    overflow-wrap: anywhere;
  }

  .graph-context-menu-status {
    flex-shrink: 0;
    padding: 2px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid transparent;
  }

  .graph-context-menu-status.ready {
    color: #3fb950;
    background: rgba(63, 185, 80, 0.12);
    border-color: rgba(63, 185, 80, 0.24);
  }

  .graph-context-menu-status.blocked {
    color: #d29922;
    background: rgba(210, 153, 34, 0.12);
    border-color: rgba(210, 153, 34, 0.24);
  }

  .graph-context-menu-status.loading {
    color: #58a6ff;
    background: rgba(88, 166, 255, 0.12);
    border-color: rgba(88, 166, 255, 0.24);
  }

  .graph-context-menu-section {
    display: grid;
    gap: 6px;
  }

  .graph-context-menu-section-label {
    font-size: 10px;
    font-weight: 700;
    color: #8b95a5;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .graph-context-menu-actions {
    display: grid;
    gap: 6px;
  }

  .graph-context-menu-action-row {
    display: grid;
    gap: 4px;
  }

  .graph-context-menu-action {
    width: 100%;
    justify-content: flex-start;
    text-align: left;
  }

  .graph-context-menu-action.primary {
    background: rgba(37, 99, 235, 0.18);
    border-color: rgba(37, 99, 235, 0.32);
    color: #dbeafe;
  }

  .graph-context-menu-action.primary:hover:enabled {
    background: rgba(37, 99, 235, 0.26);
    border-color: rgba(37, 99, 235, 0.4);
  }

  .graph-context-menu-description {
    font-size: 11px;
    color: #8b95a5;
    line-height: 1.4;
  }
</style>

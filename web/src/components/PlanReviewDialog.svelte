<script>
  import { modalFocus } from "../lib/modal-focus.js";

/** @type {ReturnType<typeof import("../lib/planning/workspace.svelte.js").createWorkspace>} */
export let workspace;
</script>
{#if workspace.planReview}
      <div
        class="plan-review-overlay"
        role="presentation"
        on:click={workspace.closePlanReview}
      >
        <div
          class="plan-review-card"
          role="dialog" tabindex="-1" use:modalFocus
          aria-modal="true"
          aria-labelledby="plan-review-title"
          on:click|stopPropagation
          on:keydown={workspace.handleGlobalKeydown}
        >
          <header class="plan-review-header">
            <h3 id="plan-review-title">
              Plan — {workspace.planReview.workItemId}
              {#if workspace.planReview.planState}
                <span class="status-pill {workspace.planReview.planState === 'ready' ? 'healthy' : 'warn'}">{workspace.planReview.planState}</span>
              {/if}
            </h3>
            <button class="small" on:click={workspace.closePlanReview} aria-label="Close plan review">×</button>
          </header>
          <pre class="plan-review-body">{workspace.planReview.scratchpadContent}</pre>
        </div>
      </div>
    {/if}

<style>
</style>

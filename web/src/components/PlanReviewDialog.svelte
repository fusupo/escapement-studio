<script>
  import { modalFocus } from "../lib/modal-focus.js";

/** @type {{ workspace: ReturnType<typeof import("../lib/planning/workspace.svelte.js").createWorkspace> }} */
let { workspace } = $props();
</script>
{#if workspace.planReview}
      <div
        class="plan-review-overlay"
        role="presentation"
        onclick={workspace.closePlanReview}
      >
        <div
          class="plan-review-card"
          role="dialog" tabindex="-1" use:modalFocus
          aria-modal="true"
          aria-labelledby="plan-review-title"
          onclick={(event) => event.stopPropagation()}
          onkeydown={workspace.handleGlobalKeydown}
        >
          <header class="plan-review-header">
            <h3 id="plan-review-title">
              Plan — {workspace.planReview.workItemId}
              {#if workspace.planReview.planState}
                <span class="status-pill {workspace.planReview.planState === 'ready' ? 'healthy' : 'warn'}">{workspace.planReview.planState}</span>
              {/if}
            </h3>
            <button class="small" onclick={workspace.closePlanReview} aria-label="Close plan review">×</button>
          </header>
          <pre class="plan-review-body">{workspace.planReview.scratchpadContent}</pre>
        </div>
      </div>
    {/if}

<style>
</style>

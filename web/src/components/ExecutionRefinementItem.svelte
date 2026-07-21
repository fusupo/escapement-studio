<script>
  import { createEventDispatcher } from "svelte";
  import {
    selectRefinementOption,
    selectRefinementOther,
    updateLegacyRefinement,
    updateRefinementOther,
  } from "../lib/execution-refinement.js";

  export let runId;
  export let item;
  export let index;
  export let draft;
  export let disabled = false;

  const dispatch = createEventDispatcher();
  $: controlBase = `refinement-${runId}-${item.id}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  $: radioName = `${controlBase}-choice`;

  function emitDraft(nextDraft) {
    dispatch("draft", nextDraft);
  }
</script>

<fieldset class="refinement-item" class:blocker={item.kind === "blocker"}>
  <legend>
    <span class="refinement-item-number">{index + 1}</span>
    <span class="refinement-item-kind" class:blocker={item.kind === "blocker"}>{item.kind}</span>
    <span class="refinement-item-prompt">{item.prompt}</span>
  </legend>

  {#if item.options?.length}
    <div class="refinement-options">
      {#each item.options as option}
        {@const optionId = `${controlBase}-option-${option.id}`}
        <div class="refinement-option">
          <input
            id={optionId}
            type="radio"
            name={radioName}
            value={option.id}
            checked={draft.mode === "option" && draft.selected_option_id === option.id}
            on:change={() => emitDraft(selectRefinementOption(item, draft, option.id))}
            {disabled}
          />
          <label for={optionId}>
            <span class="option-label">
              {option.label}
              {#if item.recommended_option_id === option.id}
                <span class="recommended-badge">Recommended</span>
              {/if}
            </span>
            {#if option.description}<span class="option-description">{option.description}</span>{/if}
          </label>
        </div>
      {/each}

      {#if item.allow_other}
        {@const otherId = `${controlBase}-other`}
        {@const otherTextId = `${controlBase}-other-text`}
        <div class="refinement-option other-option">
          <input
            id={otherId}
            type="radio"
            name={radioName}
            value="other"
            checked={draft.mode === "other"}
            on:change={() => emitDraft(selectRefinementOther(item, draft))}
            {disabled}
          />
          <label for={otherId}><span class="option-label">Other</span></label>
          {#if draft.mode === "other"}
            <label class="other-response" for={otherTextId}>
              <span>Custom response</span>
              <textarea
                id={otherTextId}
                value={draft.text}
                on:input={(event) => emitDraft(updateRefinementOther(item, draft, event.currentTarget.value))}
                rows="3"
                {disabled}
              ></textarea>
            </label>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    {@const legacyId = `${controlBase}-response`}
    <label class="legacy-response" for={legacyId}>
      <span>{item.kind === "blocker" ? "Resolution or explicit acceptance" : "Answer"}</span>
      <textarea
        id={legacyId}
        placeholder={item.kind === "blocker" ? "Describe how to resolve or explicitly accept this blocker..." : "Answer this question..."}
        value={draft.text}
        on:input={(event) => emitDraft(updateLegacyRefinement(item, event.currentTarget.value))}
        rows="3"
        {disabled}
      ></textarea>
    </label>
  {/if}
</fieldset>

<style>
  .refinement-item {
    min-width: 0;
    margin: 0;
    padding: 10px;
    border: 1px solid var(--border, #2b3245);
    border-radius: var(--radius-sm, 3px);
    background: var(--bg-surface, #13171f);
  }

  .refinement-item legend {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr);
    align-items: start;
    gap: 6px 8px;
    width: 100%;
    padding: 0 3px;
  }

  .refinement-item-number {
    color: var(--text-muted, #566070);
    font-size: 10px;
    line-height: 17px;
  }

  .refinement-item-kind {
    padding: 1px 5px;
    border-radius: 2px;
    color: #c4b5fd;
    background: rgba(163, 113, 247, 0.18);
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .refinement-item-kind.blocker {
    color: #fca5a5;
    background: rgba(248, 81, 73, 0.16);
  }

  .refinement-item-prompt {
    min-width: 0;
    font-size: 12px;
    line-height: 1.4;
  }

  .refinement-options,
  .legacy-response {
    display: grid;
    gap: 7px;
    margin-top: 10px;
  }

  .refinement-option {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 7px;
  }

  .refinement-option > input {
    margin-top: 2px;
  }

  .refinement-option > label {
    display: grid;
    gap: 2px;
    cursor: pointer;
  }

  .option-label {
    font-size: 12px;
    font-weight: 600;
  }

  .option-description {
    color: var(--text-muted, #8b949e);
    font-size: 11px;
    line-height: 1.35;
  }

  .recommended-badge {
    display: inline-block;
    margin-left: 5px;
    padding: 1px 5px;
    border-radius: 999px;
    color: #86efac;
    background: rgba(63, 185, 80, 0.14);
    font-size: 9px;
    font-weight: 700;
    vertical-align: 1px;
  }

  .other-option {
    margin-top: 2px;
  }

  .other-response {
    grid-column: 1 / -1;
    display: grid;
    gap: 5px;
    margin: 3px 0 0 23px;
    font-size: 11px;
  }

  textarea {
    width: 100%;
    min-height: 72px;
  }
</style>

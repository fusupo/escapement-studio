<script>
  import { edgeEvidence, groupMutations, isImportProposal, mutationErrors } from "../lib/planning/proposal-selection.js";

  /**
   * Review of one graph mutation proposal: the proposed nodes and edges
   * as a diff, grouped per issue, with where each edge comes from
   * (#281). Extracted from PlannerChatAdapter; planner proposals and
   * issue imports both render here.
   * @type {{
   *   proposal: any,
   *   selectedIds: string[],
   *   commitResult?: any,
   *   approving?: boolean,
   *   busy?: boolean,
   *   onToggle: (id: string, checked: boolean) => void,
   *   onApprove: () => void,
   *   onReject: () => void,
   *   onRevise: () => void,
   * }}
   */
  let { proposal, selectedIds, commitResult = null, approving = false, busy = false, onToggle, onApprove, onReject, onRevise } = $props();

  const groups = $derived(groupMutations(proposal));
  const imported = $derived(isImportProposal(proposal));
  const failure = $derived(
    commitResult && commitResult.proposal_id === proposal.proposal_id && commitResult.result?.status !== "applied"
      ? commitResult.result
      : null,
  );

  const REL_LABELS = { depends_on: "depends on", is_part_of: "is part of", implemented_by: "implemented by" };
  /** @param {string} rel */
  const relLabel = (rel) => REL_LABELS[/** @type {keyof typeof REL_LABELS} */ (rel)] ?? rel;
  /** @param {any} reference */
  const unresolvedLabel = (reference) => reference.direction === "incoming"
    ? `${reference.target} ${relLabel(reference.rel)} this`
    : `${relLabel(reference.rel)} ${reference.target}`;
</script>

<div class="approval-section">
  <div class="approval-header">
    <h3>{imported ? "Import GitHub issues" : "Graph mutation proposal"}</h3>
    {#if proposal.context?.based_on_graph_version}<span class="status-pill healthy">graph v{proposal.context.based_on_graph_version}</span>{/if}
  </div>
  <div class="proposal-summary">
    <strong>{proposal.proposal_id}</strong>
    <p>{proposal.summary ?? '(no summary)'}</p>
  </div>

  {#if failure}
    <div class="banner error inline-banner" role="alert">
      {#if failure.status === "stale"}
        The graph changed since this proposal was made (now v{failure.current_graph_version}). Dismiss it and start again.
      {:else}
        Nothing was applied: {(failure.errors ?? []).map((/** @type {any} */ item) => item.message).join("; ")}
      {/if}
    </div>
  {/if}

  {#if proposal.mutations?.length}
    <div class="proposal-list review-list">
      {#each groups as group (group.key)}
        <div class="review-group">
          {#each group.mutations as mutation (mutation.id)}
            {@const evidence = edgeEvidence(mutation)}
            {@const errors = mutationErrors(mutation)}
            {@const payload = mutation.payload ?? {}}
            <div class="proposal-card" class:is-edge={mutation.type === "create_edge" || mutation.type === "delete_edge"} class:has-error={errors.length > 0}>
              <label class="proposal-card-header">
                <input type="checkbox" checked={selectedIds.includes(mutation.id)} onchange={(event) => onToggle(mutation.id, event.currentTarget.checked)} />
                <div>
                  <strong>{mutation.id}</strong>
                  <span class="proposal-type">{mutation.type}</span>
                  {#if mutation.type === "create_edge" && payload.from_id && payload.to_id}
                    <span class="edge-line"><code>{payload.from_id}</code> {relLabel(payload.rel)} <code>{payload.to_id}</code></span>
                  {:else if mutation.entity_id}
                    <code>{mutation.entity_id}</code>
                  {/if}
                  {#if evidence}<span class="status-pill {evidence.kind === 'deterministic' ? 'info' : 'warn'}">{evidence.label}</span>{/if}
                  {#if mutation.type === "create_edge" && payload.confidence}<span class="status-pill">{payload.confidence}</span>{/if}
                </div>
              </label>

              {#if mutation.type === "create_work_item" && payload.name}
                <div class="node-line">
                  <span class="node-title">{payload.name}</span>
                  {#if payload.state}<span class="status-pill">{payload.state}</span>{/if}
                  {#if payload.issue_url}<a href={payload.issue_url} target="_blank" rel="noreferrer">{payload.repo ? `${payload.repo}#${payload.issue_number}` : `#${payload.issue_number}`}</a>{/if}
                </div>
                {#if payload.scope_hint}<p class="scope-hint">{payload.scope_hint}</p>{/if}
              {/if}

              {#if evidence?.quotes.length}
                {#each evidence.quotes as quote}
                  <blockquote class="evidence-quote"><span>{quote.issue}</span> {quote.quote}</blockquote>
                {/each}
              {:else}
                <p>{mutation.rationale}</p>
              {/if}

              {#each errors as error}
                <p class="mutation-error" role="alert">Cannot be applied: {error.message}</p>
              {/each}

              {#each mutation.validation?.unresolved_references ?? [] as reference}
                <p class="unresolved">Not linked: {unresolvedLabel(reference)} — no work item for it. <span>“{reference.quote}”</span></p>
              {/each}

              {#if mutation.payload}
                <details>
                  <summary>Payload</summary>
                  <pre>{JSON.stringify(mutation.payload, null, 2)}</pre>
                </details>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {:else}
    <div class="banner error inline-banner">Proposal has no mutations. Dismiss or reject to recover.</div>
  {/if}

  <div class="approval-actions">
    <button onclick={onApprove} disabled={approving || selectedIds.length === 0}>{approving ? 'Applying...' : `Approve ${selectedIds.length} selected`}</button>
    {#if imported}
      <button class="secondary" onclick={onReject} disabled={busy}>Discard import</button>
    {:else}
      <button class="secondary" onclick={onReject} disabled={busy}>Reject</button>
      <button class="secondary" onclick={onRevise} disabled={busy}>Revise</button>
    {/if}
  </div>
</div>

<style>
  .approval-section {
    display: grid;
    gap: 0.65rem;
  }

  .approval-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
  }

  .approval-header h3 {
    margin: 0;
    font-size: 1rem;
  }

  .approval-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    padding-top: 0.35rem;
    border-top: 1px solid rgba(148, 163, 184, 0.12);
  }

  .review-list {
    max-height: min(52vh, 520px);
    gap: 8px;
  }

  .review-group {
    display: grid;
    gap: 3px;
  }

  .proposal-card.is-edge {
    margin-left: 18px;
    border-color: var(--border);
  }

  .proposal-card.has-error {
    border-color: rgba(248, 81, 73, 0.45);
  }

  .proposal-card-header {
    cursor: pointer;
  }

  .proposal-card-header > div {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
  }

  .node-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .node-title {
    color: var(--text-primary);
    font-weight: 600;
  }

  .scope-hint {
    font-style: italic;
  }

  .evidence-quote {
    margin: 0;
    padding: 2px 8px;
    border-left: 2px solid rgba(88, 166, 255, 0.45);
    color: var(--text-secondary);
  }

  .evidence-quote span {
    color: var(--text-muted);
    font-size: 10.5px;
  }

  .proposal-card p.mutation-error {
    color: #fca5a5;
  }

  .proposal-card p.unresolved {
    color: var(--text-muted);
  }

  .proposal-card details summary {
    color: var(--text-muted);
    font-size: 10.5px;
    cursor: pointer;
  }
</style>

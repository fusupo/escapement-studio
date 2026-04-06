<script>
  const defaultWorkItem = {
    id: "",
    name: "",
    kind: "issue",
    state: "planned",
    repo: "",
    issue_number: "",
    issue_url: "",
    scope_hint: "",
  };

  const defaultEdge = {
    from_id: "",
    rel: "depends_on",
    to_id: "",
  };

  export let selectedItem = null;
  export let issueDetails = null;
  export let graph = { items: [], edges: [] };
  export let saving = false;
  export let edgeSaving = false;
  export let onSaveItem = () => {};
  export let onCreateItem = () => {};
  export let onCreateEdge = () => {};
  export let onDeleteEdge = () => {};
  export let onCloseIssue = () => {};
  export let closingIssue = false;

  let editForm = { ...defaultWorkItem };
  let createForm = { ...defaultWorkItem };
  let edgeForm = { ...defaultEdge };

  $: if (selectedItem) {
    editForm = {
      id: selectedItem.id,
      name: selectedItem.name ?? "",
      kind: selectedItem.kind ?? "issue",
      state: selectedItem.state ?? "planned",
      repo: selectedItem.repo ?? "",
      issue_number: selectedItem.issue_number ?? "",
      issue_url: selectedItem.issue_url ?? "",
      scope_hint: selectedItem.scope_hint ?? "",
    };

    if (!edgeForm.from_id) {
      edgeForm = { ...edgeForm, from_id: selectedItem.id };
    }
  }

  $: if (!selectedItem && edgeForm.from_id && !graph.items.some((item) => item.id === edgeForm.from_id)) {
    edgeForm = { ...defaultEdge };
  }

  $: connectedEdges = selectedItem
    ? graph.edges.filter((edge) => edge.from_id === selectedItem.id || edge.to_id === selectedItem.id)
    : [];

  function submitEdit() {
    onSaveItem({
      name: editForm.name,
      kind: editForm.kind,
      state: editForm.state,
      repo: editForm.repo || null,
      issue_number: editForm.issue_number ? Number(editForm.issue_number) : null,
      issue_url: editForm.issue_url || null,
      scope_hint: editForm.scope_hint || null,
    });
  }

  function submitCreate() {
    onCreateItem({
      id: createForm.id,
      name: createForm.name,
      kind: createForm.kind,
      state: createForm.state,
      repo: createForm.repo || null,
      issue_number: createForm.issue_number ? Number(createForm.issue_number) : null,
      issue_url: createForm.issue_url || null,
      scope_hint: createForm.scope_hint || null,
    });
    createForm = { ...defaultWorkItem, kind: createForm.kind, state: createForm.state };
  }

  function submitEdge() {
    onCreateEdge({ ...edgeForm });
  }
</script>

<aside class="sidebar">
  <section>
    <h2>Selected node</h2>
    {#if selectedItem}
      {#if selectedItem.issue_number && selectedItem.repo}
        <div class="issue-details-card">
          <div class="issue-details-header">
            <h3>GitHub issue</h3>
            {#if (issueDetails?.url || selectedItem.issue_url)}
              <a href={issueDetails?.url || selectedItem.issue_url} target="_blank" rel="noreferrer">Open</a>
            {/if}
          </div>

          {#if issueDetails?.error}
            <p class="muted">Failed to load issue details: {issueDetails.error}</p>
          {:else if issueDetails}
            <strong>#{issueDetails.number} {issueDetails.title}</strong>
            <p class="muted">{issueDetails.state}</p>
            {#if issueDetails.labels?.length}
              <div class="tag-list">
                {#each issueDetails.labels as label}
                  <span class="status-pill">{label.name}</span>
                {/each}
              </div>
            {/if}
            {#if issueDetails.assignees?.length}
              <p class="muted">Assignees: {issueDetails.assignees.map((assignee) => assignee.login).join(', ')}</p>
            {/if}
            {#if issueDetails.managed_block}
              <details class="issue-body-preview">
                <summary>Managed Studio block</summary>
                <pre>{issueDetails.managed_block.content}</pre>
              </details>
            {/if}
            {#if issueDetails.state !== 'closed'}
              <button class="danger small" on:click={() => onCloseIssue(selectedItem)} disabled={closingIssue}>
                {closingIssue ? 'Closing…' : 'Close issue'}
              </button>
            {/if}
          {:else}
            <p class="muted">Loading issue details…</p>
          {/if}
        </div>
      {/if}

      <div class="stack">
        <label>
          ID
          <input bind:value={editForm.id} disabled />
        </label>
        <label>
          Name
          <input bind:value={editForm.name} />
        </label>
        <label>
          Kind
          <select bind:value={editForm.kind}>
            <option value="issue">issue</option>
            <option value="capability">capability</option>
            <option value="phase">phase</option>
            <option value="track">track</option>
          </select>
        </label>
        <label>
          State
          <select bind:value={editForm.state}>
            <option value="planned">planned</option>
            <option value="in_progress">in_progress</option>
            <option value="done">done</option>
            <option value="deferred">deferred</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
        <label>
          Repo
          <input bind:value={editForm.repo} placeholder="fusupo/escapement-studio" />
        </label>
        <label>
          Issue number
          <input bind:value={editForm.issue_number} inputmode="numeric" />
        </label>
        <label>
          Issue URL
          <input bind:value={editForm.issue_url} placeholder="https://github.com/..." />
        </label>
        <label>
          Scope hint
          <textarea bind:value={editForm.scope_hint} rows="3"></textarea>
        </label>
        <button on:click={submitEdit} disabled={saving}>{saving ? "Saving..." : "Save changes"}</button>
      </div>
    {:else}
      <p class="muted">Select a node in the graph to inspect and edit it.</p>
    {/if}
  </section>

  <section>
    <h2>Create work item</h2>
    <div class="stack">
      <label>
        ID
        <input bind:value={createForm.id} placeholder="studio-2" />
      </label>
      <label>
        Name
        <input bind:value={createForm.name} placeholder="Graph frontend" />
      </label>
      <label>
        Kind
        <select bind:value={createForm.kind}>
          <option value="issue">issue</option>
          <option value="capability">capability</option>
          <option value="phase">phase</option>
          <option value="track">track</option>
        </select>
      </label>
      <label>
        State
        <select bind:value={createForm.state}>
          <option value="planned">planned</option>
          <option value="in_progress">in_progress</option>
          <option value="done">done</option>
          <option value="deferred">deferred</option>
          <option value="cancelled">cancelled</option>
        </select>
      </label>
      <label>
        Repo
        <input bind:value={createForm.repo} placeholder="fusupo/escapement-studio" />
      </label>
      <label>
        Scope hint
        <textarea bind:value={createForm.scope_hint} rows="3"></textarea>
      </label>
      <button on:click={submitCreate} disabled={saving}>{saving ? "Saving..." : "Create work item"}</button>
    </div>
  </section>

  <section>
    <h2>Edges</h2>
    <div class="stack">
      <label>
        From
        <select bind:value={edgeForm.from_id}>
          <option value="">Select source</option>
          {#each graph.items as item}
            <option value={item.id}>{item.name} ({item.id})</option>
          {/each}
        </select>
      </label>
      <label>
        Relation
        <select bind:value={edgeForm.rel}>
          <option value="depends_on">depends_on</option>
          <option value="is_part_of">is_part_of</option>
          <option value="implemented_by">implemented_by</option>
        </select>
      </label>
      <label>
        To
        <select bind:value={edgeForm.to_id}>
          <option value="">Select target</option>
          {#each graph.items as item}
            <option value={item.id}>{item.name} ({item.id})</option>
          {/each}
        </select>
      </label>
      <button on:click={submitEdge} disabled={edgeSaving}>{edgeSaving ? "Creating..." : "Create edge"}</button>
    </div>

    {#if connectedEdges.length > 0}
      <ul class="edge-list">
        {#each connectedEdges as edge}
          <li>
            <code>{edge.from_id}</code>
            <span>{edge.rel}</span>
            <code>{edge.to_id}</code>
            <button class="danger small" on:click={() => onDeleteEdge(edge.id)} disabled={edgeSaving}>Delete</button>
          </li>
        {/each}
      </ul>
    {:else if selectedItem}
      <p class="muted">No edges connected to the selected node.</p>
    {/if}
  </section>
</aside>

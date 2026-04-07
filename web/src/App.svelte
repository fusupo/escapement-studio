<script>
  import PlannerChatAdapter from "./components/PlannerChatAdapter.svelte";
  import ExecutionDispatchPanel from "./components/ExecutionDispatchPanel.svelte";
  import ReconciliationPanel from "./components/ReconciliationPanel.svelte";
  import GraphView from "./components/GraphView.svelte";
  import FiltersToolbar from "./components/FiltersToolbar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import {
    closeGitHubIssue,
    createEdge,
    createWorkItem,
    deleteEdge,
    getGitHubIssueDetails,
    getGraph,
    getHealth,
    listWorkItems,
    updateWorkItem,
  } from "./lib/api.js";

  const emptyGraph = { filters: {}, items: [], edges: [] };
  let graph = emptyGraph;
  let catalog = [];
  let filters = { repo: "", state: "", track: "", phase: "" };
  let selectedId = null;
  let loading = true;
  let saving = false;
  let edgeSaving = false;
  let error = "";
  let health = null;
  let selectedIssueDetails = null;
  let activeTab = "planning";
  let closingIssue = false;

  const workspaceTabs = [
    { id: "planning", label: "Planning" },
    { id: "execute", label: "Execute" },
    { id: "reconciliation", label: "Reconciliation" },
  ];

  $: selectedItem = graph.items.find((item) => item.id === selectedId) ?? null;
  $: filterOptions = {
    repos: [...new Set(catalog.map((item) => item.repo).filter(Boolean))].sort(),
    states: [...new Set(catalog.map((item) => item.state).filter(Boolean))].sort(),
    tracks: catalog.filter((item) => item.kind === "track"),
    phases: catalog.filter((item) => item.kind === "phase"),
  };

  async function loadGraph() {
    loading = true;
    error = "";
    try {
      const [graphResponse, healthResponse, catalogResponse] = await Promise.all([
        getGraph(filters),
        getHealth(),
        listWorkItems(),
      ]);
      graph = graphResponse;
      health = healthResponse;
      catalog = catalogResponse;
      if (selectedId && !graph.items.some((item) => item.id === selectedId)) {
        selectedId = null;
      }
    } catch (loadError) {
      error = loadError.message;
    } finally {
      loading = false;
    }
  }

  async function refresh() {
    await loadGraph();
  }

  let issueLookupToken = 0;
  $: void loadSelectedIssueDetails(selectedItem);

  async function loadSelectedIssueDetails(item) {
    const token = ++issueLookupToken;
    if (!item?.repo || !item?.issue_number) {
      selectedIssueDetails = null;
      return;
    }
    try {
      const details = await getGitHubIssueDetails({ repo: item.repo, issue_number: item.issue_number });
      if (token === issueLookupToken) selectedIssueDetails = details;
    } catch (lookupError) {
      if (token === issueLookupToken) {
        selectedIssueDetails = { error: lookupError.message, repo: item.repo, number: item.issue_number, url: item.issue_url };
      }
    }
  }

  async function handleSaveItem(payload) {
    if (!selectedItem) return;
    saving = true;
    error = "";
    try {
      await updateWorkItem(selectedItem.id, payload);
      await loadGraph();
    } catch (saveError) {
      error = saveError.message;
    } finally {
      saving = false;
    }
  }

  async function handleCreateItem(payload) {
    saving = true;
    error = "";
    try {
      const created = await createWorkItem(payload);
      selectedId = created.id;
      await loadGraph();
    } catch (saveError) {
      error = saveError.message;
    } finally {
      saving = false;
    }
  }

  async function handleCreateEdge(payload) {
    edgeSaving = true;
    error = "";
    try {
      await createEdge(payload);
      await loadGraph();
    } catch (edgeError) {
      error = edgeError.message;
    } finally {
      edgeSaving = false;
    }
  }

  async function handleDeleteEdge(id) {
    edgeSaving = true;
    error = "";
    try {
      await deleteEdge(id);
      await loadGraph();
    } catch (edgeError) {
      error = edgeError.message;
    } finally {
      edgeSaving = false;
    }
  }

  async function handleCloseIssue(item) {
    if (!item?.repo || !item?.issue_number) return;
    closingIssue = true;
    error = "";
    try {
      await closeGitHubIssue({ repo: item.repo, issue_number: item.issue_number });
      await updateWorkItem(item.id, { state: "done" });
      await loadGraph();
    } catch (closeError) {
      error = closeError.message;
    } finally {
      closingIssue = false;
    }
  }

  function handleFilterChange(nextFilters) {
    filters = nextFilters;
    loadGraph();
  }

  function resetFilters() {
    filters = { repo: "", state: "", track: "", phase: "" };
    loadGraph();
  }

  loadGraph();
</script>

<svelte:head>
  <title>Escapement Studio</title>
</svelte:head>

<div class="app-viewport">
  <!-- Top bar -->
  <header class="app-topbar">
    <div class="topbar-left">
      <span class="app-brand">Escapement Studio</span>
      <nav class="tab-strip">
        {#each workspaceTabs as tab}
          <button
            class="tab-btn"
            class:active={activeTab === tab.id}
            on:click={() => (activeTab = tab.id)}
          >{tab.label}</button>
        {/each}
      </nav>
    </div>
    <div class="topbar-right">
      <span class:healthy={health?.ok} class="status-pill">
        {health?.ok ? "API healthy" : "API unavailable"}
      </span>
      <button class="secondary small" on:click={refresh} disabled={loading}>Refresh</button>
    </div>
  </header>

  <!-- Planning tab -->
  {#if activeTab === "planning"}
    <div class="planning-viewport">
      <!-- Filter bar -->
      <div class="filter-bar">
        <FiltersToolbar {filters} options={filterOptions} onChange={handleFilterChange} onReset={resetFilters} />
      </div>

      <!-- 3-column layout -->
      <div class="planning-columns">
        <!-- Left: Chat -->
        <div class="col-chat">
          <PlannerChatAdapter on:graphChanged={refresh} />
        </div>

        <!-- Center: Graph -->
        <div class="col-graph">
          {#if error}
            <div class="banner error">{error}</div>
          {/if}

          <div class="graph-header">
            <span class="muted">{graph.items.length} items · {graph.edges.length} edges</span>
          </div>

          {#if loading}
            <div class="empty-state">Loading graph…</div>
          {:else}
            <GraphView {graph} {selectedId} onSelect={(item) => (selectedId = item?.id ?? null)} />
          {/if}
        </div>

        <!-- Right: Node detail -->
        <div class="col-sidebar">
          <Sidebar
            {selectedItem}
            issueDetails={selectedIssueDetails}
            {graph}
            {saving}
            {edgeSaving}
            onSaveItem={handleSaveItem}
            onCreateItem={handleCreateItem}
            onCreateEdge={handleCreateEdge}
            onDeleteEdge={handleDeleteEdge}
            onCloseIssue={handleCloseIssue}
            {closingIssue}
          />
        </div>
      </div>
    </div>
  {:else if activeTab === "execute"}
    <div class="execute-viewport">
      <ExecutionDispatchPanel />
    </div>
  {:else if activeTab === "reconciliation"}
    <div class="reconciliation-viewport">
      <ReconciliationPanel />
    </div>
  {/if}
</div>

<style>
  /* ── Fixed viewport shell ── */
  .app-viewport {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100vh;
    overflow: hidden;
  }

  /* ── Top bar ── */
  .app-topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 1rem;
    height: 48px;
    background: #0f172a;
    border-bottom: 1px solid rgba(148, 163, 184, 0.16);
    flex-shrink: 0;
  }

  .topbar-left {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .app-brand {
    font-weight: 700;
    font-size: 0.85rem;
    color: #60a5fa;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
  }

  .tab-strip {
    display: flex;
    gap: 2px;
  }

  .tab-btn {
    padding: 0.35rem 1rem;
    background: transparent;
    color: #94a3b8;
    font-size: 0.85rem;
    font-weight: 600;
    border-radius: 6px;
    transition: background 120ms, color 120ms;
  }

  .tab-btn:hover {
    background: rgba(148, 163, 184, 0.1);
    color: #cbd5e1;
  }

  .tab-btn.active {
    background: rgba(37, 99, 235, 0.22);
    color: #eff6ff;
  }

  /* ── Planning tab ── */
  .planning-viewport {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    overflow: hidden;
  }

  .filter-bar {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    background: rgba(15, 23, 42, 0.5);
  }

  .planning-columns {
    display: grid;
    grid-template-columns: 380px minmax(0, 1fr) 320px;
    overflow: hidden;
  }

  .col-chat {
    overflow-y: auto;
    overflow-x: hidden;
    border-right: 1px solid rgba(148, 163, 184, 0.12);
    overscroll-behavior: contain;
  }

  .col-graph {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.5rem;
  }

  .graph-header {
    padding: 0.25rem 0.5rem;
    flex-shrink: 0;
  }

  .col-sidebar {
    overflow-y: auto;
    overflow-x: hidden;
    border-left: 1px solid rgba(148, 163, 184, 0.12);
    overscroll-behavior: contain;
  }

  /* ── Execute tab ── */
  .execute-viewport {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }

  /* ── Reconciliation tab ── */
  .reconciliation-viewport {
    overflow-y: auto;
    padding: 0 1rem 2rem;
  }

  /* ── Shared ── */
  .empty-state {
    display: grid;
    place-items: center;
    flex: 1;
    color: #94a3b8;
  }

  @media (max-width: 1100px) {
    .planning-columns {
      grid-template-columns: 300px minmax(0, 1fr) 280px;
    }
  }

  @media (max-width: 860px) {
    .planning-columns {
      grid-template-columns: 1fr;
      grid-template-rows: auto;
      overflow-y: auto;
    }

    .col-chat,
    .col-sidebar {
      border: none;
    }

    .execute-viewport {
      grid-template-rows: auto;
      overflow-y: auto;
    }
  }
</style>

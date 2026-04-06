<script>
  import PlannerChatAdapter from "./components/PlannerChatAdapter.svelte";
  import ExecutionDispatchPanel from "./components/ExecutionDispatchPanel.svelte";
  import ReconciliationPanel from "./components/ReconciliationPanel.svelte";
  import GraphView from "./components/GraphView.svelte";
  import FiltersToolbar from "./components/FiltersToolbar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import WorkspaceTabs from "./components/WorkspaceTabs.svelte";
  import {
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

  const workspaceTabs = [
    {
      id: "planning",
      label: "Planning",
      description: "Planner chat, filters, dependency graph, and work item editor.",
    },
    {
      id: "execute",
      label: "Execute",
      description: "Dispatch execution work and review reconciliation output.",
    },
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
      if (token === issueLookupToken) {
        selectedIssueDetails = details;
      }
    } catch (lookupError) {
      if (token === issueLookupToken) {
        selectedIssueDetails = { error: lookupError.message, repo: item.repo, number: item.issue_number, url: item.issue_url };
      }
    }
  }

  async function handleSaveItem(payload) {
    if (!selectedItem) {
      return;
    }

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
  <title>Escapement Studio Workspace</title>
</svelte:head>

<div class="app-shell">
  <header class="app-header">
    <div>
      <p class="eyebrow">Escapement Studio</p>
      <h1>Studio workspace</h1>
      <p class="muted">
        {activeTab === "planning"
          ? "Plan work in the graph-backed workspace and keep edits synchronized with the Studio API."
          : "Launch execution work and compare predicted scope with recorded execution results."}
      </p>
    </div>
    <div class="status-cluster">
      <span class:healthy={health?.ok} class="status-pill">
        {health?.ok ? "API healthy" : "API unavailable"}
      </span>
      {#if activeTab === "planning"}
        <button class="secondary" on:click={refresh} disabled={loading}>Refresh graph</button>
      {/if}
    </div>
  </header>

  <WorkspaceTabs tabs={workspaceTabs} bind:activeTab />

  <section id="planning-panel" aria-labelledby="planning-tab" hidden={activeTab !== "planning"} class="workspace-panel">
    <div class="planning-workspace">
      <PlannerChatAdapter on:graphChanged={refresh} />

      <FiltersToolbar {filters} options={filterOptions} onChange={handleFilterChange} onReset={resetFilters} />

      {#if error}
        <div class="banner error">{error}</div>
      {/if}

      <main class="layout">
        <section class="graph-panel card">
          <div class="panel-header">
            <div>
              <h2>Dependency graph</h2>
              <p class="muted">{graph.items.length} items · {graph.edges.length} edges</p>
            </div>
          </div>

          {#if loading}
            <div class="empty-state">Loading graph from the Studio server…</div>
          {:else}
            <GraphView {graph} {selectedId} onSelect={(item) => (selectedId = item.id)} />
          {/if}
        </section>

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
        />
      </main>
    </div>
  </section>

  <section id="execute-panel" aria-labelledby="execute-tab" hidden={activeTab !== "execute"} class="workspace-panel">
    <div class="execute-workspace">
      <ExecutionDispatchPanel />
      <ReconciliationPanel />
    </div>
  </section>
</div>

<style>
  .workspace-panel {
    display: grid;
  }

  .planning-workspace,
  .execute-workspace {
    display: grid;
    gap: 1rem;
  }
</style>

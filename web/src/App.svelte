<script>
  import PlannerChatAdapter from "./components/PlannerChatAdapter.svelte";
  import ExecutionDispatchPanel from "./components/ExecutionDispatchPanel.svelte";
  import ReconciliationPanel from "./components/ReconciliationPanel.svelte";
  import SettingsPanel from "./components/SettingsPanel.svelte";
  import GraphView from "./components/GraphView.svelte";
  import GraphNodeContextMenu from "./components/GraphNodeContextMenu.svelte";
  import FiltersToolbar from "./components/FiltersToolbar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import {
    closeGitHubIssue,
    closeMergedPullRequest,
    createEdge,
    createWorkItem,
    deleteEdge,
    getExecutionEligibility,
    getGitHubIssueDetails,
    getGraph,
    getHealth,
    launchExecutionRun,
    listWorkItems,
    syncMergedPullRequest,
    updateWorkItem,
  } from "./lib/api.js";
  import { buildGraphNodeContextMenu } from "./lib/graph-node-actions.js";

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
  let launchingExecution = false;
  let launchEligibilityById = {};
  let launchEligibilityLoadingIds = {};
  let launchEligibilityRequestTokenById = {};
  let graphContextMenu = { open: false, x: 0, y: 0, item: null };

  // Panel collapse state
  let chatCollapsed = false;
  let sidebarCollapsed = false;

  // Resizable pane widths (pixels)
  let chatWidth = 360;
  let sidebarWidth = 320;
  const MIN_PANE = 200;
  const MAX_PANE = 600;

  // Drag state
  let dragging = null; // 'left' | 'right' | null
  let dragStartX = 0;
  let dragStartWidth = 0;

  function onDragStart(pane, event) {
    dragging = pane;
    dragStartX = event.clientX;
    dragStartWidth = pane === "left" ? chatWidth : sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
  }

  function onDragMove(event) {
    if (!dragging) return;
    const delta = event.clientX - dragStartX;
    if (dragging === "left") {
      chatWidth = Math.min(MAX_PANE, Math.max(MIN_PANE, dragStartWidth + delta));
    } else {
      sidebarWidth = Math.min(MAX_PANE, Math.max(MIN_PANE, dragStartWidth - delta));
    }
  }

  function onDragEnd() {
    dragging = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
  }

  const activityItems = [
    { id: "planning", label: "Planning", icon: "plan" },
    { id: "execute", label: "Execute", icon: "execute" },
    { id: "reconciliation", label: "Reconcile", icon: "reconcile" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];

  $: selectedItem = graph.items.find((item) => item.id === selectedId) ?? null;
  $: selectedLaunchEligibility = selectedItem ? launchEligibilityById[selectedItem.id] ?? null : null;
  $: selectedLaunchEligibilityLoading = selectedItem ? !!launchEligibilityLoadingIds[selectedItem.id] : false;
  $: contextMenuLaunchEligibility = graphContextMenu.item ? launchEligibilityById[graphContextMenu.item.id] ?? null : null;
  $: contextMenuLaunchEligibilityLoading = graphContextMenu.item ? !!launchEligibilityLoadingIds[graphContextMenu.item.id] : false;
  $: graphContextMenuModel = buildGraphNodeContextMenu({
    item: graphContextMenu.item,
    launchEligibility: contextMenuLaunchEligibility,
    launchEligibilityLoading: contextMenuLaunchEligibilityLoading,
    launchingExecution,
  });
  $: filterOptions = {
    repos: [...new Set(catalog.map((item) => item.repo).filter(Boolean))].sort(),
    states: [...new Set(catalog.map((item) => item.state).filter(Boolean))].sort(),
    tracks: catalog.filter((item) => item.kind === "track"),
    phases: catalog.filter((item) => item.kind === "phase"),
  };

  $: activeFilterCount = Object.values(filters).filter(Boolean).length;
  $: if (selectedItem?.id) {
    void ensureLaunchEligibility(selectedItem.id);
  }

  function closeGraphContextMenu() {
    graphContextMenu = { open: false, x: 0, y: 0, item: null };
  }

  function normalizeLaunchEligibilityError(workItemId, message) {
    return {
      work_item_id: workItemId,
      repo: null,
      issue_url: null,
      issue_backed: false,
      can_launch: false,
      safety_checks: [],
      launch_unavailable_code: "eligibility_lookup_failed",
      launch_unavailable_reason: message,
      dispatch_node: null,
    };
  }

  async function ensureLaunchEligibility(workItemId, { force = false } = {}) {
    if (!workItemId) return null;
    if (!force && launchEligibilityById[workItemId]) {
      return launchEligibilityById[workItemId];
    }

    const token = (launchEligibilityRequestTokenById[workItemId] || 0) + 1;
    launchEligibilityRequestTokenById = { ...launchEligibilityRequestTokenById, [workItemId]: token };
    launchEligibilityLoadingIds = { ...launchEligibilityLoadingIds, [workItemId]: true };

    try {
      const eligibility = await getExecutionEligibility({ work_item_id: workItemId });
      if (launchEligibilityRequestTokenById[workItemId] === token) {
        launchEligibilityById = { ...launchEligibilityById, [workItemId]: eligibility };
      }
      return eligibility;
    } catch (lookupError) {
      const fallback = normalizeLaunchEligibilityError(workItemId, lookupError.message);
      if (launchEligibilityRequestTokenById[workItemId] === token) {
        launchEligibilityById = { ...launchEligibilityById, [workItemId]: fallback };
      }
      return fallback;
    } finally {
      if (launchEligibilityRequestTokenById[workItemId] === token) {
        launchEligibilityLoadingIds = { ...launchEligibilityLoadingIds, [workItemId]: false };
      }
    }
  }

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
      launchEligibilityById = {};
      launchEligibilityLoadingIds = {};
      launchEligibilityRequestTokenById = {};
      if (selectedId && !graph.items.some((item) => item.id === selectedId)) {
        selectedId = null;
        closeGraphContextMenu();
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

  function mergeReconciledWorkItems(workItems = []) {
    if (!Array.isArray(workItems) || workItems.length === 0) {
      return;
    }

    const nextById = new Map(workItems.filter((item) => item?.id).map((item) => [item.id, item]));
    if (nextById.size === 0) {
      return;
    }

    graph = {
      ...graph,
      items: graph.items.map((item) => nextById.get(item.id) ?? item),
    };
    catalog = catalog.map((item) => nextById.get(item.id) ?? item);

    if (graphContextMenu.item?.id && nextById.has(graphContextMenu.item.id)) {
      graphContextMenu = {
        ...graphContextMenu,
        item: nextById.get(graphContextMenu.item.id),
      };
    }
  }

  function handleGitHubTruthRefresh(payload) {
    mergeReconciledWorkItems(payload?.reconciliation?.work_items ?? []);
  }

  let issueLookupToken = 0;
  let lastIssueLookupKey = null;
  $: issueLookupKey = selectedItem?.repo && selectedItem?.issue_number
    ? `${selectedItem.repo}#${selectedItem.issue_number}`
    : null;
  $: if (issueLookupKey !== lastIssueLookupKey) {
    lastIssueLookupKey = issueLookupKey;
    void loadSelectedIssueDetails(selectedItem);
  }

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
        handleGitHubTruthRefresh(details);
      }
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
      // ADR 014 step 7: route work item disposition through the state
      // machine instead of a raw state: "done" PUT. The button's
      // precondition (canCloseIssue) guarantees the linked PR is already
      // merged, so post-merge-sync is safe to call here — it transitions
      // the work item to `merged_pr` if not already there. Then
      // closeMergedPullRequest does the `merged_pr → done` disposition.
      await closeGitHubIssue({ repo: item.repo, issue_number: item.issue_number });
      if (item.state !== "merged_pr" && item.state !== "done") {
        await syncMergedPullRequest({ work_item_id: item.id });
      }
      if (item.state !== "done") {
        await closeMergedPullRequest(item.id);
      }
      await loadGraph();
    } catch (closeError) {
      error = closeError.message;
    } finally {
      closingIssue = false;
    }
  }

  function handleGraphSelect(item) {
    selectedId = item?.id ?? null;
    closeGraphContextMenu();
  }

  async function handleGraphContextMenu(detail) {
    if (!detail?.item?.id) {
      closeGraphContextMenu();
      return;
    }

    selectedId = detail.item.id;
    graphContextMenu = {
      open: true,
      x: detail.x,
      y: detail.y,
      item: detail.item,
    };
    await ensureLaunchEligibility(detail.item.id);
  }

  function handleGlobalKeydown(event) {
    if (event.key === "Escape") {
      closeGraphContextMenu();
    }
  }

  async function handleLaunchExecution(item = selectedItem) {
    const workItemId = item?.id;
    if (!workItemId) return;

    launchingExecution = true;
    error = "";
    try {
      const eligibility = await ensureLaunchEligibility(workItemId, { force: true });
      if (!eligibility?.can_launch) {
        error = eligibility?.launch_unavailable_reason || "Launch execution is not available for this node.";
        return;
      }

      const result = await launchExecutionRun({ work_item_id: workItemId, disambiguate: true });
      closeGraphContextMenu();
      if (result?.run) {
        activeTab = "execute";
      }
    } catch (launchError) {
      error = launchError.message;
    } finally {
      launchingExecution = false;
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

<svelte:window
  on:click={closeGraphContextMenu}
  on:contextmenu={closeGraphContextMenu}
  on:keydown={handleGlobalKeydown}
  on:resize={closeGraphContextMenu}
  on:scroll={closeGraphContextMenu}
/>

<div class="app-shell">
  <!-- Activity Bar (far left icon rail) -->
  <aside class="activity-bar">
    <div class="activity-icons">
      {#each activityItems as item}
        <button
          class="activity-icon"
          class:active={activeTab === item.id}
          on:click={() => (activeTab = item.id)}
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
        on:click={refresh}
        disabled={loading}
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

  <!-- Main content area -->
  <div class="main-area">
    <!-- Title bar -->
    <header class="title-bar">
      <span class="title-bar-label">{activityItems.find(t => t.id === activeTab)?.label ?? ""}</span>
      <span class="title-bar-brand">Escapement Studio</span>
      <span class="title-bar-spacer"></span>
    </header>

    <!-- Planning tab -->
    {#if activeTab === "planning"}
      <div class="planning-viewport">
        <!-- Filter bar -->
        <div class="filter-bar">
          <FiltersToolbar {filters} options={filterOptions} onChange={handleFilterChange} onReset={resetFilters} />
        </div>

        <!-- 3-column resizable layout -->
        <div class="planning-columns" class:dragging={dragging !== null}>
          <!-- Left: Chat -->
          {#if !chatCollapsed}
            <div class="col-pane col-chat" style="width:{chatWidth}px; min-width:{chatWidth}px; max-width:{chatWidth}px;">
              <div class="pane-header">
                <span class="pane-title">CHAT</span>
                <div class="pane-actions">
                  <button class="pane-action" on:click={() => (chatCollapsed = true)} title="Collapse panel" aria-label="Collapse chat panel">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="11,17 6,12 11,7"/><polyline points="18,17 13,12 18,7"/></svg>
                  </button>
                </div>
              </div>
              <div class="pane-body">
                <PlannerChatAdapter on:graphChanged={refresh} />
              </div>
            </div>
            <!-- Left resize handle -->
            <div class="resize-handle" on:mousedown={(e) => onDragStart("left", e)} role="separator" aria-label="Resize chat panel"></div>
          {:else}
            <button class="collapsed-pane-tab" on:click={() => (chatCollapsed = false)} title="Expand Chat">
              <span>CHAT</span>
            </button>
          {/if}

          <!-- Center: Graph -->
          <div class="col-pane col-graph">
            <div class="pane-header">
              <span class="pane-title">GRAPH</span>
              <span class="pane-badge">{graph.items.length} items · {graph.edges.length} edges</span>
            </div>
            <div class="pane-body pane-body-graph">
              {#if error}
                <div class="banner error">{error}</div>
              {/if}
              {#if loading}
                <div class="empty-state">Loading graph…</div>
              {:else}
                <GraphView
                  {graph}
                  {selectedId}
                  onSelect={handleGraphSelect}
                  onContextMenu={handleGraphContextMenu}
                />
              {/if}
            </div>
          </div>

          <!-- Right resize handle -->
          {#if !sidebarCollapsed}
            <div class="resize-handle" on:mousedown={(e) => onDragStart("right", e)} role="separator" aria-label="Resize details panel"></div>
          {/if}

          <!-- Right: Detail sidebar -->
          {#if !sidebarCollapsed}
            <div class="col-pane col-sidebar" style="width:{sidebarWidth}px; min-width:{sidebarWidth}px; max-width:{sidebarWidth}px;">
              <div class="pane-header">
                <span class="pane-title">DETAILS</span>
                <div class="pane-actions">
                  <button class="pane-action" on:click={() => (sidebarCollapsed = true)} title="Collapse panel" aria-label="Collapse details panel">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13,17 18,12 13,7"/><polyline points="6,17 11,12 6,7"/></svg>
                  </button>
                </div>
              </div>
              <div class="pane-body">
                <Sidebar
                  {selectedItem}
                  issueDetails={selectedIssueDetails}
                  launchEligibility={selectedLaunchEligibility}
                  launchEligibilityLoading={selectedLaunchEligibilityLoading}
                  launchingExecution={launchingExecution}
                  onLaunchExecution={handleLaunchExecution}
                  onGitHubTruthRefresh={handleGitHubTruthRefresh}
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
          {:else}
            <button class="collapsed-pane-tab collapsed-pane-tab-right" on:click={() => (sidebarCollapsed = false)} title="Expand Details">
              <span>DETAILS</span>
            </button>
          {/if}
        </div>
      </div>
    {:else if activeTab === "execute"}
      <div class="fullpane-viewport">
        <div class="pane-header">
          <span class="pane-title">EXECUTION</span>
        </div>
        <div class="pane-body fullpane-body">
          <ExecutionDispatchPanel />
        </div>
      </div>
    {:else if activeTab === "reconciliation"}
      <div class="fullpane-viewport">
        <div class="pane-header">
          <span class="pane-title">RECONCILIATION</span>
        </div>
        <div class="pane-body fullpane-body">
          <ReconciliationPanel />
        </div>
      </div>
    {:else if activeTab === "settings"}
      <div class="fullpane-viewport">
        <div class="pane-header">
          <span class="pane-title">SETTINGS</span>
        </div>
        <div class="pane-body fullpane-body">
          <SettingsPanel {health} />
        </div>
      </div>
    {/if}

    {#if activeTab === "planning" && graphContextMenu.open && graphContextMenu.item && graphContextMenuModel}
      <GraphNodeContextMenu
        menu={graphContextMenuModel}
        x={graphContextMenu.x}
        y={graphContextMenu.y}
        on:action={(event) => {
          if (event.detail.id === "launch-execution") {
            handleLaunchExecution(graphContextMenu.item);
          }
        }}
        on:requestclose={closeGraphContextMenu}
      />
    {/if}

    <!-- Status bar -->
    <footer class="status-bar">
      <div class="status-bar-left">
        <span class="status-indicator" class:healthy={health?.ok}></span>
        <span class="status-text">{health?.ok ? "Connected" : "Disconnected"}</span>
        {#if activeTab === "planning"}
          <span class="status-sep">|</span>
          <span class="status-text">{graph.items.length} items</span>
          <span class="status-text">{graph.edges.length} edges</span>
          {#if activeFilterCount > 0}
            <span class="status-sep">|</span>
            <span class="status-text">{activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""} active</span>
          {/if}
        {/if}
      </div>
      <div class="status-bar-right">
        <span class="status-text">Escapement Studio</span>
      </div>
    </footer>
  </div>
</div>

<style>
  /* ── App shell: activity bar + main area ── */
  .app-shell {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr);
    height: 100vh;
    overflow: hidden;
  }

  /* ── Activity Bar ── */
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

  /* ── Main area ── */
  .main-area {
    display: grid;
    grid-template-rows: 30px minmax(0, 1fr) 22px;
    overflow: hidden;
    background: #0d1117;
  }

  /* ── Title bar ── */
  .title-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 30px;
    background: #181d28;
    border-bottom: 1px solid #2b3245;
    padding: 0 12px;
    position: relative;
  }

  .title-bar-label {
    position: absolute;
    left: 12px;
    font-size: 11px;
    font-weight: 600;
    color: #8b95a5;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .title-bar-brand {
    font-size: 11px;
    color: #6b7a94;
    letter-spacing: 0.02em;
  }

  .title-bar-spacer {
    flex: 1;
  }

  /* ── Status bar ── */
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 22px;
    background: #1a1f2e;
    border-top: 1px solid #2b3245;
    padding: 0 10px;
    font-size: 11px;
    color: #6b7a94;
    gap: 8px;
    flex-shrink: 0;
  }

  .status-bar-left,
  .status-bar-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status-indicator {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #5c3a3a;
    flex-shrink: 0;
  }

  .status-indicator.healthy {
    background: #3fb950;
  }

  .status-text {
    white-space: nowrap;
  }

  .status-sep {
    color: #3b4559;
    margin: 0 2px;
  }

  /* ── Pane header (panel title bars) ── */
  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    min-height: 28px;
    padding: 0 10px;
    background: #13171f;
    border-bottom: 1px solid #2b3245;
    flex-shrink: 0;
  }

  .pane-title {
    font-size: 10.5px;
    font-weight: 700;
    color: #8b95a5;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .pane-badge {
    font-size: 10.5px;
    color: #566070;
    letter-spacing: 0.01em;
  }

  .pane-actions {
    display: flex;
    gap: 2px;
  }

  .pane-action {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    color: #6b7a94;
    border-radius: 3px;
    transition: background 80ms, color 80ms;
  }

  .pane-action:hover {
    background: rgba(255,255,255,0.08);
    color: #c5cdd8;
  }

  /* ── Pane body ── */
  .pane-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
  }

  .pane-body-graph {
    display: flex;
    flex-direction: column;
    padding: 4px;
  }

  /* ── Collapsed pane tab ── */
  .collapsed-pane-tab {
    display: flex;
    align-items: center;
    justify-content: center;
    writing-mode: vertical-lr;
    width: 28px;
    padding: 10px 0;
    background: #13171f;
    color: #6b7a94;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    border-radius: 0;
    border-right: 1px solid #2b3245;
    transition: background 80ms, color 80ms;
  }

  .collapsed-pane-tab:hover {
    background: #1a2030;
    color: #c5cdd8;
  }

  .collapsed-pane-tab-right {
    border-right: none;
    border-left: 1px solid #2b3245;
  }

  /* ── Resize handle ── */
  .resize-handle {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    transition: background 120ms;
    flex-shrink: 0;
    position: relative;
    z-index: 5;
  }

  .resize-handle:hover,
  .dragging .resize-handle {
    background: #2563eb;
  }

  /* ── Planning viewport ── */
  .planning-viewport {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .filter-bar {
    padding: 4px 8px;
    border-bottom: 1px solid #2b3245;
    background: #13171f;
    flex-shrink: 0;
  }

  .planning-columns {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .col-pane {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .col-graph {
    flex: 1;
    min-width: 0;
  }

  .col-chat,
  .col-sidebar {
    flex-shrink: 0;
  }

  .col-chat {
    border-right: 1px solid #2b3245;
  }

  .col-sidebar {
    border-left: 1px solid #2b3245;
  }

  /* ── Full pane viewports (Execute, Reconciliation) ── */
  .fullpane-viewport {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .fullpane-body {
    overflow-y: auto;
    padding: 0;
  }

  /* ── Shared ── */
  .empty-state {
    display: grid;
    place-items: center;
    flex: 1;
    color: #6b7a94;
    font-size: 12px;
  }

  /* ── Responsive ── */
  @media (max-width: 860px) {
    .app-shell {
      grid-template-columns: 40px minmax(0, 1fr);
    }

    .planning-columns {
      flex-direction: column;
    }

    .col-chat,
    .col-sidebar {
      width: 100% !important;
      min-width: 100% !important;
      max-width: 100% !important;
      border: none;
      border-bottom: 1px solid #2b3245;
    }

    .resize-handle {
      display: none;
    }

    .collapsed-pane-tab {
      writing-mode: horizontal-tb;
      width: 100%;
      height: 28px;
    }
  }
</style>

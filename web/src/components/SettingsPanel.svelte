<script>
  import { onMount } from "svelte";
  import { getSettings, updateSettings, getAvailableModels } from "../lib/api.js";

  export let health = null;

  let settings = null;
  let loading = true;
  let error = "";
  let saving = false;
  let saveFlash = "";
  let saveTimer;

  // Local edit state
  let editRepos = [];
  let editConfig = {};
  let newRepoSlug = "";
  let newRepoBranch = "main";

  // Model selection state
  let availableModels = [];
  let modelsLoadError = "";
  let selectedModelKey = ""; // "" means use pi default; otherwise "provider::modelId"

  onMount(async () => {
    await load();
  });

  async function load() {
    loading = true;
    error = "";
    try {
      settings = await getSettings();
      syncEditState();
      await loadModels();
    } catch (loadError) {
      error = loadError.message;
    } finally {
      loading = false;
    }
  }

  async function loadModels() {
    modelsLoadError = "";
    try {
      availableModels = await getAvailableModels();
    } catch (err) {
      modelsLoadError = err.message;
      availableModels = [];
    }
  }

  $: modelsByProvider = groupModelsByProvider(availableModels);
  $: selectedModelInfo = findModelInfo(availableModels, selectedModelKey);
  $: selectedModelUnavailable =
    selectedModelKey && selectedModelInfo && !selectedModelInfo.available;
  $: selectedModelMissing =
    selectedModelKey && !selectedModelInfo && availableModels.length > 0;

  function groupModelsByProvider(models) {
    const groups = new Map();
    for (const m of models) {
      if (!groups.has(m.provider)) groups.set(m.provider, []);
      groups.get(m.provider).push(m);
    }
    const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [, list] of sorted) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  }

  function findModelInfo(models, key) {
    if (!key) return null;
    const [provider, id] = key.split("::");
    return models.find((m) => m.provider === provider && m.id === id) ?? null;
  }

  function modelKey(provider, id) {
    return `${provider}::${id}`;
  }

  function syncEditState() {
    if (!settings) return;
    editRepos = Object.entries(settings.repos ?? {})
      .map(([slug, info]) => ({ slug, ...info }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    editConfig = { ...settings.config };
    selectedModelKey = editConfig.selectedModel
      ? modelKey(editConfig.selectedModel.provider, editConfig.selectedModel.modelId)
      : "";
  }

  function onModelChange(event) {
    const value = event.target.value;
    selectedModelKey = value;
    if (!value) {
      editConfig = { ...editConfig, selectedModel: null };
      return;
    }
    const [provider, modelId] = value.split("::");
    editConfig = { ...editConfig, selectedModel: { provider, modelId } };
  }

  async function save() {
    saving = true;
    error = "";
    try {
      const repos = {};
      for (const repo of editRepos) {
        repos[repo.slug] = {
          default_branch: repo.default_branch || "main",
          included: repo.included !== false,
        };
      }
      settings = await updateSettings({ repos, config: editConfig });
      syncEditState();
      flash("Settings saved");
    } catch (saveError) {
      error = saveError.message;
    } finally {
      saving = false;
    }
  }

  function flash(message) {
    saveFlash = message;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveFlash = ""; }, 2200);
  }

  function addRepo() {
    const slug = newRepoSlug.trim();
    const branch = newRepoBranch.trim() || "main";
    if (!slug) return;
    if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
      flash("Use owner/repo format");
      return;
    }
    if (editRepos.some((r) => r.slug === slug)) {
      flash("Repo already added");
      return;
    }
    editRepos = [...editRepos, { slug, default_branch: branch, included: true }];
    newRepoSlug = "";
    newRepoBranch = "main";
  }

  function removeRepo(slug) {
    editRepos = editRepos.filter((r) => r.slug !== slug);
  }

  function toggleIncluded(slug) {
    editRepos = editRepos.map((r) =>
      r.slug === slug ? { ...r, included: !r.included } : r
    );
  }

  $: dirty = hasDrift(settings, editRepos, editConfig);

  function hasDrift(original, repos, config) {
    if (!original) return false;
    const currentRepos = {};
    for (const r of repos) {
      currentRepos[r.slug] = { default_branch: r.default_branch, included: r.included };
    }
    return JSON.stringify({ repos: currentRepos, config }) !==
      JSON.stringify({ repos: original.repos ?? {}, config: original.config ?? {} });
  }
</script>

<div class="settings-panel">
  {#if error}
    <div class="banner error inline-banner">{error}</div>
  {/if}
  {#if saveFlash}
    <div class="banner success inline-banner">{saveFlash}</div>
  {/if}

  {#if loading}
    <div class="empty-state">Loading settings…</div>
  {:else}
    <!-- Server status (read-only) -->
    <section class="settings-section">
      <h2>Server</h2>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Status</span>
          <span class="settings-value">
            <span class="status-pill" class:healthy={health?.ok}>{health?.ok ? "Connected" : "Disconnected"}</span>
          </span>
        </div>
        {#if health?.db}
          <div class="settings-row">
            <span class="settings-label">Database</span>
            <span class="settings-value"><code>{health.db.path ?? "—"}</code></span>
          </div>
          <div class="settings-row">
            <span class="settings-label">DB healthy</span>
            <span class="settings-value">
              <span class="status-pill" class:healthy={health.db.healthy}>{health.db.healthy ? "Yes" : "No"}</span>
            </span>
          </div>
          <div class="settings-row">
            <span class="settings-label">Schema</span>
            <span class="settings-value">
              <span class="status-pill" class:healthy={health.db.hasSchema}>{health.db.hasSchema ? "Yes" : "No"}</span>
            </span>
          </div>
        {/if}
      </div>
    </section>

    <!-- Model selection -->
    <section class="settings-section">
      <h2>Model</h2>
      <p class="muted">Choose which pi-backed model Studio uses for planning, execution, and plan drafting. Leave on <em>Default</em> to let pi pick the first available model.</p>
      <div class="settings-card">
        {#if modelsLoadError}
          <div class="banner error inline-banner">Failed to load models: {modelsLoadError}</div>
        {/if}
        <div class="settings-row">
          <span class="settings-label">Current</span>
          <span class="settings-value">
            {#if selectedModelInfo}
              <code>{selectedModelInfo.provider} / {selectedModelInfo.name}</code>
              {#if !selectedModelInfo.available}
                <span class="status-pill" style="margin-left: 0.5rem;">No auth configured</span>
              {/if}
            {:else if selectedModelMissing}
              <code>{editConfig.selectedModel?.provider} / {editConfig.selectedModel?.modelId}</code>
              <span class="status-pill" style="margin-left: 0.5rem;">Not in registry</span>
            {:else}
              <em class="muted">Default (pi first-available)</em>
            {/if}
          </span>
        </div>
        <label>
          Model
          <select value={selectedModelKey} on:change={onModelChange} disabled={availableModels.length === 0}>
            <option value="">— Use default —</option>
            {#each modelsByProvider as [provider, models]}
              <optgroup label={provider}>
                {#each models as m}
                  <option value={modelKey(m.provider, m.id)}>
                    {m.name}{m.available ? "" : " (no auth)"}
                  </option>
                {/each}
              </optgroup>
            {/each}
          </select>
        </label>
        {#if selectedModelUnavailable}
          <p class="muted"><strong>Warning:</strong> The selected model has no configured auth. Studio will fall back to pi's default model until credentials are configured.</p>
        {/if}
      </div>
    </section>

    <!-- App configuration -->
    <section class="settings-section">
      <h2>Configuration</h2>
      <p class="muted">Server-side configuration. Changes are persisted and take effect immediately.</p>
      <div class="settings-card">
        <label>
          Manifest path
          <input bind:value={editConfig.manifestPath} placeholder=".manifest" />
        </label>
        <label>
          Planning session directory
          <input bind:value={editConfig.planningSessionDir} placeholder=".studio/planning/sessions" />
        </label>
        <label>
          Artifact root
          <input bind:value={editConfig.artifactRoot} placeholder="/home/marc/escapement-studio-ctx" />
        </label>
      </div>
    </section>

    <!-- Repo targeting -->
    <section class="settings-section">
      <h2>Repositories</h2>
      <p class="muted">Select included repos and set the default working branch for execution runs.</p>

      <div class="settings-card">
        {#if editRepos.length > 0}
          <div class="repo-branch-list">
            <div class="repo-branch-header">
              <span class="settings-label">Included</span>
              <span class="settings-label">Repository</span>
              <span class="settings-label">Default branch</span>
              <span></span>
            </div>
            {#each editRepos as repo}
              <div class="repo-branch-row" class:repo-excluded={!repo.included}>
                <label class="repo-toggle">
                  <input type="checkbox" checked={repo.included} on:change={() => toggleIncluded(repo.slug)} />
                </label>
                <code class="repo-slug">{repo.slug}</code>
                <input
                  class="repo-branch-input"
                  bind:value={repo.default_branch}
                  placeholder="main"
                />
                <button class="danger small" on:click={() => removeRepo(repo.slug)} title="Remove repo">✕</button>
              </div>
            {/each}
          </div>
        {:else}
          <p class="muted">No repos configured. Add a repository to get started.</p>
        {/if}

        <div class="repo-branch-add">
          <span></span>
          <input
            bind:value={newRepoSlug}
            placeholder="owner/repo"
            on:keydown={(e) => e.key === "Enter" && addRepo()}
          />
          <input
            bind:value={newRepoBranch}
            placeholder="branch"
            on:keydown={(e) => e.key === "Enter" && addRepo()}
          />
          <button class="secondary" on:click={addRepo}>Add</button>
        </div>
      </div>
    </section>

    <!-- Save bar -->
    <section class="settings-section">
      <div class="settings-actions">
        <button on:click={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : dirty ? "Save changes" : "No changes"}
        </button>
        <button class="secondary" on:click={load} disabled={loading}>Reload</button>
      </div>
    </section>
  {/if}
</div>

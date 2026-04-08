<script>
  import { onMount } from "svelte";
  import { getSettings, updateSettings } from "../lib/api.js";

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

  onMount(async () => {
    await load();
  });

  async function load() {
    loading = true;
    error = "";
    try {
      settings = await getSettings();
      syncEditState();
    } catch (loadError) {
      error = loadError.message;
    } finally {
      loading = false;
    }
  }

  function syncEditState() {
    if (!settings) return;
    editRepos = Object.entries(settings.repos ?? {})
      .map(([slug, info]) => ({ slug, ...info }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    editConfig = { ...settings.config };
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

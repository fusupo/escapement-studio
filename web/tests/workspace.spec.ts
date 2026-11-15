import { test, expect } from "@playwright/test";
import { mockWorkspace } from "./workspace.fixture";

test.describe('guarded base fast-forward', () => {
  for (const width of [1440, 1000]) {
    test(`resynchronizes after keyboard action and prevents duplicate requests at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      const fixture = await mockWorkspace(page, { dispatch: true, fastForward: 'deferred' });
      await page.goto('/');
      await page.getByRole('button', { name: 'Execute', exact: true }).click();
      await page.locator('.dispatch-item').click();
      const button = page.getByRole('button', { name: 'Fast-forward develop', exact: true });
      await expect(button).toBeVisible();
      await button.focus(); await page.keyboard.press('Enter');
      const pending = page.getByRole('button', { name: 'Fast-forwarding…', exact: true });
      await expect(pending).toBeDisabled();
      await pending.dispatchEvent('click');
      const posts = () => fixture.calls.filter(call => call.path.endsWith('/base-ref/fast-forward'));
      await expect.poll(() => posts().length).toBe(1);
      expect(posts()[0].body).toEqual({ work_item_id: 'studio-900' });
      await expect(page.getByRole('status').filter({ hasText: 'Fetching remote truth' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`fast-forward-${width}.png`), fullPage: true });
      fixture.finishFastForward();
      await expect(page.locator('.exec-col-details').getByRole('button', { name: 'Launch', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: /Fast-forward/ })).toHaveCount(0);
      expect(posts()).toHaveLength(1); expect(errors).toEqual([]);
    });
  }

  test('uses the configured default base and presents backend refusal inline', async ({ page }) => {
    const fixture = await mockWorkspace(page, { dispatch: true, baseRef: 'main', fastForward: 'refusal' });
    await page.goto('/'); await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.locator('.dispatch-item').click();
    await page.getByRole('button', { name: 'Fast-forward main', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'base_ref_sync_active_run: Active run exec_other' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fast-forward main', exact: true })).toBeEnabled();
    expect(fixture.calls.filter(call => call.path.endsWith('/base-ref/fast-forward'))).toHaveLength(1);
  });

  test('does not offer mutation for unrelated failed checks', async ({ page }) => {
    await mockWorkspace(page, { dispatch: true, failedCheck: 'branch_available' });
    await page.goto('/'); await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.locator('.dispatch-item').click();
    await expect(page.locator('.exec-col-details')).toContainText('branch_available');
    await expect(page.getByRole('button', { name: /Fast-forward/ })).toHaveCount(0);
  });

  test('reports unknown outcome on dropped response and reconnects without retrying mutation', async ({ page }) => {
    const fixture = await mockWorkspace(page, { dispatch: true, fastForward: 'drop' });
    await page.goto('/'); await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await page.locator('.dispatch-item').click();
    await page.getByRole('button', { name: 'Fast-forward develop', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Fast-forward outcome unknown. Wait for synchronization' })).toBeVisible();
    await page.evaluate(() => {
      const stream = (window as any).__streams.findLast((s: any) => s.url === '/api/execution/stream');
      stream.dispatchEvent(new Event('error')); stream.dispatchEvent(new Event('open'));
    });
    await expect(page.locator('.exec-col-details').getByRole('button', { name: 'Launch', exact: true })).toBeEnabled();
    expect(fixture.calls.filter(call => call.path.endsWith('/base-ref/fast-forward'))).toHaveLength(1);
  });
});

test('select a graph item, review and approve its plan, and render safe chat', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const fixture = await mockWorkspace(page);
  await page.goto('/');
  await expect(page.locator('.graph-canvas g.node')).toHaveCount(1);
  await page.locator('.graph-canvas g.node').click();
  await page.getByRole('button', { name: 'Review plan', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Workspace plan');
  await expect(page.getByRole('button', { name: 'Close plan review' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect.poll(() => fixture.calls.filter(call => call.path.endsWith('/approve')).length).toBe(1);
  await expect(page.getByRole('button', { name: 'Launch execution', exact: true })).toBeEnabled();
  await expect(page.locator('.chat-markdown strong')).toHaveText('planner');
  await expect(page.locator('.chat-markdown [onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('planning.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('preserve refinement drafts across reload and explicitly confirm coding', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const fixture = await mockWorkspace(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  const drawer = page.getByRole('complementary', { name: 'Execution confirmation', exact: true });
  await expect(drawer).toBeVisible();
  const confirm = page.getByRole('button', { name: 'Confirm execution and start coding' });
  await expect(confirm).toBeDisabled();
  await page.getByRole('radio', { name: 'Small change' }).check();
  await expect(confirm).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Small change' })).toBeChecked();
  expect(fixture.calls.filter(call => call.path.endsWith('/resolve-disambiguation'))).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('confirmation.png'), fullPage: true });
  await confirm.click();
  await expect(drawer).toHaveCount(0);
  const submission = fixture.calls.find(call => call.path.endsWith('/resolve-disambiguation'));
  expect(submission?.body.responses[0]).toMatchObject({ item_id: 'q1', selected_option_id: 'safe' });
  await expect(page.getByPlaceholder('Steer or follow up...')).toBeVisible();
  expect(errors).toEqual([]);
});

test('stay responsive while a long run streams full-run updates', async ({ page }) => {
  // The server sends the whole run, activity log included, on every
  // execution_status event. With a long log this once froze the tab for
  // tens of seconds per event (legacy-mode components deep-reading $state).
  const at = (i: number) => new Date(Date.UTC(2026, 8, 6, 10, 0, i)).toISOString();
  const activity_log = Array.from({ length: 600 }, (_, i) => i % 6 === 0
    ? { kind: 'turn_start', message: '', timestamp: at(i) }
    : i % 6 === 1
      ? { kind: 'agent_message', message: `Step ${i}\n${'Reasoning about the change. '.repeat(40)}`, timestamp: at(i) }
      : { kind: 'tool_start', message: `read src/file-${i}.ts`, timestamp: at(i) });
  const run = { run_id: 'exec_long', work_item_id: 'studio-900', work_item_name: 'Improve the workspace', status: 'running', phase: 'coding', repo: 'example/studio', branch: 'studio-900-branch', base_ref: 'develop', worktree_path: '/tmp/example', created_at: at(0), activity_log, safety_checks: [] };
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    (window as any).__longTasks = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) (window as any).__longTasks.push(entry.duration); }).observe({ type: 'longtask' });
  });
  await mockWorkspace(page, { run });
  await page.goto('/');
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.locator('.unified-feed .feed-activity').first()).toBeVisible();

  const blockedMs = await page.evaluate(async (initial) => {
    const stream = (window as any).__streams.findLast((s: any) => s.url === '/api/execution/stream');
    (window as any).__longTasks.length = 0;
    let current = initial;
    for (let i = 0; i < 20; i++) {
      current = { ...current, activity_log: [...current.activity_log, { kind: 'tool_end', message: `streamed event ${i}`, timestamp: new Date().toISOString() }] };
      stream.dispatchEvent(new MessageEvent('execution_status', { data: JSON.stringify({ payload: { run: current } }) }));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 100)));
    return (window as any).__longTasks.reduce((sum: number, d: number) => sum + d, 0);
  }, run);

  await expect(page.locator('.unified-feed')).toContainText('streamed event 19');
  expect(blockedMs).toBeLessThan(1500);
  expect(errors).toEqual([]);
});

test('recover a failed sync on stream reconnect and release streams on tab changes', async ({ page }) => {
  const fixture = await mockWorkspace(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'synced at' })).toBeVisible();
  await page.getByRole("button", { name: "Close execution confirmation", exact: true }).click();
  fixture.failRuns(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).last().click();
  await expect(page.getByRole('status').filter({ hasText: 'sync failed' })).toBeVisible();
  fixture.failRuns(false);
  await page.evaluate(() => (window as any).__streams.findLast((stream: any) => stream.url === '/api/execution/stream').dispatchEvent(new Event('open')));
  await expect(page.getByRole('status').filter({ hasText: 'synced at' })).toBeVisible();
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__streams.filter((stream: any) => stream.url === '/api/execution/stream').every((stream: any) => stream.closed))).toBe(true);
});

test.describe('GitHub refresh on tab focus', () => {
  const refreshPath = '/api/github-cache/refresh';
  const refocus = (page: import('@playwright/test').Page) => page.evaluate(() => {
    // A tab switch fires both events.
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });

  test('refreshes once per interval and reloads the planning graph', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    const fixture = await mockWorkspace(page);
    const refreshes = () => fixture.calls.filter(call => call.path === refreshPath);
    await page.goto('/');
    await expect(page.locator('.graph-canvas g.node')).toHaveCount(1);
    expect(refreshes()).toHaveLength(0);

    fixture.advanceItemOnGitHubRefresh('merged_pr');
    await refocus(page); await refocus(page); await refocus(page);
    await expect(page.locator('.graph-canvas g.node.graph-node--merged-pr')).toHaveCount(1);
    expect(refreshes()).toHaveLength(1);

    await page.clock.fastForward(9_000);
    await refocus(page);
    await page.clock.fastForward(1_500);
    await refocus(page);
    await expect.poll(() => refreshes().length).toBe(2);
    // The focus at 9 s fell inside the interval: no third request trails in.
    await page.waitForTimeout(250);
    expect(refreshes()).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  test('refreshes when moving between Studio tabs, within the same interval', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    const fixture = await mockWorkspace(page);
    const count = (path: string) => fixture.calls.filter(call => call.path === path).length;
    await page.goto('/');
    await expect(page.locator('.graph-canvas g.node')).toHaveCount(1);
    expect(count(refreshPath)).toBe(0);

    // Opening Execute: data shows at once, then syncs again after the refresh.
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await expect.poll(() => count(refreshPath)).toBe(1);
    await expect.poll(() => count('/api/execution/runs')).toBe(2);
    await expect(page.getByRole('status').filter({ hasText: 'synced at' })).toBeVisible();

    // Back to Planning inside the interval: no second refresh.
    await page.getByRole('button', { name: 'Planning', exact: true }).click();
    await expect(page.locator('.graph-canvas g.node')).toHaveCount(1);
    await page.waitForTimeout(250);
    expect(count(refreshPath)).toBe(1);

    // After the interval a tab change refreshes and the graph picks up the merge.
    await page.clock.fastForward(10_500);
    fixture.advanceItemOnGitHubRefresh('merged_pr');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Planning', exact: true }).click();
    await expect(page.locator('.graph-canvas g.node.graph-node--merged-pr')).toHaveCount(1);
    expect(count(refreshPath)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('asks GitHub before the Execute data sync and shows it as synchronizing', async ({ page }) => {
    await page.clock.install();
    const fixture = await mockWorkspace(page, { githubRefresh: 'deferred' });
    await page.goto('/');
    // Opening the tab makes its own refresh; let it finish and leave its interval.
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await expect.poll(() => fixture.calls.filter(call => call.path === refreshPath).length).toBe(1);
    fixture.finishGitHubRefresh();
    // Initial sync, stream-open sync and the post-refresh sync may coalesce; wait until they settle.
    await expect.poll(() => fixture.calls.filter(call => call.path === '/api/execution/runs').length).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(300);
    await expect(page.getByRole('status').filter({ hasText: 'synced at' })).toBeVisible();
    await page.clock.fastForward(10_500);
    const before = fixture.calls.length;
    const since = (path: string) => fixture.calls.slice(before).filter(call => call.path === path).length;

    await refocus(page);
    await expect.poll(() => since(refreshPath)).toBe(1);
    await expect(page.getByRole('status').filter({ hasText: 'synchronizing' })).toBeVisible();
    expect(since('/api/execution/runs')).toBe(0);

    fixture.finishGitHubRefresh();
    await expect.poll(() => since('/api/execution/runs')).toBe(1);
    await expect(page.getByRole('status').filter({ hasText: 'synced at' })).toBeVisible();
    expect(since(refreshPath)).toBe(1);
  });

  test('still synchronizes when the GitHub refresh fails', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    const fixture = await mockWorkspace(page, { githubRefresh: 'fail' });
    await page.goto('/');
    // Opening the tab makes its own (failing) refresh; leave its interval.
    await page.getByRole('button', { name: 'Execute', exact: true }).click();
    await expect.poll(() => fixture.calls.filter(call => call.path === refreshPath).length).toBe(1);
    await expect(page.getByRole('status').filter({ hasText: 'synced at' })).toBeVisible();
    await page.clock.fastForward(10_500);
    const before = fixture.calls.length;
    await refocus(page);
    await expect.poll(() => fixture.calls.slice(before).filter(call => call.path === '/api/execution/runs').length).toBe(1);
    expect(fixture.calls.slice(before).filter(call => call.path === refreshPath)).toHaveLength(1);
    await expect(page.getByRole('status').filter({ hasText: 'synced at' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'sync failed' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('import untracked GitHub issues (#281)', () => {
  const open = async (page: import('@playwright/test').Page) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Import issues…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import GitHub issues' });
    await expect(dialog.getByText('Every open issue in example/other (0) already has a work item.')).toBeVisible();
    await dialog.getByLabel('Repository').selectOption('example/studio');
    await expect(dialog.getByText('3 of 4 open issues are not in the graph.')).toBeVisible();
    return dialog;
  };

  test('selects candidates, reviews the staged proposal with evidence, and approves nodes with their edges', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const fixture = await mockWorkspace(page);
    const dialog = await open(page);

    // Included repos come from Settings; the excluded one is not offered.
    await expect(dialog.getByLabel('Repository').locator('option')).toHaveText(['example/other', 'example/studio']);
    await expect(dialog.locator('tbody tr')).toHaveCount(3);
    await expect(dialog.locator('tbody tr').first()).toContainText('studio-902');
    await expect(dialog.getByLabel('Select issue #77')).toBeDisabled();
    await expect(dialog.getByText('ID studio-77 is already used by "Hand-made"')).toBeVisible();
    const review = dialog.getByRole('button', { name: /Review import/ });
    await expect(review).toBeDisabled();

    await dialog.getByLabel('Select issue #901').check();
    await expect(review).toHaveText('Review import (1)');
    await dialog.getByLabel('Select all issues').check();
    await expect(review).toHaveText('Review import (2)');
    await expect(dialog.getByLabel('Select issue #77')).not.toBeChecked();
    await review.click();

    const staged = fixture.calls.filter(call => call.path === '/api/agent/proposals/import');
    expect(staged).toHaveLength(1);
    expect(staged[0].body).toEqual({ repo: 'example/studio', issue_numbers: [902, 901] });
    await expect(dialog).toHaveCount(0);

    const overlay = page.getByRole('dialog', { name: 'Proposal review' });
    await expect(overlay.getByRole('heading', { name: 'Import GitHub issues' })).toBeVisible();
    await expect(overlay.locator('.node-title')).toHaveText(['First untracked', 'Second untracked']);
    await expect(overlay.locator('.scope-hint').last()).toHaveText('Scope of 902');
    await expect(overlay.locator('.status-pill', { hasText: 'from issue text' })).toHaveCount(2);
    await expect(overlay.locator('.status-pill', { hasText: 'model-inferred' })).toHaveCount(0);
    await expect(overlay.locator('.evidence-quote')).toHaveText(['example/studio#901 Blocked by #902', 'example/studio#902 Depends on #901']);
    await expect(overlay.locator('.mutation-error')).toHaveText('Cannot be applied: depends_on edge would create a cycle: studio-901 -> studio-902 -> studio-901');
    await expect(overlay.getByRole('button', { name: 'Revise' })).toHaveCount(0);

    // The edge that failed validation starts unticked; everything else is ticked.
    const box = (id: string) => overlay.locator('.proposal-card', { has: page.locator('strong', { hasText: new RegExp(`^${id}$`) }) }).getByRole('checkbox');
    const approve = overlay.getByRole('button', { name: /^Approve/ });
    await expect(box('e2')).not.toBeChecked();
    await expect(approve).toHaveText('Approve 3 selected');

    // Unticking a node unticks its edge; ticking the edge brings the node back.
    await box('n902').uncheck();
    await expect(box('e1')).not.toBeChecked();
    await expect(approve).toHaveText('Approve 1 selected');
    await box('e1').check();
    await expect(box('n902')).toBeChecked();
    await expect(approve).toHaveText('Approve 3 selected');

    const graphLoads = () => fixture.calls.filter(call => call.path === '/api/graph').length;
    const before = graphLoads();
    await approve.click();
    await expect(overlay).toHaveCount(0);
    const approvals = fixture.calls.filter(call => call.path === '/api/agent/proposals/approve');
    expect(approvals).toHaveLength(1);
    expect(approvals[0].body).toEqual({ proposal_id: 'prop_import', approved_mutation_ids: ['n901', 'n902', 'e1'] });
    await expect.poll(graphLoads).toBeGreaterThan(before);
    expect(errors).toEqual([]);
  });

  test('discards a staged import on the server without asking the planner', async ({ page }) => {
    const fixture = await mockWorkspace(page);
    const dialog = await open(page);
    await dialog.getByLabel('Select issue #901').check();
    await dialog.getByRole('button', { name: /Review import/ }).click();

    const overlay = page.getByRole('dialog', { name: 'Proposal review' });
    await overlay.getByRole('button', { name: 'Discard import' }).click();
    await expect(overlay).toHaveCount(0);
    expect(fixture.calls.filter(call => call.path === '/api/agent/proposals/dismiss')).toHaveLength(1);
    expect(fixture.calls.filter(call => call.path === '/api/agent/message')).toHaveLength(0);
    expect(fixture.calls.filter(call => call.path === '/api/agent/proposals/approve')).toHaveLength(0);
  });

  test('shows a GitHub failure in the dialog and stages nothing', async ({ page }) => {
    const fixture = await mockWorkspace(page, { untracked: 'fail' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Import issues…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import GitHub issues' });
    await expect(dialog.getByRole('alert')).toContainText('gh command timed out');
    await expect(dialog.getByRole('button', { name: /Review import/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(fixture.calls.filter(call => call.path === '/api/agent/proposals/import')).toHaveLength(0);
  });

  test('lists repos included in Settings in the Planning repo filter, even with no work items', async ({ page }) => {
    await mockWorkspace(page);
    await page.goto('/');
    const repoFilter = page.locator('.toolbar select').first();
    await expect(repoFilter.locator('option')).toHaveText(['All', 'example/other', 'example/studio']);
  });
});

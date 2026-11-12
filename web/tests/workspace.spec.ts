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

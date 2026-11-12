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

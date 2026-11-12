import type { Page } from "@playwright/test";
export async function mockWorkspace(page: Page) {
  const item = { id: "studio-900", name: "Improve the workspace", kind: "issue", state: "drafting", repo: "example/studio", issue_number: 900, issue_url: "https://example.com/issues/900", predicted_files: [], actual_files: [], meta: {} };
  let run = { run_id: "exec_test", work_item_id: item.id, work_item_name: item.name, status: "disambiguating", phase: "awaiting_confirmation", repo: item.repo, branch: "studio-900-branch", base_ref: "develop", worktree_path: "/tmp/example", created_at: "2026-09-06T10:00:00Z", activity_log: [{ kind: "agent_message", message: "Refinement is ready for review.", timestamp: "2026-09-06T10:00:00Z" }], safety_checks: [], refinement: { items: [{ id: "q1", kind: "question", prompt: "Which implementation should we use?", options: [{ id: "safe", label: "Small change" }, { id: "broad", label: "Broader change" }], allow_other: true, response: null }], summary: "Ready for review" } };
  const calls: Array<{ path: string; body: any }> = [];
  let failRuns = false;
  await page.addInitScript(() => {
    const streams: any[] = [];
    (window as any).__streams = streams;
    class MockEventSource extends EventTarget {
      url: string; closed = false;
      constructor(url: string) { super(); this.url = url; streams.push(this); setTimeout(() => this.dispatchEvent(new Event("open")), 0); }
      close() { this.closed = true; }
    }
    (window as any).EventSource = MockEventSource;
  });
  await page.route(/\/(api\/|health)/, async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    calls.push({ path, body });
    let payload: any = [];
    if (path === '/health') payload = { ok: true };
    else if (path === '/api/graph') payload = { items: [item], edges: [], filters: {}, graph_version: '1' };
    else if (path === '/api/work-items') payload = [item];
    else if (path === '/api/work-items/studio-900') payload = item;
    else if (path === '/api/frontier') payload = [{ id: item.id }];
    else if (path === '/api/agent/session') payload = { session_id: 'test-planner', is_streaming: false, messages: [{ id: 'm1', role: 'assistant', content: 'Hello **planner** <img src=x onerror="window.__xss=true">', timestamp: '2026-09-06T10:00:00Z' }] };
    else if (path === '/api/plans/studio-900/approve') { item.state = 'ready'; payload = { metadata: { state: 'ready' } }; }
    else if (path === '/api/plans/studio-900') payload = { metadata: { state: item.state }, scratchpad_content: '# Workspace plan\n\n- [ ] Implement changes' };
    else if (path === '/api/execution/eligibility') payload = { work_item_id: item.id, issue_backed: true, can_launch: item.state === 'ready', launch_unavailable_reason: 'Approve the plan first.', dispatch_node: { id: item.id }, safety_checks: [] };
    else if (path === '/api/execution/preview') payload = { groups: [], summary: { dispatchable_now: 0 }, assumptions: [], validation_policy: {} };
    else if (path === '/api/execution/runs') {
      if (failRuns) return route.fulfill({ status: 503, json: { message: 'Temporary sync failure' } });
      payload = [run];
    }
    else if (path.endsWith('/checklist')) payload = { run_id: run.run_id, total: 1, completed: 0, items: [] };
    else if (path.endsWith('/scratchpad')) payload = { content: '# Scratchpad\n\n<img src=x onerror="window.__xss=true">' };
    else if (path === '/api/execution/resolve-disambiguation') { run = { ...run, status: 'running', phase: 'coding' }; payload = { resolved: true, run }; }
    else if (path === '/api/github/issue') payload = { title: item.name, body: 'Work item', state: 'OPEN' };
    await route.fulfill({ json: payload });
  });
  return { calls, failRuns: (value: boolean) => { failRuns = value; } };
}

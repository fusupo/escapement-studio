const jsonHeaders = {
  "content-type": "application/json",
};

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof payload === "string"
      ? payload
      : payload?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

export function getHealth() {
  return request("/health");
}

export function getPlannerSessionSnapshot() {
  return request("/api/agent/session");
}

export function sendAgentMessage(payload) {
  return request("/api/agent/message", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function approveMutationProposal(payload) {
  return request("/api/agent/proposals/approve", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function dismissActiveProposals() {
  return request("/api/agent/proposals/dismiss", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({}),
  });
}

export function approveMemoryChange(payload) {
  return request("/api/agent/memory/approve", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function approveGitHubSync(payload) {
  return request("/api/agent/github/approve", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function getGitHubIssueDetails({ repo, issue_number }) {
  const query = new URLSearchParams({ repo, issue_number: String(issue_number) });
  return request(`/api/github/issue?${query.toString()}`);
}

export function getPullRequestDetails({ repo, pull_request_number }) {
  const query = new URLSearchParams({ repo, pull_request_number: String(pull_request_number) });
  return request(`/api/github/pull-request?${query.toString()}`);
}

export function closeGitHubIssue({ repo, issue_number }) {
  return request("/api/github/issue/close", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ repo, issue_number }),
  });
}

export function getExecutionPreview(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      query.set(key, value);
    }
  }

  const search = query.toString();
  return request(`/api/execution/preview${search ? `?${search}` : ""}`);
}

export function listExecutionRuns() {
  return request("/api/execution/runs");
}

export function launchExecutionRun(payload) {
  return request("/api/execution/launch", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function openPullRequest(payload) {
  return request("/api/execution/pull-request", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function sendFollowUpMessage(payload) {
  return request("/api/execution/follow-up", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function getRunChatHistory(runId) {
  return request(`/api/execution/runs/${encodeURIComponent(runId)}/chat`);
}

export function resolveDisambiguation(payload) {
  return request("/api/execution/resolve-disambiguation", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function getReconciliationReports(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      query.set(key, value);
    }
  }

  const search = query.toString();
  return request(`/api/reconciliation/reports${search ? `?${search}` : ""}`);
}

export function getGraph(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return request(`/api/graph${query ? `?${query}` : ""}`);
}

export function listWorkItems(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      query.set(key, value);
    }
  }

  const search = query.toString();
  return request(`/api/work-items${search ? `?${search}` : ""}`);
}

export function createWorkItem(payload) {
  return request("/api/work-items", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function updateWorkItem(id, payload) {
  return request(`/api/work-items/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function createEdge(payload) {
  return request("/api/edges", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function deleteEdge(id) {
  return request(`/api/edges/${id}`, {
    method: "DELETE",
  });
}

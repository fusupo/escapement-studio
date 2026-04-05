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

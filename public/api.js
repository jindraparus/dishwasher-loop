export function getDashboard() {
  return request("/api/dashboard");
}

export function saveCapsuleCount(count) {
  return request("/api/supplies/capsules", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
  });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : null;
  if (!response.ok) {
    throw new Error(body?.error || `Request failed with status ${response.status}`);
  }
  return body;
}

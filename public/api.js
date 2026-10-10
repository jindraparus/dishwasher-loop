export function getDashboard() {
  return request("/api/dashboard");
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

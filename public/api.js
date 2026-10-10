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
  if (!isJson) {
    throw new Error(
      "Server vrátil neočekávanou odpověď. Obnovte stránku a znovu se přihlaste.",
    );
  }
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error || `Požadavek selhal se stavem ${response.status}`);
  }
  return body;
}

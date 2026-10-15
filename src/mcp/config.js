const AZURE_SETTINGS = [
  "DISHWASHER_LOOP_AZURE_BASE_URL",
  "DISHWASHER_LOOP_ENTRA_TENANT_ID",
  "DISHWASHER_LOOP_ENTRA_CLIENT_ID",
  "DISHWASHER_LOOP_ENTRA_SCOPE",
];

export function loadMcpConfig(env = process.env) {
  const target = env.DISHWASHER_LOOP_TARGET?.trim().toLowerCase();
  if (!target) {
    throw new Error(
      "DISHWASHER_LOOP_TARGET is required. Set it to local or azure.",
    );
  }
  if (!["local", "azure"].includes(target)) {
    throw new Error(
      `Unsupported DISHWASHER_LOOP_TARGET "${target}". Use local or azure.`,
    );
  }

  if (target === "local") {
    const configuredAzureSettings = AZURE_SETTINGS.filter((name) => env[name]);
    if (configuredAzureSettings.length > 0) {
      throw new Error(
        `Azure settings cannot be used with DISHWASHER_LOOP_TARGET=local: `
        + configuredAzureSettings.join(", "),
      );
    }
    return {
      target,
      baseUrl: env.DISHWASHER_LOOP_BASE_URL || "http://localhost:3000",
    };
  }

  if (env.DISHWASHER_LOOP_BASE_URL) {
    throw new Error(
      "DISHWASHER_LOOP_BASE_URL is only valid for the local target. "
      + "Use DISHWASHER_LOOP_AZURE_BASE_URL for the azure target.",
    );
  }
  const missing = AZURE_SETTINGS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Azure MCP settings: ${missing.join(", ")}`,
    );
  }

  const baseUrl = parseAzureBaseUrl(env.DISHWASHER_LOOP_AZURE_BASE_URL);
  return {
    target,
    baseUrl: baseUrl.href,
    tenantId: env.DISHWASHER_LOOP_ENTRA_TENANT_ID,
    clientId: env.DISHWASHER_LOOP_ENTRA_CLIENT_ID,
    scope: env.DISHWASHER_LOOP_ENTRA_SCOPE,
  };
}

function parseAzureBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(
      `Invalid DISHWASHER_LOOP_AZURE_BASE_URL: ${value}`,
      { cause: error },
    );
  }
  if (url.protocol !== "https:") {
    throw new Error("DISHWASHER_LOOP_AZURE_BASE_URL must use https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "DISHWASHER_LOOP_AZURE_BASE_URL must not contain credentials, a query, or a fragment.",
    );
  }
  return url;
}

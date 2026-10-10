const required = [
  "HOME_CONNECT_CLIENT_ID",
  "HOME_CONNECT_CLIENT_SECRET",
  "HOME_CONNECT_REDIRECT_URI",
  "COOKIE_SECRET",
  "AZURE_STORAGE_CONNECTION_STRING",
];

export function loadConfig(env = process.env) {
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (env.COOKIE_SECRET.length < 32) {
    throw new Error("COOKIE_SECRET must contain at least 32 characters");
  }

  const requireMicrosoftAuth = env.REQUIRE_MICROSOFT_AUTH?.toLowerCase() === "true";
  const allowedPrincipalIds = parseList(
    env.APP_ALLOWED_PRINCIPAL_IDS || env.APP_ALLOWED_PRINCIPAL_ID || "",
    (value) => value.toLowerCase(),
  );
  if (requireMicrosoftAuth && allowedPrincipalIds.length === 0 && !env.APP_ALLOWED_EMAIL) {
    throw new Error(
      "APP_ALLOWED_PRINCIPAL_IDS or APP_ALLOWED_EMAIL is required when REQUIRE_MICROSOFT_AUTH=true",
    );
  }

  return {
    clientId: env.HOME_CONNECT_CLIENT_ID,
    clientSecret: env.HOME_CONNECT_CLIENT_SECRET,
    redirectUri: env.HOME_CONNECT_REDIRECT_URI,
    cookieSecret: env.COOKIE_SECRET,
    storageConnectionString: env.AZURE_STORAGE_CONNECTION_STRING,
    tableName: env.AZURE_TABLE_NAME || "DishwasherLoop",
    port: Number.parseInt(env.PORT || "3000", 10),
    homeConnectBaseUrl: env.HOME_CONNECT_BASE_URL || "https://api.home-connect.com",
    requireMicrosoftAuth,
    allowedPrincipalIds,
    allowedEmail: env.APP_ALLOWED_EMAIL?.trim().toLowerCase() || "",
    persistedEventTypes: parseList(
      env.HOME_CONNECT_EVENT_TYPES || "STATUS,EVENT,NOTIFY",
      (value) => value.toUpperCase(),
    ),
    persistedEventKeys: parseList(env.HOME_CONNECT_EVENT_KEYS || ""),
  };
}

function parseList(value, transform = (item) => item) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(transform);
}

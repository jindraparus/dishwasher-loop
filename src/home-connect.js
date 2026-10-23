const AUTHORIZATION_PATH = "/security/oauth/authorize";
const TOKEN_PATH = "/security/oauth/token";
const APPLIANCES_PATH = "/api/homeappliances";

export class HomeConnectClient {
  constructor(config, storage, fetchImplementation = fetch) {
    this.config = config;
    this.storage = storage;
    this.fetch = fetchImplementation;
    this.refreshPromise = null;
  }

  getAuthorizationUrl(state) {
    const url = new URL(AUTHORIZATION_PATH, this.config.homeConnectBaseUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: "IdentifyAppliance Dishwasher-Monitor",
      state,
    });
    return url.toString();
  }

  async exchangeCode(code) {
    const tokens = await this.requestTokens({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
    });
    await this.storage.saveTokens(tokens);
    return tokens;
  }

  async getAccessToken(forceRefresh = false) {
    const tokens = await this.storage.getTokens();
    if (!tokens) {
      throw new AuthenticationRequiredError();
    }

    if (!forceRefresh && tokens.expiresAt > Date.now() + 60_000) {
      return tokens.accessToken;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshTokens(tokens.refreshToken).finally(() => {
        this.refreshPromise = null;
      });
    }
    const refreshed = await this.refreshPromise;
    return refreshed.accessToken;
  }

  async listDishwashers(signal) {
    const response = await this.authenticatedFetch(APPLIANCES_PATH, { signal });
    const body = await parseJsonResponse(response);
    return (body.data?.homeappliances || []).filter(
      (appliance) => appliance.type?.toLowerCase() === "dishwasher",
    );
  }

  async getApplianceStatus(applianceId, signal) {
    const response = await this.authenticatedFetch(
      `${APPLIANCES_PATH}/${encodeURIComponent(applianceId)}/status`,
      { signal },
    );
    const body = await parseJsonResponse(response);
    if (!Array.isArray(body.data?.status)) {
      throw new Error("Home Connect vrátil neplatný stav spotřebiče");
    }
    return body.data.status;
  }

  async openEventStream(applianceId, signal) {
    return this.authenticatedFetch(
      `${APPLIANCES_PATH}/${encodeURIComponent(applianceId)}/events`,
      { headers: { Accept: "text/event-stream" }, signal },
    );
  }

  async authenticatedFetch(path, options = {}) {
    let accessToken = await this.getAccessToken();
    let response = await this.fetch(new URL(path, this.config.homeConnectBaseUrl), {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status === 401) {
      accessToken = await this.getAccessToken(true);
      response = await this.fetch(new URL(path, this.config.homeConnectBaseUrl), {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${accessToken}`,
        },
      });
    }

    if (!response.ok) {
      throw await homeConnectResponseError(response);
    }
    return response;
  }

  async refreshTokens(refreshToken) {
    const tokens = await this.requestTokens({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }, refreshToken);
    await this.storage.saveTokens(tokens);
    return tokens;
  }

  async requestTokens(parameters, previousRefreshToken = "") {
    const response = await this.fetch(
      new URL(TOKEN_PATH, this.config.homeConnectBaseUrl),
      {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...parameters,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      },
    );
    if (!response.ok) {
      throw await homeConnectResponseError(response, "token");
    }
    const body = await parseJsonResponse(response);
    if (!body.access_token || !(body.refresh_token || previousRefreshToken) || !body.expires_in) {
      throw new Error("Home Connect vrátil neúplnou odpověď s tokenem");
    }

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || previousRefreshToken,
      expiresAt: Date.now() + Number(body.expires_in) * 1000,
    };
  }
}

export class HomeConnectError extends Error {
  constructor(status, error, operation = "api", retryAfterMs = 0) {
    const offline = status === 409
      && error?.key === "SDK.Error.HomeAppliance.Connection.Initialization.Failed"
      && error?.description === "HomeAppliance is offline";
    super(`Požadavek Home Connect selhal (${status})${offline ? ": HomeAppliance is offline" : ""}`);
    this.name = "HomeConnectError";
    this.status = status;
    this.operation = operation;
    this.offline = offline;
    this.retryAfterMs = retryAfterMs;
  }
}

export function homeConnectFailureKind(error) {
  if (error instanceof AuthenticationRequiredError
    || (error instanceof HomeConnectError
      && ([401, 403].includes(error.status)
        || (error.operation === "token" && error.status === 400)))) {
    return "authentication";
  }
  if (error instanceof HomeConnectError && error.offline) {
    return "appliance_offline";
  }
  return "api";
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Je vyžadována autorizace Home Connect");
    this.name = "AuthenticationRequiredError";
  }
}

async function homeConnectResponseError(response, operation = "api") {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON error pages are API failures, never appliance-offline evidence.
  }
  return new HomeConnectError(response.status, body?.error, operation, retryAfterMilliseconds(response));
}

function retryAfterMilliseconds(response) {
  const value = response.headers.get("Retry-After");
  if (!value) return 0;
  const milliseconds = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.min(2_147_483_647, Math.max(0, milliseconds)) : 0;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Home Connect vrátil neplatný JSON (${response.status})`);
  }
}

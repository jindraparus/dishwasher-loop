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

  async listDishwashers() {
    const response = await this.authenticatedFetch(APPLIANCES_PATH);
    const body = await parseJsonResponse(response);
    return (body.data?.homeappliances || []).filter(
      (appliance) => appliance.type?.toLowerCase() === "dishwasher",
    );
  }

  async getApplianceStatus(applianceId) {
    const response = await this.authenticatedFetch(
      `${APPLIANCES_PATH}/${encodeURIComponent(applianceId)}/status`,
    );
    const body = await parseJsonResponse(response);
    return body.data?.status || [];
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
      const detail = await response.text();
      throw new Error(`Home Connect request failed (${response.status}): ${detail}`);
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
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...parameters,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      },
    );
    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        `Home Connect token request failed (${response.status}): ${JSON.stringify(body)}`,
      );
    }
    if (!body.access_token || !(body.refresh_token || previousRefreshToken) || !body.expires_in) {
      throw new Error("Home Connect returned an incomplete token response");
    }

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || previousRefreshToken,
      expiresAt: Date.now() + Number(body.expires_in) * 1000,
    };
  }
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Home Connect authorization is required");
    this.name = "AuthenticationRequiredError";
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Home Connect returned invalid JSON (${response.status})`);
  }
}

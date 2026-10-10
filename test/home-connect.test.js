import assert from "node:assert/strict";
import test from "node:test";
import { HomeConnectClient } from "../src/home-connect.js";

const config = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://example.test/auth/callback",
  homeConnectBaseUrl: "https://api.home-connect.test",
};

test("requests the minimum dishwasher monitoring scopes", () => {
  const client = new HomeConnectClient(config, {});
  const url = new URL(client.getAuthorizationUrl("state-value"));

  assert.equal(url.pathname, "/security/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), "IdentifyAppliance Dishwasher-Monitor");
  assert.equal(url.searchParams.get("state"), "state-value");
});

test("keeps the existing refresh token when refresh response omits one", async () => {
  let savedTokens;
  const storage = {
    getTokens: async () => ({
      accessToken: "expired",
      refreshToken: "existing-refresh-token",
      expiresAt: 0,
    }),
    saveTokens: async (tokens) => {
      savedTokens = tokens;
    },
  };
  const fetchImplementation = async () => new Response(JSON.stringify({
    access_token: "new-access-token",
    expires_in: 3600,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const client = new HomeConnectClient(config, storage, fetchImplementation);

  assert.equal(await client.getAccessToken(), "new-access-token");
  assert.equal(savedTokens.refreshToken, "existing-refresh-token");
});

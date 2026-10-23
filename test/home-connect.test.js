import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthenticationRequiredError,
  HomeConnectClient,
  HomeConnectError,
  homeConnectFailureKind,
} from "../src/home-connect.js";

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

const offlineError = {
  key: "SDK.Error.HomeAppliance.Connection.Initialization.Failed",
  description: "HomeAppliance is offline",
};

test("only classifies the confirmed offline response as appliance offline", () => {
  assert.equal(homeConnectFailureKind(new HomeConnectError(409, offlineError)), "appliance_offline");
  for (const error of [
    new HomeConnectError(503, offlineError),
    new HomeConnectError(409, { ...offlineError, description: "Initialization failed" }),
    new HomeConnectError(409, { key: "Other", description: "HomeAppliance is offline" }),
    new Error("HomeAppliance is offline"),
  ]) {
    assert.equal(homeConnectFailureKind(error), "api");
  }
  assert.equal(homeConnectFailureKind(new AuthenticationRequiredError()), "authentication");
  assert.equal(homeConnectFailureKind(new HomeConnectError(401)), "authentication");
  assert.equal(homeConnectFailureKind(new HomeConnectError(403)), "authentication");
  assert.equal(homeConnectFailureKind(new HomeConnectError(400, {}, "token")), "authentication");
  assert.equal(homeConnectFailureKind(new HomeConnectError(503, {}, "token")), "api");
});

test("HTTP errors carry classification without exposing response secrets", async () => {
  for (const body of [
    JSON.stringify({ error: offlineError, secret: "do-not-log-me" }),
    "<html>do-not-log-me</html>",
  ]) {
    const client = new HomeConnectClient(config, {
      getTokens: async () => ({ accessToken: "secret-token", expiresAt: Date.now() + 3_600_000 }),
    }, async () => new Response(body, { status: 409 }));
    await assert.rejects(client.getApplianceStatus("dishwasher"), (error) => {
      assert.ok(error instanceof HomeConnectError);
      assert.equal(error.offline, body.startsWith("{"));
      assert.doesNotMatch(error.message, /do-not-log-me|secret-token/);
      return true;
    });
  }
});

test("a malformed status response cannot establish recovery", async () => {
  const client = new HomeConnectClient(config, {
    getTokens: async () => ({ accessToken: "token", expiresAt: Date.now() + 3_600_000 }),
  }, async () => new Response('{"data":{}}'));
  await assert.rejects(client.getApplianceStatus("dishwasher"), /neplatný stav/);
});

test("status checks pass cancellation to the HTTP request", async () => {
  const signal = new AbortController().signal;
  const client = new HomeConnectClient(config, {
    getTokens: async () => ({ accessToken: "token", expiresAt: Date.now() + 3_600_000 }),
  }, async (url, options) => {
    assert.equal(options.signal, signal);
    return new Response('{"data":{"status":[]}}');
  });
  assert.deepEqual(await client.getApplianceStatus("dishwasher", signal), []);
});

test("token failures do not expose returned tokens or credentials", async () => {
  const client = new HomeConnectClient(config, {}, async () => new Response(JSON.stringify({
    error: "invalid_grant",
    error_description: "do-not-log-me",
    access_token: "secret-token",
  }), { status: 400 }));
  await assert.rejects(client.refreshTokens("refresh-secret"), (error) => {
    assert.equal(homeConnectFailureKind(error), "authentication");
    assert.doesNotMatch(error.message, /do-not-log-me|secret-token|refresh-secret/);
    return true;
  });
});

test("preserves Retry-After durations without including response contents", async (t) => {
  const now = Date.parse("2026-10-23T18:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  for (const [header, expected] of [
    ["1800", 1_800_000],
    ["Fri, 23 Oct 2026 18:30:00 GMT", 1_800_000],
    ["not-a-date", 0],
  ]) {
    const client = new HomeConnectClient(config, {
      getTokens: async () => ({ accessToken: "token", expiresAt: now + 3_600_000 }),
    }, async () => new Response('{"error":{"key":"429"}}', {
      status: 429, headers: { "Retry-After": header },
    }));
    await assert.rejects(client.getApplianceStatus("dishwasher"), (error) => {
      assert.equal(error.retryAfterMs, expected);
      assert.equal(homeConnectFailureKind(error), "api");
      return true;
    });
  }
  const client = new HomeConnectClient(config, {}, async () => new Response("rate limited", {
    status: 429, headers: { "Retry-After": "1800" },
  }));
  await assert.rejects(client.refreshTokens("refresh-secret"), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.operation, "token");
    assert.equal(error.retryAfterMs, 1_800_000);
    return true;
  });
});

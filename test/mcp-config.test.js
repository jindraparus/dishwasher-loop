import assert from "node:assert/strict";
import test from "node:test";
import { AzureTokenProvider } from "../src/mcp/azure-auth.js";
import { loadMcpConfig } from "../src/mcp/config.js";

test("requires an explicit supported MCP target", () => {
  assert.throws(() => loadMcpConfig({}), /DISHWASHER_LOOP_TARGET is required/);
  assert.throws(
    () => loadMcpConfig({ DISHWASHER_LOOP_TARGET: "automatic" }),
    /Unsupported DISHWASHER_LOOP_TARGET/,
  );
});

test("loads local target without Azure authentication settings", () => {
  assert.deepEqual(loadMcpConfig({
    DISHWASHER_LOOP_TARGET: "local",
  }), {
    target: "local",
    baseUrl: "http://localhost:3000",
  });
  assert.throws(() => loadMcpConfig({
    DISHWASHER_LOOP_TARGET: "local",
    DISHWASHER_LOOP_ENTRA_CLIENT_ID: "client-id",
  }), /Azure settings cannot be used/);
});

test("requires complete and HTTPS-only Azure target settings", () => {
  assert.throws(() => loadMcpConfig({
    DISHWASHER_LOOP_TARGET: "azure",
  }), /Missing required Azure MCP settings/);
  assert.throws(() => loadMcpConfig(azureEnvironment({
    DISHWASHER_LOOP_AZURE_BASE_URL: "http://dishwasher.example",
  })), /must use https/);
  assert.throws(() => loadMcpConfig({
    ...azureEnvironment(),
    DISHWASHER_LOOP_BASE_URL: "http://localhost:3000",
  }), /only valid for the local target/);

  assert.deepEqual(loadMcpConfig(azureEnvironment()), {
    target: "azure",
    baseUrl: "https://dishwasher.example/",
    tenantId: "tenant-id",
    clientId: "public-client-id",
    scope: "api://api-client-id/Dishwasher.Read",
  });
});

test("Azure token provider returns only a current delegated access token", async () => {
  const provider = new AzureTokenProvider({
    scope: "api://api-client-id/Dishwasher.Read",
    credential: {
      async getToken(scope) {
        assert.equal(scope, "api://api-client-id/Dishwasher.Read");
        return {
          token: "access-token",
          expiresOnTimestamp: 2_000,
        };
      },
    },
    now: () => 1_000,
  });
  assert.equal(await provider.getAccessToken(), "access-token");
});

test("Azure token provider reports cancellation and expiry without exposing token data", async (t) => {
  await t.test("cancellation", async () => {
    const provider = new AzureTokenProvider({
      scope: "scope",
      credential: {
        async getToken() {
          const error = new Error("user_cancelled");
          error.errorCode = "user_cancelled";
          throw error;
        },
      },
    });
    await assert.rejects(provider.getAccessToken(), /sign-in was canceled/);
  });

  await t.test("expired token", async () => {
    const provider = new AzureTokenProvider({
      scope: "scope",
      credential: {
        async getToken() {
          return {
            token: "must-not-appear-in-the-error",
            expiresOnTimestamp: 999,
          };
        },
      },
      now: () => 1_000,
    });
    await assert.rejects(
      provider.getAccessToken(),
      (error) => /has expired/.test(error.message)
        && !error.message.includes("must-not-appear"),
    );
  });
});

function azureEnvironment(overrides = {}) {
  return {
    DISHWASHER_LOOP_TARGET: "azure",
    DISHWASHER_LOOP_AZURE_BASE_URL: "https://dishwasher.example",
    DISHWASHER_LOOP_ENTRA_TENANT_ID: "tenant-id",
    DISHWASHER_LOOP_ENTRA_CLIENT_ID: "public-client-id",
    DISHWASHER_LOOP_ENTRA_SCOPE: "api://api-client-id/Dishwasher.Read",
    ...overrides,
  };
}

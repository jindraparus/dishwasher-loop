import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const baseEnvironment = {
  HOME_CONNECT_CLIENT_ID: "client-id",
  HOME_CONNECT_CLIENT_SECRET: "client-secret",
  HOME_CONNECT_REDIRECT_URI: "https://example.test/auth/callback",
  COOKIE_SECRET: "a-secret-containing-at-least-32-characters",
  AZURE_STORAGE_CONNECTION_STRING: "local",
  REQUIRE_MICROSOFT_AUTH: "true",
};

test("parses a normalized principal ID allowlist", () => {
  const config = loadConfig({
    ...baseEnvironment,
    APP_ALLOWED_PRINCIPAL_IDS: "FIRST-ID, second-id ",
  });

  assert.deepEqual(config.allowedPrincipalIds, ["first-id", "second-id"]);
});

test("accepts the legacy singular principal ID setting", () => {
  const config = loadConfig({
    ...baseEnvironment,
    APP_ALLOWED_PRINCIPAL_ID: "LEGACY-ID",
  });

  assert.deepEqual(config.allowedPrincipalIds, ["legacy-id"]);
});

test("uses the Czech timezone for cycle statistics by default", () => {
  const config = loadConfig({
    ...baseEnvironment,
    APP_ALLOWED_PRINCIPAL_ID: "principal-id",
  });

  assert.equal(config.cycleTimezone, "Europe/Prague");
});

test("rejects an invalid cycle statistics timezone", () => {
  assert.throws(() => loadConfig({
    ...baseEnvironment,
    APP_ALLOWED_PRINCIPAL_ID: "principal-id",
    CYCLE_TIMEZONE: "not-a-timezone",
  }), /Invalid CYCLE_TIMEZONE/);
});

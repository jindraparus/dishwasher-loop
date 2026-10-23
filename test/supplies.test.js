import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { capsuleSettingsRouter } from "../src/supplies.js";
import { requireAllowedMicrosoftUser } from "../src/microsoft-auth.js";

test("capsule API validates, protects browser writes, and reports failures", async (t) => {
  let count = 50;
  let fail = false;
  const storage = {
    async setCapsuleCount(value) {
      if (!Number.isInteger(value) || value < 0 || value > 999) throw new RangeError("Invalid count");
      if (fail) throw new Error("Storage failed");
      count = value;
      return count;
    },
  };
  const config = { redirectUri: "http://localhost:3000/auth/callback", requireMicrosoftAuth: true,
    allowedPrincipalIds: ["allowed"] };
  const app = express();
  app.use(requireAllowedMicrosoftUser(config));
  app.use(capsuleSettingsRouter(storage, config));
  app.use((error, request, response, next) => response.status(500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/supplies/capsules`;
  const validHeaders = { "Content-Type": "application/json", Origin: "http://localhost:3000",
    Cookie: "AppServiceAuthSession=session", "x-ms-client-principal-id": "allowed" };
  const request = (body, headers = validHeaders) => fetch(url, {
    method: "PUT", headers, body: JSON.stringify(body),
  });
  assert.equal((await request({ capsuleCount: 75 })).status, 200);
  assert.equal(count, 75);
  for (const value of [-1, 1000, 1.5, "20", null]) {
    assert.equal((await request({ capsuleCount: value })).status, 400);
  }
  assert.equal((await request({})).status, 400);
  assert.equal((await request({ capsuleCount: 10 }, { ...validHeaders, Origin: "https://evil.example" })).status, 403);
  assert.equal((await request({ capsuleCount: 10 }, { ...validHeaders, Origin: "" })).status, 403);
  assert.equal((await request({ capsuleCount: 10 }, { ...validHeaders, Authorization: "Bearer read" })).status, 403);
  assert.equal((await request({ capsuleCount: 10 }, { ...validHeaders, Cookie: "" })).status, 403);
  assert.equal((await request({ capsuleCount: 10 }, { ...validHeaders, "x-ms-client-principal-id": "other" })).status, 403);
  assert.equal((await request({ capsuleCount: 10 }, { ...validHeaders, "x-ms-client-principal-id": "" })).status, 401);
  assert.equal((await request({ capsuleCount: 10 }, { ...validHeaders, "Content-Type": "text/plain" })).status, 415);
  assert.equal((await fetch(url, { method: "PUT", headers: validHeaders, body: "{" })).status, 400);
  fail = true;
  assert.equal((await request({ capsuleCount: 10 })).status, 500);
  assert.equal(count, 75);
  config.requireMicrosoftAuth = false;
  fail = false;
  assert.equal((await request({ capsuleCount: 20 }, {
    "Content-Type": "application/json", Origin: "http://localhost:3000",
  })).status, 200);
  assert.equal(count, 20);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  getMicrosoftUserEmail,
  requireAllowedMicrosoftUser,
} from "../src/microsoft-auth.js";

test("extracts and normalizes the email claim supplied by App Service", () => {
  const principal = Buffer.from(JSON.stringify({
    claims: [
      { typ: "name", val: "Example User" },
      { typ: "email", val: "JParus@Gmail.com" },
    ],
  })).toString("base64");

  assert.equal(getMicrosoftUserEmail({
    "x-ms-client-principal": principal,
  }), "jparus@gmail.com");
});

test("allows only the configured Microsoft account", () => {
  const middleware = requireAllowedMicrosoftUser({
    requireMicrosoftAuth: true,
    allowedPrincipalIds: [],
    allowedEmail: "jparus@gmail.com",
  });
  let nextCalled = false;
  const response = fakeResponse();

  middleware({
    headers: { "x-ms-client-principal-name": "jparus@gmail.com" },
  }, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(response.statusCode, 200);
});

test("rejects a different authenticated Microsoft account", () => {
  const middleware = requireAllowedMicrosoftUser({
    requireMicrosoftAuth: true,
    allowedPrincipalIds: [],
    allowedEmail: "jparus@gmail.com",
  });
  const response = fakeResponse();

  middleware({
    headers: { "x-ms-client-principal-name": "someone@example.com" },
  }, response, () => assert.fail("Unauthorized user reached the application"));

  assert.equal(response.statusCode, 403);
  assert.equal(response.body, "This Microsoft account is not authorized.");
});

test("rejects requests without an App Service identity", () => {
  const middleware = requireAllowedMicrosoftUser({
    requireMicrosoftAuth: true,
    allowedPrincipalIds: [],
    allowedEmail: "jparus@gmail.com",
  });
  const response = fakeResponse();

  middleware({ headers: {} }, response, () => {
    assert.fail("Unauthenticated request reached the application");
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body, "Microsoft authentication is required.");
});

test("authorizes the configured Entra principal ID instead of an unreliable guest email", () => {
  const middleware = requireAllowedMicrosoftUser({
    requireMicrosoftAuth: true,
    allowedPrincipalIds: ["a8a21744-d15b-473c-8c50-aaa5c29bf189"],
    allowedEmail: "jparus@gmail.com",
  });
  let nextCalled = false;
  const response = fakeResponse();

  middleware({
    headers: {
      "x-ms-client-principal-id": "A8A21744-D15B-473C-8C50-AAA5C29BF189",
      "x-ms-client-principal-name": "jparus_gmail.com#EXT#@jparusgmail.onmicrosoft.com",
    },
  }, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test("does not fall back to email when a principal ID allowlist is configured", () => {
  const middleware = requireAllowedMicrosoftUser({
    requireMicrosoftAuth: true,
    allowedPrincipalIds: ["a8a21744-d15b-473c-8c50-aaa5c29bf189"],
    allowedEmail: "jparus@gmail.com",
  });
  const response = fakeResponse();

  middleware({
    headers: {
      "x-ms-client-principal-id": "someone-else",
      "x-ms-client-principal-name": "jparus@gmail.com",
    },
  }, response, () => assert.fail("Wrong principal ID reached the application"));

  assert.equal(response.statusCode, 403);
});

test("authorizes any principal in the configured allowlist", () => {
  const middleware = requireAllowedMicrosoftUser({
    requireMicrosoftAuth: true,
    allowedPrincipalIds: [
      "a8a21744-d15b-473c-8c50-aaa5c29bf189",
      "second-user-object-id",
    ],
    allowedEmail: "",
  });
  let nextCalled = false;

  middleware({
    headers: { "x-ms-client-principal-id": "second-user-object-id" },
  }, fakeResponse(), () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

function fakeResponse() {
  return {
    statusCode: 200,
    body: "",
    status(value) {
      this.statusCode = value;
      return this;
    },
    type() {
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };
}

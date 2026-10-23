import assert from "node:assert/strict";
import test from "node:test";
import { getDashboard, saveCapsuleCount } from "../public/api.js";

test("saves an absolute capsule count as JSON and surfaces API errors", async (t) => {
  let fail = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/supplies/capsules");
    assert.equal(options.method, "PUT");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), { capsuleCount: 75 });
    return new Response(JSON.stringify(fail ? { error: "Save failed" } : { capsuleCount: 75 }), {
      status: fail ? 500 : 200, headers: { "Content-Type": "application/json" },
    });
  });
  assert.deepEqual(await saveCapsuleCount(75), { capsuleCount: 75 });
  fail = true;
  await assert.rejects(saveCapsuleCount(75), /Save failed/);
});

test("reports a clear error when authentication returns HTML instead of JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>Přihlášení</html>", {
    headers: { "Content-Type": "text/html" },
    status: 200,
  });

  try {
    await assert.rejects(
      getDashboard(),
      /Obnovte stránku a znovu se přihlaste/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

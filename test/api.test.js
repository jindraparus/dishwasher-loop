import assert from "node:assert/strict";
import test from "node:test";
import { getDashboard } from "../public/api.js";

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

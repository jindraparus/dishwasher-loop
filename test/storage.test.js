import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage.js";

test("persists tokens and events to a local JSON file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dishwasher-loop-"));
  const file = path.join(directory, "storage.json");

  try {
    const storage = new Storage("local", "unused", file);
    await storage.initialize();
    await storage.saveTokens({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 123,
    });
    await storage.saveEvent({
      applianceId: "dishwasher-1",
      applianceName: "Dishwasher",
      eventType: "NOTIFY",
      eventId: "event-1",
      data: { finished: true },
    });
    const reloaded = new Storage("UseDevelopmentStorage=true", "unused", file);
    await reloaded.initialize();

    assert.deepEqual(await reloaded.getTokens(), {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 123,
    });
    assert.deepEqual((await reloaded.listEvents())[0].data, { finished: true });
    assert.equal(JSON.parse(await readFile(file, "utf8")).events.length, 1);
  } finally {
    await rm(directory, { recursive: true });
  }
});

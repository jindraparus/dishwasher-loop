import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cycleToEntity,
  entityToCycle,
  Storage,
} from "../src/storage.js";

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

test("reads capsule inventory from the local settings store", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dishwasher-loop-"));
  const file = path.join(directory, "storage.json");

  try {
    await writeFile(file, JSON.stringify({
      tokens: null,
      events: [],
      capsuleCount: 24,
    }));
    const storage = new Storage("local", "unused", file);
    await storage.initialize();

    assert.equal(await storage.getCapsuleCount(), 24);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("upserts and reloads cycle history from local storage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dishwasher-loop-"));
  const file = path.join(directory, "storage.json");
  const cycle = {
    cycleId: "cycle-1",
    applianceId: "dishwasher-1",
    applianceName: "Dishwasher",
    programKey: "Dishcare.Dishwasher.Program.Eco50",
    status: "running",
    result: "unknown",
    startedAt: "2026-10-10T20:00:00.000Z",
    finishedAt: null,
    durationSeconds: null,
    firstObservedAt: "2026-10-10T20:00:00.000Z",
    lastObservedAt: "2026-10-10T20:00:00.000Z",
    startEvidence: ["active-program"],
    finishEvidence: [],
    startConfidence: "observed",
    finishConfidence: "missing",
    observationGaps: [],
    sourceEventIds: ["event-1"],
    progressMin: null,
    progressMax: null,
    remainingInitialSeconds: null,
    remainingLastSeconds: null,
    pendingTerminalSignals: [],
  };

  try {
    const storage = new Storage("local", "unused", file);
    await storage.initialize();
    await storage.saveCycle(cycle);
    await storage.saveCycle({
      ...cycle,
      status: "finished",
      result: "finished",
      finishedAt: "2026-10-10T23:00:00.000Z",
      durationSeconds: 10_800,
      lastObservedAt: "2026-10-10T23:00:00.000Z",
    });

    const reloaded = new Storage("local", "unused", file);
    await reloaded.initialize();

    const cycles = await reloaded.listCycles();
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].status, "finished");
    assert.equal(cycles[0].durationSeconds, 10_800);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("round-trips cycle entities through the Azure Table representation", () => {
  const cycle = {
    cycleId: "cycle-1",
    applianceId: "dishwasher-1",
    applianceName: "Dishwasher",
    programKey: null,
    status: "incomplete",
    result: "unknown",
    startedAt: null,
    finishedAt: null,
    durationSeconds: null,
    firstObservedAt: "2026-10-10T20:00:00.000Z",
    lastObservedAt: "2026-10-10T21:00:00.000Z",
    startEvidence: ["mid-cycle-observation"],
    finishEvidence: [],
    startConfidence: "inferred",
    finishConfidence: "missing",
    observationGaps: [{
      startedAt: "2026-10-10T20:30:00.000Z",
      endedAt: "2026-10-10T20:35:00.000Z",
    }],
    sourceEventIds: [],
    progressMin: 42,
    progressMax: 80,
    remainingInitialSeconds: 5_400,
    remainingLastSeconds: 1_200,
    pendingTerminalSignals: [],
  };

  const entity = cycleToEntity(cycle);
  assert.deepEqual(entityToCycle({
    ...entity,
    rowKey: entity.rowKey,
  }), cycle);
});

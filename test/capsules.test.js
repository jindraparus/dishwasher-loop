import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage.js";
import { CycleTracker } from "../src/cycles.js";

const start = Date.parse("2026-10-23T10:00:00Z");

function completed(cycleId, finishedAt = new Date(start + 1000).toISOString()) {
  return {
    cycleId, applianceId: "dishwasher", status: "finished", result: "finished",
    finishedAt, firstObservedAt: finishedAt, lastObservedAt: finishedAt,
    startEvidence: [], finishEvidence: [], observationGaps: [], sourceEventIds: [],
    pendingTerminalSignals: [],
  };
}

function tableClient() {
  const entities = new Map();
  let version = 0;
  return {
    entities,
    conflicts: 0,
    failure: null,
    async createTable() {},
    async getEntity(partition, row) {
      if (!entities.has(`${partition}/${row}`)) throw Object.assign(new Error("Missing"), { statusCode: 404 });
      return structuredClone(entities.get(`${partition}/${row}`));
    },
    async upsertEntity(entity) {
      entities.set(`${entity.partitionKey}/${entity.rowKey}`, structuredClone(entity));
    },
    async submitTransaction(actions) {
      if (this.failure) throw this.failure;
      if (this.conflicts > 0) {
        this.conflicts -= 1;
        throw Object.assign(new Error("Conflict"), { statusCode: 412 });
      }
      for (const [operation, entity, , options] of actions) {
        const previous = entities.get(`${entity.partitionKey}/${entity.rowKey}`);
        if ((operation === "create" && previous)
          || (operation === "update" && options.etag !== previous?.etag)) {
          throw Object.assign(new Error("Conflict"), { statusCode: 412 });
        }
      }
      for (const [, entity] of actions) {
        entities.set(`${entity.partitionKey}/${entity.rowKey}`, {
          ...structuredClone(entity), etag: String(++version),
        });
      }
    },
    async *listEntities({ queryOptions }) {
      const partition = queryOptions.filter.match(/'([^']+)'/)[1];
      for (const entity of entities.values()) {
        if (entity.partitionKey === partition) yield structuredClone(entity);
      }
    },
  };
}

for (const mode of ["local", "azure"]) {
  test(`${mode}: initializes, edits, deducts exactly once, and recovers on restart`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: start });
    const directory = await mkdtemp(path.join(tmpdir(), "capsules-"));
    t.after(() => rm(directory, { recursive: true }));
    const file = path.join(directory, "store.json");
    const client = tableClient();
    const create = () => {
      const storage = new Storage("local", "unused", file);
      if (mode === "azure") {
        storage.localFile = null;
        storage.client = client;
      }
      return storage;
    };
    const storage = create();
    await storage.initialize();
    assert.equal(await storage.getCapsuleCount(), 50);
    await storage.saveCycle(completed("historical", new Date(start - 1000).toISOString()));
    assert.equal(await storage.getCapsuleCount(), 50);
    t.mock.timers.tick(2000);
    await storage.saveCycle(completed("one"));
    await storage.saveCycle(completed("one"));
    assert.equal(await storage.getCapsuleCount(), 49);
    await storage.saveCycle({ ...completed("running"), status: "running", result: "unknown" });
    await storage.saveCycle({ ...completed("cancelled"), status: "incomplete", result: "unknown" });
    assert.equal(await storage.getCapsuleCount(), 49);
    await storage.setCapsuleCount(75);
    await storage.saveCycle(completed("late-old-finish"));
    assert.equal(await storage.getCapsuleCount(), 75);
    await storage.setCapsuleCount(0);
    t.mock.timers.tick(2000);
    const zeroCycle = completed("at-zero", new Date(start + 3000).toISOString());
    await storage.saveCycle(zeroCycle);
    assert.equal(await storage.getCapsuleCount(), 0);
    await storage.setCapsuleCount(20);
    await storage.saveCycle(zeroCycle);
    assert.equal(await storage.getCapsuleCount(), 20);
    t.mock.timers.tick(2000);
    const next = completed("after-edit", new Date(start + 5000).toISOString());
    await Promise.all([storage.saveCycle(next), storage.saveCycle(next),
      storage.saveCycle(completed("another", next.finishedAt))]);
    assert.equal(await storage.getCapsuleCount(), 18);
    const reloaded = create();
    await reloaded.initialize();
    await new CycleTracker(reloaded, { info() {} }).initialize();
    assert.equal(await reloaded.getCapsuleCount(), 18);

    // A durably saved cycle without its consumption represents an interrupted write.
    const missed = completed("missed", new Date(start + 5500).toISOString());
    if (mode === "local") {
      reloaded.localData.cycles.push(missed);
      await reloaded.updateLocal(() => {});
    } else {
      const { cycleToEntity } = await import("../src/storage.js");
      await client.upsertEntity(cycleToEntity(missed));
    }
    await new CycleTracker(reloaded, { info() {} }).initialize();
    assert.equal(await reloaded.getCapsuleCount(), 17);
    await new CycleTracker(reloaded, { info() {} }).initialize();
    assert.equal(await reloaded.getCapsuleCount(), 17);
    t.mock.timers.tick(2000);
    await Promise.all([
      reloaded.saveCycle(completed("concurrent-old-finish", new Date(start + 7000).toISOString())),
      reloaded.setCapsuleCount(75),
    ]);
    assert.equal(await reloaded.getCapsuleCount(), 75);
    await reloaded.saveCycle(completed("after-concurrent-edit", new Date(start + 9000).toISOString()));
    assert.equal(await reloaded.getCapsuleCount(), 74);
  });
}

test("preserves valid legacy counts, initializes invalid counts, validates edits and fails atomically", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "capsules-"));
  t.after(() => rm(directory, { recursive: true }));
  for (const legacy of [0, 24, 999, -1, 1000, 1.5, null]) {
    const file = path.join(directory, "store.json");
    await writeFile(file, JSON.stringify({ capsuleCount: legacy }));
    const storage = new Storage("local", "unused", file);
    await storage.initialize();
    assert.equal(await storage.getCapsuleCount(), [0, 24, 999].includes(legacy) ? legacy : 50);
    for (const invalid of [-1, 1000, 1.5, "12", null, undefined]) {
      await assert.rejects(storage.setCapsuleCount(invalid), RangeError);
    }
    const before = await storage.getCapsuleCount();
    storage.localFile = path.join(directory, "missing", "store.json");
    await assert.rejects(storage.setCapsuleCount(75), { code: "ENOENT" });
    assert.equal(await storage.getCapsuleCount(), before);
  }
});

test("Azure retries ETag conflicts, preserves legacy zero, and surfaces failures", async () => {
  const storage = new Storage("local", "unused");
  storage.localFile = null;
  const client = tableClient();
  storage.client = client;
  client.entities.set("settings/supplies", {
    partitionKey: "settings", rowKey: "supplies", capsuleCount: 0, etag: "legacy",
  });
  client.conflicts = 2;
  await storage.initialize();
  assert.equal(await storage.getCapsuleCount(), 0);
  await storage.setCapsuleCount(999);
  assert.equal(await storage.getCapsuleCount(), 999);
  client.conflicts = 8;
  await assert.rejects(storage.setCapsuleCount(20), /Conflict/);
  assert.equal(await storage.getCapsuleCount(), 999);
  client.failure = new Error("Storage unavailable");
  await assert.rejects(storage.setCapsuleCount(20), /Storage unavailable/);
  assert.equal(await storage.getCapsuleCount(), 999);
});

test("Azure recovers a cycle saved before its inventory transaction failed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const storage = new Storage("local", "unused");
  storage.localFile = null;
  storage.client = tableClient();
  await storage.initialize();
  storage.client.failure = new Error("Transaction unavailable");
  await assert.rejects(storage.saveCycle(completed("interrupted")), /Transaction unavailable/);
  assert.equal(await storage.getCapsuleCount(), 50);
  storage.client.failure = null;
  await new CycleTracker(storage, { info() {} }).initialize();
  assert.equal(await storage.getCapsuleCount(), 49);
  await new CycleTracker(storage, { info() {} }).initialize();
  assert.equal(await storage.getCapsuleCount(), 49);
});

test("live tracker deducts observed and inferred finishes, including repeated event retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const directory = await mkdtemp(path.join(tmpdir(), "capsules-"));
  t.after(() => rm(directory, { recursive: true }));
  const storage = new Storage("local", "unused", path.join(directory, "store.json"));
  await storage.initialize();
  const tracker = new CycleTracker(storage);
  const event = (seconds, items) => ({
    applianceId: "dishwasher", receivedAt: new Date(start + seconds * 1000).toISOString(),
    eventType: "NOTIFY", data: { items: items.map(([key, value]) => ({ key, value })) },
  });
  const finish = event(10, [["BSH.Common.Event.ProgramFinished", "BSH.Common.EnumType.EventPresentState.Present"]]);
  await storage.saveEvent(finish);
  await tracker.processEvent(finish);
  await tracker.processEvent(finish);
  assert.equal(await storage.getCapsuleCount(), 49);
  const began = event(600, [["BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Eco50"]]);
  const inferred = event(700, [
    ["BSH.Common.Status.OperationState", "BSH.Common.EnumType.OperationState.Ready"],
    ["BSH.Common.Setting.PowerState", "BSH.Common.EnumType.PowerState.Off"],
  ]);
  await storage.saveEvent(began);
  await tracker.processEvent(began);
  await storage.saveEvent(inferred);
  await tracker.processEvent(inferred);
  assert.equal(await storage.getCapsuleCount(), 48);
  await new CycleTracker(storage, { info() {} }).initialize();
  assert.equal(await storage.getCapsuleCount(), 48);
});

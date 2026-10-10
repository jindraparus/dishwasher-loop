import assert from "node:assert/strict";
import test from "node:test";
import {
  consumableStatus,
  DishwasherMonitor,
  shouldPersistEvent,
} from "../src/monitor.js";

test("ignores keep-alives with the default event type filter", () => {
  assert.equal(shouldPersistEvent({
    event: "KEEP-ALIVE",
    data: "",
  }, {
    types: ["STATUS", "EVENT", "NOTIFY"],
    keys: [],
  }), false);
});

test("keeps a selected event type when no item-key filter is configured", () => {
  assert.equal(shouldPersistEvent({
    event: "NOTIFY",
    data: { items: [{ key: "BSH.Common.Option.ProgramProgress" }] },
  }, {
    types: ["NOTIFY"],
    keys: [],
  }), true);
});

test("keeps only messages containing a selected item key", () => {
  const filter = {
    types: ["EVENT", "NOTIFY"],
    keys: ["BSH.Common.Event.ProgramFinished"],
  };

  assert.equal(shouldPersistEvent({
    event: "EVENT",
    data: { items: [{ key: "BSH.Common.Event.ProgramFinished" }] },
  }, filter), true);
  assert.equal(shouldPersistEvent({
    event: "NOTIFY",
    data: { items: [{ key: "BSH.Common.Option.ProgramProgress" }] },
  }, filter), false);
});

test("maps dishwasher consumable warning states", () => {
  assert.deepEqual(consumableStatus("BSH.Common.EnumType.EventPresentState.Off"), {
    state: "ok",
    label: "Enough",
  });
  assert.deepEqual(consumableStatus("BSH.Common.EnumType.EventPresentState.Present"), {
    state: "low",
    label: "Refill soon",
  });
  assert.deepEqual(consumableStatus("BSH.Common.EnumType.EventPresentState.Confirmed"), {
    state: "low",
    label: "Refill soon (warning acknowledged)",
  });
  assert.deepEqual(consumableStatus("unexpected"), {
    state: "unknown",
    label: "Unknown - waiting for appliance event",
  });
});

test("restores the latest persisted salt warning into diagnostics", async () => {
  const monitor = new DishwasherMonitor({
    getApplianceStatus: async () => [],
  }, {
    listEvents: async () => [{
      applianceId: "dishwasher-1",
      eventType: "EVENT",
      receivedAt: "2026-10-10T19:00:00.000Z",
      data: {
        items: [{
          key: "Dishcare.Dishwasher.Event.SaltNearlyEmpty",
          value: "BSH.Common.EnumType.EventPresentState.Present",
        }],
      },
    }],
  });

  await monitor.loadDiagnostics([{
    haId: "dishwasher-1",
    name: "Kitchen dishwasher",
    type: "Dishwasher",
    connected: true,
  }]);

  assert.deepEqual(monitor.getDiagnostics()[0].consumables.salt, {
    state: "low",
    label: "Refill soon",
  });
});

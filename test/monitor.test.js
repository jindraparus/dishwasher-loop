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
    label: "Dostatek",
  });
  assert.deepEqual(consumableStatus("BSH.Common.EnumType.EventPresentState.Present"), {
    state: "low",
    label: "Brzy doplnit",
  });
  assert.deepEqual(consumableStatus("BSH.Common.EnumType.EventPresentState.Confirmed"), {
    state: "low",
    label: "Brzy doplnit (upozornění potvrzeno)",
  });
  assert.deepEqual(consumableStatus("unexpected"), {
    state: "unknown",
    label: "Neznámé – čeká se na událost spotřebiče",
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
    label: "Brzy doplnit",
  });
});

test("restores current program details from persisted notifications", async () => {
  const monitor = new DishwasherMonitor({
    getApplianceStatus: async () => [{
      key: "BSH.Common.Status.OperationState",
      value: "BSH.Common.EnumType.OperationState.Run",
    }],
  }, {
    listEvents: async () => [{
      applianceId: "dishwasher-1",
      eventType: "NOTIFY",
      receivedAt: "2026-10-10T20:00:00.000Z",
      data: {
        items: [
          {
            key: "BSH.Common.Root.ActiveProgram",
            value: "Dishcare.Dishwasher.Program.Eco50",
          },
          {
            key: "BSH.Common.Option.ProgramProgress",
            value: 37,
            unit: "%",
          },
          {
            key: "BSH.Common.Option.RemainingProgramTime",
            value: 6240,
            unit: "seconds",
          },
        ],
      },
    }],
  });

  await monitor.loadDiagnostics([{
    haId: "dishwasher-1",
    name: "Kitchen dishwasher",
    type: "Dishwasher",
    connected: true,
  }]);

  assert.deepEqual(monitor.getDiagnostics()[0].program, {
    activeKey: "Dishcare.Dishwasher.Program.Eco50",
    selectedKey: "",
    progress: 37,
    remainingSeconds: 6240,
    remainingUpdatedAt: "2026-10-10T20:00:00.000Z",
  });
});

test("clears stale program timing when the active program ends", async () => {
  const monitor = new DishwasherMonitor({
    getApplianceStatus: async () => [{
      key: "BSH.Common.Status.OperationState",
      value: "BSH.Common.EnumType.OperationState.Ready",
    }],
  }, {
    listEvents: async () => [
      {
        applianceId: "dishwasher-1",
        eventType: "NOTIFY",
        receivedAt: "2026-10-10T20:30:00.000Z",
        data: {
          items: [{
            key: "BSH.Common.Root.ActiveProgram",
            value: null,
          }],
        },
      },
      {
        applianceId: "dishwasher-1",
        eventType: "NOTIFY",
        receivedAt: "2026-10-10T20:29:00.000Z",
        data: {
          items: [
            {
              key: "BSH.Common.Option.ProgramProgress",
              value: 99,
            },
            {
              key: "BSH.Common.Option.RemainingProgramTime",
              value: 60,
            },
          ],
        },
      },
    ],
  });

  await monitor.loadDiagnostics([{
    haId: "dishwasher-1",
    name: "Kitchen dishwasher",
    type: "Dishwasher",
    connected: true,
  }]);

  assert.deepEqual(monitor.getDiagnostics()[0].program, {
    activeKey: "",
    selectedKey: "",
    progress: null,
    remainingSeconds: 0,
    remainingUpdatedAt: "2026-10-10T20:30:00.000Z",
  });
});

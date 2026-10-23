import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { HomeConnectError } from "../src/home-connect.js";
import { STATUS_CHECK_INTERVAL_MS } from "../src/connectivity.js";
import {
  consumableStatus,
  DishwasherMonitor,
  shouldPersistEvent,
} from "../src/monitor.js";

function connectivityStorage() {
  const states = new Map();
  return {
    getConnectivity: async (id) => states.get(id) || null,
    saveConnectivity: async (id, state) => { states.set(id, structuredClone(state)); },
  };
}

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
    ...connectivityStorage(),
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
    ...connectivityStorage(),
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
    ...connectivityStorage(),
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

test("sends every live event to cycle tracking even when history filtering excludes it", async () => {
  const tracked = [];
  const saved = [];
  const disconnected = [];
  const monitor = new DishwasherMonitor({
    openEventStream: async () => new Response(
      'event: NOTIFY\ndata: {"items":[{"key":"BSH.Common.Root.ActiveProgram","value":"Dishcare.Dishwasher.Program.Eco50"}]}\n\n',
    ),
  }, {
    async saveEvent(event) {
      saved.push(event);
    },
  }, {
    error() {},
    warn() {},
  }, {
    types: ["EVENT"],
    keys: ["BSH.Common.Event.ProgramFinished"],
  }, {
    async processEvent(event) {
      tracked.push(event);
    },
    async recordReconnect() {},
    async recordDisconnect(applianceId) {
      disconnected.push(applianceId);
    },
  });

  await assert.rejects(
    monitor.monitorAppliance({
      haId: "dishwasher-1",
      name: "Kitchen dishwasher",
    }, new AbortController().signal),
    /Proud událostí.*skončil/,
  );

  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].eventType, "NOTIFY");
  assert.match(tracked[0].receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(saved, []);
  assert.deepEqual(disconnected, ["dishwasher-1"]);
});

const appliance = { haId: "dishwasher-1", name: "Kitchen dishwasher", connected: true };
const offlineError = new HomeConnectError(409, {
  key: "SDK.Error.HomeAppliance.Connection.Initialization.Failed",
  description: "HomeAppliance is offline",
});
const quietLogger = { info() {}, warn() {}, error() {} };

test("historical status and live keep-alives cannot hide offline state; a fresh read recovers", async () => {
  let failure = offlineError;
  const monitor = new DishwasherMonitor({
    getApplianceStatus: async () => {
      if (failure) throw failure;
      return [{ key: "Current", value: true }];
    },
  }, {
    ...connectivityStorage(),
    listEvents: async () => [{
      applianceId: appliance.haId,
      eventType: "STATUS",
      receivedAt: "2026-10-10T19:00:00.000Z",
      data: { items: [{ key: "Historical", value: true }] },
    }],
  }, quietLogger);

  await monitor.loadDiagnostics([appliance]);
  assert.equal(monitor.getDiagnostics()[0].connected, false);
  monitor.updateDiagnostics(appliance.haId, { event: "KEEP-ALIVE", data: "" });
  monitor.updateDiagnostics(appliance.haId, { event: "STATUS", data: { items: [] } });
  assert.equal(monitor.getDiagnostics()[0].connected, false);
  assert.match(monitor.getDiagnostics()[0].statusError, /offline/);

  failure = null;
  await monitor.refreshStatus(monitor.diagnostics[0]);
  assert.equal(monitor.getDiagnostics()[0].connected, true);
  assert.equal(monitor.getDiagnostics()[0].statusError, "");
  assert.deepEqual(monitor.getDiagnostics()[0].statusItems, [{ key: "Current", value: true }]);
});

test("unknown API failures do not claim the appliance is connected or offline", async () => {
  const monitor = new DishwasherMonitor({
    getApplianceStatus: async () => { throw new HomeConnectError(503); },
  }, {
    ...connectivityStorage(), listEvents: async () => [],
  }, quietLogger);
  await monitor.loadDiagnostics([appliance]);
  assert.equal(monitor.getDiagnostics()[0].connected, null);
  monitor.updateDiagnostics(appliance.haId, { event: "KEEP-ALIVE", data: "" });
  assert.equal(monitor.getDiagnostics()[0].connected, null);
});

test("polls and recovers while a keep-alive event stream stays open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-10-23T18:00:00Z") });
  let failure = offlineError;
  let statusCalls = 0;
  let streamController;
  const logs = [];
  const monitor = new DishwasherMonitor({
    getApplianceStatus: async () => {
      statusCalls += 1;
      if (failure) throw failure;
      return [];
    },
    openEventStream: async () => new Response(new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode("event: KEEP-ALIVE\ndata: {}\n\n"));
      },
    })),
  }, {
    ...connectivityStorage(), listEvents: async () => [],
  }, { ...quietLogger, info: (line) => logs.push(JSON.parse(line)) });
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    streamController?.close();
  });
  await monitor.loadDiagnostics([appliance], controller.signal);
  const stream = monitor.monitorAppliance(appliance, controller.signal);
  const checks = monitor.runStatusChecks(controller.signal);
  await setImmediate();
  assert.equal(monitor.getDiagnostics()[0].lastEventType, "KEEP-ALIVE");

  t.mock.timers.tick(STATUS_CHECK_INTERVAL_MS);
  await setImmediate();
  assert.equal(statusCalls, 2);
  assert.equal(logs.at(-1).alertActive, true);
  assert.equal(logs.filter((log) => log.alertActive && log.transition).length, 1);

  failure = null;
  t.mock.timers.tick(STATUS_CHECK_INTERVAL_MS);
  await setImmediate();
  assert.equal(logs.at(-1).alertActive, false);
  assert.equal(monitor.getDiagnostics()[0].connected, true);
  assert.equal(monitor.getDiagnostics()[0].statusError, "");
  controller.abort();
  streamController.close();
  streamController = null;
  await Promise.all([stream, checks]);
  t.mock.timers.tick(STATUS_CHECK_INTERVAL_MS);
  assert.equal(statusCalls, 3);
});

test("coalesces overlapping status checks and ignores a cancelled result", async () => {
  let finish;
  let calls = 0;
  const monitor = new DishwasherMonitor({
    getApplianceStatus: async () => {
      calls += 1;
      return new Promise((resolve) => { finish = resolve; });
    },
  }, connectivityStorage(), quietLogger);
  const diagnostic = { id: appliance.haId, name: appliance.name, connected: false };
  const controller = new AbortController();
  const first = monitor.refreshStatus(diagnostic, controller.signal);
  const second = monitor.refreshStatus(diagnostic, controller.signal);
  assert.equal(calls, 1);
  controller.abort();
  finish([]);
  await Promise.all([first, second]);
  assert.equal(diagnostic.connected, false);
});

test("reconnecting streams does not repeat existing appliances' status requests", async () => {
  let calls = 0;
  const monitor = new DishwasherMonitor({
    getApplianceStatus: async () => { calls += 1; return []; },
  }, { ...connectivityStorage(), listEvents: async () => [] }, quietLogger);
  await monitor.loadDiagnostics([appliance]);
  await monitor.loadDiagnostics([appliance]);
  assert.equal(calls, 1);
  await monitor.loadDiagnostics([appliance, { haId: "second", name: "Other" }]);
  assert.equal(calls, 2);
});

test("rate-limit pauses honor Retry-After without extending it on skipped checks", async (t) => {
  const start = Date.parse("2026-10-23T18:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });
  let calls = 0;
  const monitor = new DishwasherMonitor({
    getApplianceStatus: async () => {
      calls += 1;
      if (calls === 1) throw new HomeConnectError(429, {}, "api", 1_800_000);
      return [];
    },
  }, { ...connectivityStorage(), listEvents: async () => [] }, quietLogger);
  await monitor.loadDiagnostics([appliance]);
  const diagnostic = monitor.diagnostics[0];
  assert.equal(diagnostic.connected, null);
  for (let interval = 1; interval < 6; interval += 1) {
    t.mock.timers.tick(STATUS_CHECK_INTERVAL_MS);
    await monitor.refreshStatus(diagnostic);
    assert.equal(calls, 1);
    assert.equal(monitor.rateLimitedUntil, start + 1_800_000);
  }
  t.mock.timers.tick(STATUS_CHECK_INTERVAL_MS);
  await monitor.refreshStatus(diagnostic);
  assert.equal(calls, 2);
  assert.equal(diagnostic.connected, true);
});

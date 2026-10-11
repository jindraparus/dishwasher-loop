import assert from "node:assert/strict";
import test from "node:test";
import {
  backfillCycleHistory,
  buildCycleStats,
  CycleTracker,
  parseCycleLimit,
} from "../src/cycles.js";

test("reconstructs a normal cycle from strong observed boundaries", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  await tracker.processEvent(message("2026-10-10T19:39:36.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Intensiv70"),
  ], "start"));
  await tracker.processEvent(message("2026-10-10T19:39:37.000Z", "STATUS", [
    item("BSH.Common.Status.OperationState", "BSH.Common.EnumType.OperationState.Run"),
    item("BSH.Common.Option.ProgramProgress", 0),
  ], "run"));
  await tracker.processEvent(message("2026-10-10T22:15:54.000Z", "EVENT", [
    item(
      "BSH.Common.Event.ProgramFinished",
      "BSH.Common.EnumType.EventPresentState.Present",
    ),
  ], "finish"));

  assert.equal(storage.cycles.length, 1);
  assert.deepEqual(
    pick(storage.cycles[0], [
      "programKey",
      "status",
      "result",
      "startedAt",
      "finishedAt",
      "durationSeconds",
      "startConfidence",
      "finishConfidence",
    ]),
    {
      programKey: "Dishcare.Dishwasher.Program.Intensiv70",
      status: "finished",
      result: "finished",
      startedAt: "2026-10-10T19:39:36.000Z",
      finishedAt: "2026-10-10T22:15:54.000Z",
      durationSeconds: 9_378,
      startConfidence: "observed",
      finishConfidence: "observed",
    },
  );
  assert.deepEqual(storage.cycles[0].finishEvidence, ["program-finished"]);
});

test("creates an incomplete-boundary completion when the start is missing", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  await tracker.processEvent(message("2026-10-10T22:15:54.000Z", "EVENT", [
    item(
      "BSH.Common.Event.ProgramFinished",
      "BSH.Common.EnumType.EventPresentState.Present",
    ),
  ]));

  assert.equal(storage.cycles[0].status, "finished");
  assert.equal(storage.cycles[0].startedAt, null);
  assert.equal(storage.cycles[0].durationSeconds, null);
  assert.equal(storage.cycles[0].startConfidence, "missing");
});

test("starts an inferred cycle when monitoring begins mid-cycle", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  await tracker.processEvent(message("2026-10-10T20:00:00.000Z", "NOTIFY", [
    item("BSH.Common.Option.ProgramProgress", 42),
    item("BSH.Common.Option.RemainingProgramTime", 5_400),
  ]));

  assert.equal(storage.cycles[0].status, "running");
  assert.equal(storage.cycles[0].startedAt, null);
  assert.equal(storage.cycles[0].startConfidence, "inferred");
  assert.deepEqual(storage.cycles[0].startEvidence, ["mid-cycle-observation"]);
});

test("promotes an inferred start when a later strong boundary arrives", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  await tracker.processEvent(message("2026-10-10T19:30:00.000Z", "NOTIFY", [
    item("BSH.Common.Root.SelectedProgram", "Dishcare.Dishwasher.Program.Eco50"),
    item("BSH.Common.Option.RemainingProgramTime", 10_800),
  ]));
  await tracker.processEvent(message("2026-10-10T19:39:36.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Eco50"),
  ]));

  assert.equal(storage.cycles.length, 1);
  assert.equal(storage.cycles[0].startedAt, "2026-10-10T19:39:36.000Z");
  assert.equal(storage.cycles[0].startConfidence, "observed");
  assert.deepEqual(storage.cycles[0].startEvidence, [
    "mid-cycle-observation",
    "active-program",
  ]);
});

test("uses operation finished when ProgramFinished is missing", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  await tracker.processEvent(message("2026-10-10T20:00:00.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Eco50"),
  ]));
  await tracker.processEvent(message("2026-10-10T23:00:00.000Z", "STATUS", [
    item(
      "BSH.Common.Status.OperationState",
      "BSH.Common.EnumType.OperationState.Finished",
    ),
  ]));

  assert.equal(storage.cycles[0].status, "finished");
  assert.deepEqual(storage.cycles[0].finishEvidence, ["operation-finished"]);
});

test("does not complete from a lone weak terminal signal", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  await tracker.processEvent(message("2026-10-10T20:00:00.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Eco50"),
  ]));
  await tracker.processEvent(message("2026-10-10T23:00:00.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", null),
  ]));

  assert.equal(storage.cycles[0].status, "running");
  assert.equal(storage.cycles[0].finishedAt, null);
  assert.deepEqual(storage.cycles[0].pendingTerminalSignals, [{
    signal: "active-program-cleared",
    observedAt: "2026-10-10T23:00:00.000Z",
  }]);
});

test("eventually resolves a lone terminal signal as incomplete", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage, console, { terminalWindowMs: 5 });

  await tracker.processEvent(message("2026-10-10T20:00:00.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Eco50"),
  ]));
  await tracker.processEvent(message(new Date().toISOString(), "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", null),
  ]));
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(storage.cycles[0].status, "incomplete");
  assert.equal(storage.cycles[0].result, "unknown");
  assert.equal(storage.cycles[0].finishedAt, null);
});

test("completes with lower confidence from two correlated terminal signals", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  await tracker.processEvent(message("2026-10-10T20:00:00.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Eco50"),
  ]));
  await tracker.processEvent(message("2026-10-10T23:00:00.000Z", "STATUS", [
    item("BSH.Common.Root.ActiveProgram", null),
    item("BSH.Common.Status.OperationState", "BSH.Common.EnumType.OperationState.Ready"),
  ]));

  assert.equal(storage.cycles[0].status, "finished");
  assert.equal(storage.cycles[0].finishConfidence, "inferred");
  assert.deepEqual(storage.cycles[0].finishEvidence, ["correlated-terminal-signals"]);
});

test("ignores ProgramFinished Off and duplicate completion notifications", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  assert.equal(await tracker.processEvent(message("2026-10-10T19:00:00.000Z", "EVENT", [
    item("BSH.Common.Event.ProgramFinished", "BSH.Common.EnumType.EventPresentState.Off"),
  ])), null);

  await tracker.processEvent(message("2026-10-10T20:00:00.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Auto2"),
  ]));
  const finish = message("2026-10-10T22:00:00.000Z", "EVENT", [
    item(
      "BSH.Common.Event.ProgramFinished",
      "BSH.Common.EnumType.EventPresentState.Present",
    ),
  ], "finish");
  await tracker.processEvent(finish);
  await tracker.processEvent(finish);

  assert.equal(tracker.cycles.size, 1);
  assert.equal(storage.cycles.length, 1);
});

test("deduplicates a replayed finish event with a changed receipt time", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  await tracker.processEvent(message("2026-10-10T20:00:00.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Auto2"),
  ], "start"));
  await tracker.processEvent(message("2026-10-10T22:00:00.000Z", "EVENT", [
    item(
      "BSH.Common.Event.ProgramFinished",
      "BSH.Common.EnumType.EventPresentState.Present",
    ),
  ], "finish"));
  await tracker.processEvent(message("2026-10-11T08:00:00.000Z", "EVENT", [
    item(
      "BSH.Common.Event.ProgramFinished",
      "BSH.Common.EnumType.EventPresentState.Present",
    ),
  ], "finish"));

  assert.equal(tracker.cycles.size, 1);
  assert.equal(storage.cycles.length, 1);
});

test("does not create a phantom cycle from post-finish reset telemetry", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  await tracker.processEvent(message("2026-10-10T19:39:36.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Intensiv70"),
  ]));
  await tracker.processEvent(message("2026-10-10T22:15:54.417Z", "NOTIFY", [
    item("BSH.Common.Option.ProgramProgress", 100),
    item("BSH.Common.Option.RemainingProgramTime", 0),
  ]));
  await tracker.processEvent(message("2026-10-10T22:15:54.744Z", "EVENT", [
    item(
      "BSH.Common.Event.ProgramFinished",
      "BSH.Common.EnumType.EventPresentState.Present",
    ),
  ]));
  await tracker.processEvent(message("2026-10-10T22:16:55.307Z", "NOTIFY", [
    item("BSH.Common.Root.SelectedProgram", "Dishcare.Dishwasher.Program.Eco50"),
    item("BSH.Common.Option.ProgramProgress", 0),
    item("BSH.Common.Option.RemainingProgramTime", 13_200),
  ]));
  await tracker.processEvent(message("2026-10-10T22:16:56.006Z", "NOTIFY", [
    item("BSH.Common.Setting.PowerState", "BSH.Common.EnumType.PowerState.Off"),
  ]));
  await tracker.processEvent(message("2026-10-10T22:16:56.105Z", "STATUS", [
    item("BSH.Common.Status.OperationState", "BSH.Common.EnumType.OperationState.Ready"),
  ]));

  assert.equal(tracker.cycles.size, 1);
  assert.equal(storage.cycles.length, 1);
  assert.equal(storage.cycles[0].programKey, "Dishcare.Dishwasher.Program.Intensiv70");
});

test("supersedes an unresolved cycle when another program starts", async () => {
  const storage = memoryStorage();
  const tracker = new CycleTracker(storage);

  await tracker.processEvent(message("2026-10-10T20:00:00.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Eco50"),
  ]));
  await tracker.processEvent(message("2026-10-11T10:00:00.000Z", "NOTIFY", [
    item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Auto2"),
  ]));

  const cycles = [...tracker.cycles.values()]
    .sort((left, right) => left.firstObservedAt.localeCompare(right.firstObservedAt));
  assert.equal(cycles[0].status, "incomplete");
  assert.equal(cycles[0].result, "superseded");
  assert.equal(cycles[0].finishedAt, null);
  assert.equal(cycles[1].status, "running");
  assert.equal(cycles[1].programKey, "Dishcare.Dishwasher.Program.Auto2");
});

test("restores an open cycle and records a disconnect gap", async () => {
  const existing = {
    ...cycleFixture(),
    status: "running",
    result: "unknown",
    finishedAt: null,
    durationSeconds: null,
  };
  const storage = memoryStorage({ cycles: [existing] });
  const tracker = new CycleTracker(storage);
  await tracker.initialize();

  await tracker.recordDisconnect("dishwasher-1", "2026-10-10T21:00:00.000Z");
  await tracker.recordReconnect("dishwasher-1", "2026-10-10T21:05:00.000Z");
  await tracker.processEvent(message("2026-10-10T23:00:00.000Z", "STATUS", [
    item(
      "BSH.Common.Status.OperationState",
      "BSH.Common.EnumType.OperationState.Finished",
    ),
  ]));

  assert.deepEqual(storage.cycles[0].observationGaps, [{
    startedAt: "2026-10-10T21:00:00.000Z",
    endedAt: "2026-10-10T21:05:00.000Z",
  }]);
  assert.equal(storage.cycles[0].status, "finished");
});

test("backfills ordered raw events idempotently", async () => {
  const storage = memoryStorage({
    events: [
      message("2026-10-10T22:00:00.000Z", "EVENT", [
        item(
          "BSH.Common.Event.ProgramFinished",
          "BSH.Common.EnumType.EventPresentState.Present",
        ),
      ], "finish"),
      message("2026-10-10T20:00:00.000Z", "NOTIFY", [
        item("BSH.Common.Root.ActiveProgram", "Dishcare.Dishwasher.Program.Eco50"),
      ], "start"),
    ],
  });

  const first = await backfillCycleHistory(storage, { info() {} });
  const second = await backfillCycleHistory(storage, { info() {} });

  assert.deepEqual(first, { events: 2, cycles: 1, complete: 1, incomplete: 0 });
  assert.deepEqual(second, first);
  assert.equal(storage.cycles.length, 1);
});

test("builds timezone-aware weekly and monthly statistics", () => {
  const cycles = [
    cycleFixture(),
    {
      ...cycleFixture(),
      cycleId: "incomplete",
      status: "incomplete",
      result: "unknown",
      startedAt: null,
      finishedAt: null,
      durationSeconds: null,
      firstObservedAt: "2026-10-07T20:00:00.000Z",
      lastObservedAt: "2026-10-07T21:00:00.000Z",
    },
  ];

  const stats = buildCycleStats(
    cycles,
    "week",
    "Europe/Prague",
    new Date("2026-10-11T12:00:00.000Z"),
  );

  assert.deepEqual(stats, {
    period: "week",
    timezone: "Europe/Prague",
    periodStart: "2026-10-05",
    periodEnd: "2026-10-11",
    completedCycleCount: 1,
    completeBoundaryCount: 1,
    incompleteCycleCount: 1,
    totalDurationSeconds: 10_800,
    averageDurationSeconds: 10_800,
    mostUsedProgram: "Dishcare.Dishwasher.Program.Eco50",
    mostUsedProgramCount: 1,
  });
});

test("validates bounded cycle query limits", () => {
  assert.equal(parseCycleLimit(undefined), 50);
  assert.equal(parseCycleLimit("20"), 20);
  assert.throws(() => parseCycleLimit("1.5"), /integer/);
  assert.throws(() => parseCycleLimit("0"), /between 1 and 100/);
  assert.throws(() => parseCycleLimit("101"), /between 1 and 100/);
});

function memoryStorage({ events = [], cycles = [] } = {}) {
  return {
    events: structuredClone(events),
    cycles: structuredClone(cycles),
    async listAllEvents() {
      return structuredClone(this.events)
        .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
    },
    async listAllCycles() {
      return structuredClone(this.cycles)
        .sort((left, right) => right.firstObservedAt.localeCompare(left.firstObservedAt));
    },
    async saveCycle(cycle) {
      const index = this.cycles.findIndex((item) => item.cycleId === cycle.cycleId);
      if (index === -1) {
        this.cycles.push(structuredClone(cycle));
      } else {
        this.cycles[index] = structuredClone(cycle);
      }
    },
  };
}

function message(receivedAt, eventType, items, eventId = "") {
  return {
    applianceId: "dishwasher-1",
    applianceName: "Kitchen dishwasher",
    eventType,
    eventId,
    receivedAt,
    data: { items },
  };
}

function item(key, value) {
  return { key, value };
}

function cycleFixture() {
  return {
    cycleId: "cycle-1",
    applianceId: "dishwasher-1",
    applianceName: "Kitchen dishwasher",
    programKey: "Dishcare.Dishwasher.Program.Eco50",
    status: "finished",
    result: "finished",
    startedAt: "2026-10-10T19:00:00.000Z",
    finishedAt: "2026-10-10T22:00:00.000Z",
    durationSeconds: 10_800,
    firstObservedAt: "2026-10-10T19:00:00.000Z",
    lastObservedAt: "2026-10-10T22:00:00.000Z",
    startEvidence: ["active-program"],
    finishEvidence: ["program-finished"],
    startConfidence: "observed",
    finishConfidence: "observed",
    observationGaps: [],
    sourceEventIds: [],
    progressMin: 0,
    progressMax: 100,
    remainingInitialSeconds: 10_800,
    remainingLastSeconds: 0,
    pendingTerminalSignals: [],
  };
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

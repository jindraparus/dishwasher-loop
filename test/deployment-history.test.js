import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  captureCycleHistory,
  readDeploymentCycles,
  verifyCycleHistory,
} from "../src/deployment-history.js";

const TIMEZONE = "Europe/Prague";
const REFERENCE = "2026-10-23T19:00:00.000Z";

test("reads history without initializing or modifying storage", async () => {
  const cycles = [cycle()];
  const storage = { async listAllCycles() { return cycles; } };
  assert.equal(await readDeploymentCycles(storage, "capture"), cycles);
  assert.equal(await readDeploymentCycles(storage, "verify"), cycles);
});

test("explicitly permits an absent table only before the first deployment", async () => {
  const error = Object.assign(new Error("Table missing"), { statusCode: 404, code: "TableNotFound" });
  const storage = { async listAllCycles() { throw error; } };
  const messages = [];
  assert.deepEqual(await readDeploymentCycles(storage, "capture", {
    info(message) { messages.push(message); },
  }), []);
  assert.match(messages[0], /first deployment/);
  await assert.rejects(readDeploymentCycles(storage, "verify"), (caught) => caught === error);
});

test("propagates authentication, network, and other storage failures", async () => {
  for (const error of [
    Object.assign(new Error("Forbidden"), { statusCode: 403, code: "AuthorizationFailure" }),
    Object.assign(new Error("Unknown resource"), { statusCode: 404, code: "ResourceNotFound" }),
    new Error("Network unavailable"),
  ]) {
    const storage = { async listAllCycles() { throw error; } };
    await assert.rejects(readDeploymentCycles(storage, "capture"), (caught) => caught === error);
  }
});

test("preserves exact cycle data and weekly/monthly statistics without a fixed count", () => {
  for (const cycles of [[], [cycle()], [cycle(), cycle({ cycleId: "other", applianceId: "other" })]]) {
    const baseline = captureCycleHistory(cycles, TIMEZONE, REFERENCE);
    const result = verifyCycleHistory(baseline, structuredClone(cycles).reverse(), TIMEZONE);
    assert.equal(result.preservedCycles, cycles.length);
    assert.equal(result.newCycles, 0);
    assert.equal(result.progressedCycles, 0);
    assert.deepEqual(result.stats, baseline.stats);
  }
});

test("reports a missing historical cycle and changed statistics", () => {
  const baseline = captureCycleHistory([cycle()], TIMEZONE, REFERENCE);
  assert.throws(
    () => verifyCycleHistory(baseline, [], TIMEZONE),
    /wash-1: missing cycle[\s\S]*week.completedCycleCount: 1 -> 0[\s\S]*month.completedCycleCount: 1 -> 0/,
  );
});

test("rejects duplicate IDs and the same observation under a different ID", () => {
  const baseline = captureCycleHistory([cycle()], TIMEZONE, REFERENCE);
  assert.throws(
    () => verifyCycleHistory(baseline, [cycle(), cycle()], TIMEZONE),
    /Duplicate cycle ID: wash-1/,
  );
  assert.throws(
    () => verifyCycleHistory(baseline, [cycle(), cycle({ cycleId: "duplicate" })], TIMEZONE),
    /Duplicate cycle observation/,
  );
});

for (const [field, value] of Object.entries({
  programKey: "Dishcare.Dishwasher.Program.Eco50",
  startedAt: "2026-10-21T17:31:00.000Z",
  finishedAt: "2026-10-21T19:31:00.000Z",
  durationSeconds: 7_201,
  status: "incomplete",
  result: "unknown",
  startConfidence: "inferred",
  finishConfidence: "inferred",
})) {
  test(`rejects a changed historical ${field}`, () => {
    const baseline = captureCycleHistory([cycle()], TIMEZONE, REFERENCE);
    assert.throws(
      () => verifyCycleHistory(baseline, [cycle({ [field]: value })], TIMEZONE),
      new RegExp(`wash-1\\.${field}:`),
    );
  });
}

test("compares seconds even when rounded display durations would match", () => {
  const baseline = captureCycleHistory([cycle()], TIMEZONE, REFERENCE);
  assert.throws(
    () => verifyCycleHistory(baseline, [cycle({ durationSeconds: 7_201 })], TIMEZONE),
    /durationSeconds: 7200 -> 7201/,
  );
});

test("rejects an unexpected historical addition", () => {
  const baseline = captureCycleHistory([], TIMEZONE, REFERENCE);
  assert.throws(
    () => verifyCycleHistory(baseline, [cycle()], TIMEZONE),
    /unexpected historical cycle/,
  );
});

test("permits a new cycle while retaining the baseline statistics", () => {
  const old = cycle();
  const baseline = captureCycleHistory([old], TIMEZONE, REFERENCE);
  const recent = cycle({
    cycleId: "new",
    firstObservedAt: "2026-10-23T19:01:00.000Z",
    startedAt: "2026-10-23T19:01:00.000Z",
    finishedAt: "2026-10-23T21:01:00.000Z",
    lastObservedAt: "2026-10-23T21:01:00.000Z",
  });
  const result = verifyCycleHistory(baseline, [recent, old], TIMEZONE);
  assert.equal(result.newCycles, 1);
  assert.deepEqual(result.stats, baseline.stats);
  assert.equal(result.liveStats.month.completedCycleCount, 2);
});

test("permits a running cycle to finish during startup", () => {
  const running = cycle({
    status: "running", result: "unknown", finishedAt: null, durationSeconds: null,
    finishConfidence: "missing", lastObservedAt: "2026-10-21T17:30:00.000Z",
  });
  const baseline = captureCycleHistory([running], TIMEZONE, REFERENCE);
  const result = verifyCycleHistory(baseline, [cycle()], TIMEZONE);
  assert.equal(result.progressedCycles, 1);
  assert.equal(result.stats.month.completedCycleCount, 0);
  assert.equal(result.liveStats.month.completedCycleCount, 1);
});

test("permits live progress to discover an unknown program and start boundary", () => {
  const running = cycle({
    status: "running", result: "unknown", programKey: null, startedAt: null,
    finishedAt: null, durationSeconds: null, startConfidence: "inferred",
    finishConfidence: "missing", lastObservedAt: "2026-10-21T17:30:00.000Z",
  });
  const baseline = captureCycleHistory([running], TIMEZONE, REFERENCE);
  const result = verifyCycleHistory(baseline, [cycle()], TIMEZONE);
  assert.equal(result.progressedCycles, 1);
});

test("permits a pending cycle to time out and an incomplete cycle to finish later", () => {
  const running = cycle({
    status: "running", result: "unknown", finishedAt: null, durationSeconds: null,
    finishConfidence: "missing", lastObservedAt: "2026-10-21T17:30:00.000Z",
  });
  const incomplete = { ...running, status: "incomplete" };
  assert.equal(verifyCycleHistory(
    captureCycleHistory([running], TIMEZONE, REFERENCE), [incomplete], TIMEZONE,
  ).progressedCycles, 1);
  assert.equal(verifyCycleHistory(
    captureCycleHistory([incomplete], TIMEZONE, REFERENCE), [cycle()], TIMEZONE,
  ).progressedCycles, 1);
  assert.equal(verifyCycleHistory(
    captureCycleHistory([running], TIMEZONE, REFERENCE),
    [{ ...incomplete, result: "superseded" }], TIMEZONE,
  ).progressedCycles, 1);
});

test("does not exempt a missing or corrupted active cycle", () => {
  const running = cycle({
    status: "running", result: "unknown", finishedAt: null, durationSeconds: null,
    finishConfidence: "missing", lastObservedAt: "2026-10-21T17:30:00.000Z",
  });
  const baseline = captureCycleHistory([running], TIMEZONE, REFERENCE);
  assert.throws(() => verifyCycleHistory(baseline, [], TIMEZONE), /missing cycle/);
  assert.throws(
    () => verifyCycleHistory(baseline, [cycle({ durationSeconds: 8_000 })], TIMEZONE),
    /durationSeconds:/,
  );
  assert.throws(
    () => verifyCycleHistory(baseline, [cycle({ programKey: "changed" })], TIMEZONE),
    /programKey:/,
  );
  assert.throws(
    () => verifyCycleHistory(baseline, [{ ...running, status: "finished", result: "finished" }], TIMEZONE),
    /status:/,
  );
});

test("permits later terminal observations without altering completed boundaries", () => {
  const baseline = captureCycleHistory([cycle()], TIMEZONE, REFERENCE);
  const result = verifyCycleHistory(baseline, [
    cycle({ lastObservedAt: "2026-10-21T19:31:00.000Z" }),
  ], TIMEZONE);
  assert.equal(result.progressedCycles, 1);
});

test("does not permit incomplete cycles to regress or change their existing result", () => {
  const incomplete = cycle({
    status: "incomplete", result: "unknown", finishedAt: null,
    durationSeconds: null, finishConfidence: "missing",
  });
  const baseline = captureCycleHistory([incomplete], TIMEZONE, REFERENCE);
  assert.throws(
    () => verifyCycleHistory(baseline, [{ ...incomplete, status: "running" }], TIMEZONE),
    /status:/,
  );
  assert.throws(
    () => verifyCycleHistory(baseline, [{ ...incomplete, result: "superseded" }], TIMEZONE),
    /result:/,
  );
});

test("uses the baseline date across week/month boundaries and checks timezone changes", (context) => {
  const baseline = captureCycleHistory([cycle()], TIMEZONE, "2026-10-31T21:59:59.000Z");
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T12:00:00.000Z") });
  assert.deepEqual(verifyCycleHistory(baseline, [cycle()], TIMEZONE).stats, baseline.stats);
  assert.throws(() => verifyCycleHistory(baseline, [cycle()], "UTC"), /timezone:/);
});

test("detects changed or missing baseline statistics", () => {
  for (const period of ["week", "month"]) {
    const baseline = captureCycleHistory([cycle()], TIMEZONE, REFERENCE);
    baseline.stats[period].averageDurationSeconds += 1;
    assert.throws(
      () => verifyCycleHistory(baseline, [cycle()], TIMEZONE),
      new RegExp(`${period}\\.averageDurationSeconds:`),
    );
    delete baseline.stats[period].completedCycleCount;
    assert.throws(
      () => verifyCycleHistory(baseline, [cycle()], TIMEZONE),
      new RegExp(`${period}\\.completedCycleCount:`),
    );
  }
});

test("rejects invalid input rather than treating it as empty history", () => {
  assert.throws(() => captureCycleHistory(null, TIMEZONE), /must be an array/);
  assert.throws(() => captureCycleHistory([{}], TIMEZONE), /Invalid cycle-history record/);
  assert.throws(() => captureCycleHistory([], TIMEZONE, "invalid"), /reference time/);
  assert.throws(() => verifyCycleHistory({}, [], TIMEZONE), /Invalid cycle-history baseline/);
});

test("bounds failure output", () => {
  const cycles = Array.from({ length: 30 }, (_, index) => cycle({ cycleId: `${index}`, applianceId: `${index}` }));
  const baseline = captureCycleHistory(cycles, TIMEZONE, REFERENCE);
  assert.throws(
    () => verifyCycleHistory(baseline, [], TIMEZONE),
    /Further differences omitted/,
  );
});

test("workflow captures before upload, verifies after readiness, and always removes the baseline", async () => {
  const workflow = await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("check-deployment-history.js capture"));
  assert.ok(workflow.indexOf("check-deployment-history.js capture") < workflow.indexOf("az webapp deploy"));
  assert.ok(workflow.indexOf("Verify application health") < workflow.indexOf("check-deployment-history.js verify"));
  assert.match(workflow, /Remove cycle history baseline\n\s+if: always\(\)\n\s+run: rm -f "\$RUNNER_TEMP\/cycle-history-before\.json"/);
});

test("CLI fails explicitly for invalid arguments or missing Azure configuration", () => {
  const script = fileURLToPath(new URL("../scripts/check-deployment-history.js", import.meta.url));
  const invalid = spawnSync(process.execPath, [script, "invalid"], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Usage:/);
  const missing = spawnSync(process.execPath, [script, "capture", "unused.json"], {
    encoding: "utf8",
    env: { ...process.env, AZURE_RESOURCE_GROUP: "" },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /AZURE_RESOURCE_GROUP is required/);
});

function cycle(overrides = {}) {
  return {
    cycleId: "wash-1",
    applianceId: "dishwasher-1",
    programKey: "Dishcare.Dishwasher.Program.Auto2",
    status: "finished",
    result: "finished",
    startedAt: "2026-10-21T17:30:00.000Z",
    finishedAt: "2026-10-21T19:30:00.000Z",
    durationSeconds: 7_200,
    firstObservedAt: "2026-10-21T17:30:00.000Z",
    lastObservedAt: "2026-10-21T19:30:00.000Z",
    startConfidence: "observed",
    finishConfidence: "observed",
    ...overrides,
  };
}

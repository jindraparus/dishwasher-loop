import assert from "node:assert/strict";
import test from "node:test";
import { ConnectivityTracker, logHomeConnectFailure, OFFLINE_GRACE_MS } from "../src/connectivity.js";
import { AuthenticationRequiredError, HomeConnectError } from "../src/home-connect.js";

const appliance = { haId: "dishwasher-1", name: "Kitchen dishwasher" };
const offline = new HomeConnectError(409, {
  key: "SDK.Error.HomeAppliance.Connection.Initialization.Failed",
  description: "HomeAppliance is offline",
});
const start = Date.parse("2026-10-23T18:00:00Z");

function fixture() {
  const states = new Map();
  const logs = [];
  const storage = {
    getConnectivity: async (id) => structuredClone(states.get(id) || null),
    saveConnectivity: async (id, state) => { states.set(id, structuredClone(state)); },
  };
  const logger = {
    info: (line) => logs.push(JSON.parse(line)),
    warn: (line) => logs.push(JSON.parse(line)),
  };
  return { storage, logger, logs };
}

test("sustained offline activates at exactly five minutes, once per outage", async () => {
  const { storage, logger, logs } = fixture();
  const tracker = new ConnectivityTracker(storage, logger);
  for (const elapsed of [0, OFFLINE_GRACE_MS - 1, OFFLINE_GRACE_MS, OFFLINE_GRACE_MS + 60_000]) {
    await tracker.record(appliance, offline, new Date(start + elapsed));
  }
  assert.deepEqual(logs.map((log) => log.alertActive), [false, false, true, true]);
  assert.deepEqual(logs.map((log) => log.transition), [true, false, true, false]);
  assert.ok(logs.every((log) => log.offlineSince === new Date(start).toISOString()));
  assert.ok(logs.every((log) => log.applianceName === appliance.name));
});

test("brief outages do not activate; current success clears and starts a new outage", async () => {
  const { storage, logger, logs } = fixture();
  const tracker = new ConnectivityTracker(storage, logger);
  await tracker.record(appliance, offline, new Date(start));
  await tracker.record(appliance, null, new Date(start + OFFLINE_GRACE_MS - 1));
  assert.equal(logs.at(-1).alertActive, false);
  assert.equal(logs.at(-1).offlineSince, "");
  await tracker.record(appliance, offline, new Date(start + OFFLINE_GRACE_MS));
  assert.equal(logs.at(-1).alertActive, false);
  assert.equal(logs.at(-1).offlineSince, new Date(start + OFFLINE_GRACE_MS).toISOString());
  await tracker.record(appliance, offline, new Date(start + 2 * OFFLINE_GRACE_MS));
  await tracker.record(appliance, null, new Date(start + 2 * OFFLINE_GRACE_MS + 1));
  assert.equal(logs.at(-1).state, "online");
  assert.equal(logs.at(-1).alertActive, false);
});

test("API and authentication failures do not create or resolve confirmed outages", async () => {
  const { storage, logger, logs } = fixture();
  const tracker = new ConnectivityTracker(storage, logger);
  const failures = [new Error("secret"), new AuthenticationRequiredError(), new HomeConnectError(503)];
  for (const error of failures) {
    await tracker.record(appliance, error, new Date(start));
    assert.equal(logs.at(-1).state, "unknown");
    assert.equal(logs.at(-1).alertActive, false);
  }
  await tracker.record(appliance, offline, new Date(start));
  await tracker.record(appliance, offline, new Date(start + OFFLINE_GRACE_MS));
  for (const error of failures) {
    await tracker.record(appliance, error, new Date(start + OFFLINE_GRACE_MS + 1));
    assert.equal(logs.at(-1).checkResult, "unknown");
    assert.equal(logs.at(-1).alertActive, true);
    assert.equal(logs.at(-1).offlineSince, new Date(start).toISOString());
  }
  assert.doesNotMatch(JSON.stringify(logs), /secret/);
});

test("unknown checks interrupt the grace period before an alert is active", async () => {
  const { storage, logger, logs } = fixture();
  const tracker = new ConnectivityTracker(storage, logger);
  await tracker.record(appliance, offline, new Date(start));
  await tracker.record(appliance, new HomeConnectError(429), new Date(start + 60_000));
  await tracker.record(appliance, offline, new Date(start + OFFLINE_GRACE_MS));
  assert.equal(logs.at(-1).alertActive, false);
  assert.equal(logs.at(-1).offlineSince, new Date(start + OFFLINE_GRACE_MS).toISOString());
});

test("restarting the tracker retains the outage identity and active alert", async () => {
  const { storage, logger, logs } = fixture();
  await new ConnectivityTracker(storage, logger).record(appliance, offline, new Date(start));
  const restarted = new ConnectivityTracker(storage, logger);
  await restarted.record(appliance, offline, new Date(start + OFFLINE_GRACE_MS));
  await new ConnectivityTracker(storage, logger).record(appliance, offline, new Date(start + OFFLINE_GRACE_MS + 1));
  assert.equal(logs.at(-1).transition, false);
  assert.equal(logs.at(-1).alertActive, true);
  assert.equal(logs.at(-1).offlineSince, new Date(start).toISOString());
});

test("appliance states are independent and persistence failures are surfaced", async () => {
  const { storage, logger, logs } = fixture();
  const tracker = new ConnectivityTracker(storage, logger);
  await tracker.record(appliance, offline, new Date(start));
  await tracker.record({ haId: "second", name: "Other" }, null, new Date(start));
  assert.equal((await storage.getConnectivity(appliance.haId)).state, "offline");
  assert.equal(logs.at(-1).state, "online");
  storage.saveConnectivity = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(tracker.record(appliance, null), /storage unavailable/);
});

test("structured failures distinguish event-stream, API, and authentication failures safely", () => {
  const { logger, logs } = fixture();
  logHomeConnectFailure(logger, "event_stream", new Error("secret-token"), appliance.haId);
  logHomeConnectFailure(logger, "status", new HomeConnectError(503), appliance.haId);
  logHomeConnectFailure(logger, "discovery", new AuthenticationRequiredError());
  assert.deepEqual(logs.map((log) => [log.operation, log.failureKind]), [
    ["event_stream", "api"], ["status", "api"], ["discovery", "authentication"],
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /secret-token/);
});

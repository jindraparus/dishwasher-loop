import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildCycleAnalytics, parseCycleAnalyticsOptions, validateCycleAnalytics,
} from "../src/cycle-analytics.js";
import { DashboardClient } from "../src/mcp/dashboard.js";
import { createDishwasherMcpServer } from "../src/mcp/server.js";

const now = new Date("2026-10-29T20:46:00.000Z");
const eco = "Dishcare.Dishwasher.Program.Eco50";
const auto = "Dishcare.Dishwasher.Program.Auto2";

function cycle(index, overrides = {}) {
  return {
    cycleId: `cycle-${index}`,
    applianceId: "kitchen",
    applianceName: "Kitchen",
    programKey: eco,
    status: "finished",
    result: "finished",
    startedAt: "2026-10-26T18:00:00.000Z",
    finishedAt: "2026-10-26T21:00:00.000Z",
    firstObservedAt: "2026-10-26T18:00:00.000Z",
    lastObservedAt: "2026-10-26T21:00:00.000Z",
    startConfidence: "observed",
    finishConfidence: "observed",
    durationSeconds: 10_800,
    observationGaps: [],
    ...overrides,
  };
}

test("ranks all observed programs, retaining ties, unknown programs and incomplete records", () => {
  const history = [
    cycle(1), cycle(2), cycle(3, { programKey: auto }), cycle(4, { programKey: auto }),
    cycle(5, { programKey: null, status: "incomplete", result: "unknown",
      finishedAt: null, finishConfidence: "missing", durationSeconds: null }),
  ];
  const result = buildCycleAnalytics(history, [], {}, now);
  assert.equal(result.population, "all-observed-including-incomplete");
  assert.equal(result.summary.totalObserved, 5);
  assert.equal(result.summary.completed, 4);
  assert.equal(result.summary.incomplete, 1);
  assert.deepEqual(result.programs, [
    { programKey: auto, programName: "Auto 2", count: 2 },
    { programKey: eco, programName: "Eco 50", count: 2 },
    { programKey: null, programName: null, count: 1 },
  ]);
  assert.deepEqual(result.mostUsedPrograms, [auto, eco]);
  assert.equal(result.history.continuousCoverageKnown, false);
  assert.equal(result.summarizedAt, now.toISOString());
  assert.equal(result.interval.from, null);
  assert.equal(result.interval.to, null);
  const unknown = buildCycleAnalytics([
    cycle(1, { programKey: "" }), cycle(2, { programKey: undefined }), cycle(3),
  ]);
  assert.deepEqual(unknown.mostUsedPrograms, [null]);
  assert.equal(unknown.programs[0].count, 2);
  assert.deepEqual(buildCycleAnalytics([
    cycle(1), cycle(2, { programKey: null }),
  ]).mostUsedPrograms, [null, eco]);
});

test("supports specific and aggregate scopes, historical appliances, and known empty appliances", () => {
  const history = [
    ...Array.from({ length: 130 }, (_, index) => cycle(index)),
    cycle(130, { applianceId: "old", applianceName: "Old", programKey: auto }),
  ];
  const appliances = [{ id: "new", name: "New" }];
  const all = buildCycleAnalytics(history, appliances, {}, now);
  assert.equal(all.summary.totalObserved, 131);
  assert.deepEqual(all.summary.appliances.map((item) => item.applianceId), ["kitchen", "new", "old"]);
  const selected = buildCycleAnalytics(history, appliances, { applianceId: "old" }, now);
  assert.equal(selected.summary.totalObserved, 1);
  assert.deepEqual(selected.mostUsedPrograms, [auto]);
  assert.equal(selected.history.appliances.length, 1);
  const empty = buildCycleAnalytics(history, appliances, { applianceId: "new" }, now);
  assert.equal(empty.summary.totalObserved, 0);
  assert.deepEqual(empty.programs, []);
  assert.deepEqual(empty.mostUsedPrograms, []);
  assert.equal(empty.history.earliestObservedAt, null);
  assert.throws(() => buildCycleAnalytics(history, [], { applianceId: "missing" }), /Unknown appliance/);
  assert.equal(buildCycleAnalytics([]).summary.totalObserved, 0);
});

test("this week starts Monday locally and excludes the upper boundary and prior starts", () => {
  const result = buildCycleAnalytics([
    cycle(1, { startedAt: "2026-10-25T22:59:59.999Z" }),
    cycle(2, { startedAt: "2026-10-25T23:00:00.000Z" }),
    cycle(3, { startedAt: now.toISOString() }),
    cycle(4, { startedAt: "2026-10-30T12:00:00.000Z" }),
    cycle(5, { startedAt: null, startConfidence: "missing", durationSeconds: null,
      firstObservedAt: "2026-10-27T18:00:00.000Z",
      lastObservedAt: "2026-10-27T21:00:00.000Z",
      finishedAt: "2026-10-27T21:00:00.000Z" }),
    cycle(6, { status: "running", result: "unknown", finishedAt: null,
      finishConfidence: "missing", durationSeconds: null }),
  ], [], { period: "this-week" }, now);
  assert.equal(result.interval.timeZone, "Europe/Prague");
  assert.equal(result.interval.from, "2026-10-25T23:00:00.000Z");
  assert.equal(result.interval.to, now.toISOString());
  assert.equal(result.summary.totalObserved, 3);
  assert.equal(result.summary.completed, 2);
  assert.equal(result.summary.running, 1);
  assert.equal(result.missingStartFallbackCount, 1);
  assert.equal(result.summary.missingFinishBoundaries, 1);
  assert.equal(result.history.totalObserved, 6);
  assert.equal(result.countingBasis, "startedAt-or-firstObservedAt");
});

test("weekly boundaries honor timezone, year rollover, and daylight-saving transitions", () => {
  for (const [instant, zone, expected] of [
    ["2026-03-29T12:00:00.000Z", "Europe/Prague", "2026-03-22T23:00:00.000Z"],
    ["2026-03-30T12:00:00.000Z", "Europe/Prague", "2026-03-29T22:00:00.000Z"],
    ["2026-10-25T12:00:00.000Z", "Europe/Prague", "2026-10-18T22:00:00.000Z"],
    ["2026-10-26T12:00:00.000Z", "Europe/Prague", "2026-10-25T23:00:00.000Z"],
    ["2026-01-01T12:00:00.000Z", "Europe/Prague", "2025-12-28T23:00:00.000Z"],
    ["2026-10-25T23:30:00.000Z", "America/New_York", "2026-10-19T04:00:00.000Z"],
    ["2026-10-26T12:00:00.000Z", "Asia/Kathmandu", "2026-10-25T18:15:00.000Z"],
    ["2026-10-26T00:00:00.000Z", "UTC", "2026-10-26T00:00:00.000Z"],
  ]) {
    const result = buildCycleAnalytics([], [], { period: "this-week", timeZone: zone },
      new Date(instant));
    assert.equal(result.interval.from, expected);
    assert.equal(result.interval.to, instant);
  }
  const serviceDefault = buildCycleAnalytics([], [], { period: "this-week" }, now, "UTC");
  assert.equal(serviceDefault.interval.from, "2026-10-26T00:00:00.000Z");
});

test("custom ranges normalize offsets and use start/fallback membership, not completion", () => {
  const options = { period: "range", from: "2026-10-26T00:00:00+01:00",
    to: "2026-10-27T00:00:00+01:00" };
  const result = buildCycleAnalytics([
    cycle(1, { startedAt: "2026-10-25T23:00:00Z", finishedAt: "2026-10-28T21:00:00.000Z" }),
    cycle(2, { startedAt: "2026-10-26T23:00:00Z" }),
    cycle(3, { startedAt: "2026-10-25T22:59:59.999Z", finishedAt: "2026-10-26T21:00:00.000Z" }),
    cycle(4, { startedAt: null, startConfidence: "missing", durationSeconds: null,
      firstObservedAt: "2026-10-26T12:00:00.000Z", finishConfidence: "inferred",
      observationGaps: [{ startedAt: "2026-10-26T13:00:00.000Z", endedAt: null }] }),
  ], [], options, now);
  assert.equal(result.summary.totalObserved, 2);
  assert.equal(result.summary.inferredCompletions, 1);
  assert.equal(result.summary.cyclesWithObservationGaps, 1);
  assert.equal(result.missingStartFallbackCount, 1);
  assert.equal(result.interval.from, "2026-10-25T23:00:00.000Z");
  assert.equal(result.interval.to, "2026-10-26T23:00:00.000Z");
});

test("rejects malformed options/history/analytics rather than returning success-shaped zeroes", () => {
  for (const options of [
    { period: "range" }, { period: "range", from: now.toISOString() },
    { period: "all", to: now.toISOString() }, { period: "yesterday" },
    { period: "range", from: now.toISOString(), to: now.toISOString() },
    { period: "range", from: "2026-10-30T00:00:00Z", to: now.toISOString() },
    { period: "range", from: "2026-10-26", to: now.toISOString() },
    { timeZone: "bad/timezone" }, { applianceId: ["kitchen"] }, { extra: "unused" },
  ]) {
    assert.throws(() => parseCycleAnalyticsOptions(options), /Invalid cycle analytics options/);
  }
  for (const history of [null, {}, [cycle(1, { programKey: 123 })], [cycle(1), cycle(1)]]) {
    assert.throws(() => buildCycleAnalytics(history), /Invalid persisted cycle history/);
  }
  const empty = buildCycleAnalytics([], [], {}, now);
  for (const data of [null, {}, { ...empty, programs: null },
    { ...empty, mostUsedPrograms: [eco] },
    { ...empty, missingStartFallbackCount: 1 },
    { ...empty, programs: [{ programKey: eco, programName: "Eco 50", count: 1 }] },
    { ...empty, interval: { ...empty.interval, from: now.toISOString() } }]) {
    assert.throws(() => validateCycleAnalytics(data), /missing or invalid cycle analytics/);
  }
});

test("MCP analytics uses selected-source API, preserves options and returns explicit errors", async (t) => {
  let payload = buildCycleAnalytics([cycle(1)], [], { applianceId: "kitchen" }, now);
  let status = 200;
  const requests = [];
  const dashboardClient = new DashboardClient({
    target: "azure", baseUrl: "https://dishwasher.example",
    tokenProvider: { async getAccessToken() { return "test-token"; } },
    fetchImplementation: async (url, options) => {
      requests.push({ url, options });
      return Response.json(payload, { status });
    },
  });
  const server = createDishwasherMcpServer({ dashboardClient });
  const client = new Client({ name: "analytics-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tool = (await client.listTools()).tools.find((item) =>
    item.name === "get_dishwasher_cycle_analytics");
  assert.equal(tool.annotations.readOnlyHint, true);
  const call = (args = {}) => client.callTool({ name: tool.name, arguments: args });
  const result = await call({ applianceId: "kitchen" });
  assert.deepEqual(result.structuredContent, { source: "azure", ...payload });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(requests[0].url.pathname, "/api/cycles/analytics");
  assert.equal(requests[0].url.searchParams.get("applianceId"), "kitchen");
  assert.equal(requests[0].url.searchParams.get("period"), "all");
  assert.ok(requests[0].options.headers.Authorization);
  assert.equal(requests[0].options.redirect, "manual");
  for (const options of [
    { period: "this-week", timeZone: "Europe/Prague" },
    { period: "range", timeZone: "UTC", from: "2026-10-25T00:00:00+02:00",
      to: "2026-10-29T00:00:00Z" },
  ]) {
    payload = buildCycleAnalytics([cycle(1)], [], options, now);
    assert.deepEqual((await call(options)).structuredContent, { source: "azure", ...payload });
    const query = requests.at(-1).url.searchParams;
    for (const [key, value] of Object.entries(options)) assert.equal(query.get(key), value);
  }
  payload = buildCycleAnalytics([], [], {}, now);
  assert.equal((await call()).structuredContent.summary.totalObserved, 0);
  const before = requests.length;
  assert.equal((await call({ period: "range" })).isError, true);
  assert.equal(requests.length, before);
  for (const invalid of [null, {}, { ...payload, programs: null }]) {
    payload = invalid;
    const failed = await call();
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent, undefined);
    assert.match(failed.content[0].text, /missing or invalid cycle analytics/);
  }
  payload = {};
  status = 503;
  assert.match((await call()).content[0].text, /HTTP 503/);
  assert.ok(requests.every(({ url }) => url.origin === "https://dishwasher.example"));
});

test("analytics client refuses responses with a different appliance or interval", async () => {
  const payload = buildCycleAnalytics([cycle(1)], [], {}, now);
  const client = new DashboardClient({
    target: "local", baseUrl: "http://localhost:3000",
    fetchImplementation: async () => Response.json(payload),
  });
  await assert.rejects(client.getCycleAnalytics({ applianceId: "other" }), /different scope or interval/);
  await assert.rejects(client.getCycleAnalytics({ period: "this-week" }), /different scope or interval/);
  await assert.rejects(client.getCycleAnalytics({ timeZone: "UTC" }), /different scope or interval/);
});

test("advisor routes weekly and program-popularity questions to analytics with uncertainty", async () => {
  const instructions = await readFile(
    new URL("../.github/agents/dishwasher.agent.md", import.meta.url), "utf8",
  );
  assert.match(instructions, /Call `get_dishwasher_cycle_analytics`/);
  assert.match(instructions, /mostUsedPrograms/);
  assert.match(instructions, /missingStartFallbackCount/);
  assert.match(instructions, /Monday/);
});

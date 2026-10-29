import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCycleSummary, selectCycleSummary } from "../src/cycle-summary.js";
import { DashboardClient } from "../src/mcp/dashboard.js";
import { createDishwasherMcpServer } from "../src/mcp/server.js";
import { Storage } from "../src/storage.js";

const now = new Date("2026-10-29T20:00:00.000Z");

function cycle(index, overrides = {}) {
  return {
    cycleId: `cycle-${index}`,
    applianceId: "dishwasher-1",
    applianceName: "Kitchen dishwasher",
    status: "finished",
    result: "finished",
    startedAt: "2026-10-10T19:00:00.000Z",
    finishedAt: "2026-10-10T22:00:00.000Z",
    durationSeconds: 10_800,
    firstObservedAt: "2026-10-10T19:00:00.000Z",
    lastObservedAt: "2026-10-10T22:00:00.000Z",
    startConfidence: "observed",
    finishConfidence: "observed",
    observationGaps: [],
    startEvidence: [],
    finishEvidence: [],
    sourceEventIds: [],
    pendingTerminalSignals: [],
    ...overrides,
  };
}

function fixture() {
  const unfinished = {
    result: "unknown", finishedAt: null, finishConfidence: "missing", durationSeconds: null,
  };
  return [
    cycle(1),
    cycle(2, { finishConfidence: "inferred", durationSeconds: null }),
    cycle(3, { startedAt: null, startConfidence: "missing", durationSeconds: null }),
    cycle(4, { observationGaps: [{
      startedAt: "2026-10-10T20:00:00.000Z", endedAt: "2026-10-10T21:00:00.000Z",
    }] }),
    cycle(5, { ...unfinished, status: "running" }),
    cycle(6, { ...unfinished, status: "incomplete" }),
    cycle(7, { ...unfinished, status: "incomplete", result: "superseded" }),
  ];
}

test("reconciles all observed records without conflating results and boundaries", () => {
  const summary = buildCycleSummary(fixture(), [], now);
  assert.deepEqual({
    totalObserved: summary.totalObserved,
    completed: summary.completed,
    running: summary.running,
    incomplete: summary.incomplete,
  }, { totalObserved: 7, completed: 4, running: 1, incomplete: 2 });
  assert.equal(summary.inferredCompletions, 1);
  assert.equal(summary.completeBoundaries, 2);
  assert.equal(summary.missingStartBoundaries, 1);
  assert.equal(summary.missingFinishBoundaries, 3);
  assert.equal(summary.cyclesWithObservationGaps, 1);
  assert.equal(summary.earliestObservedAt, "2026-10-10T19:00:00.000Z");
  assert.equal(summary.latestObservedAt, "2026-10-10T22:00:00.000Z");
  assert.equal(summary.summarizedAt, now.toISOString());
  assert.equal(summary.monitoringStartedAt, null);
  assert.equal(summary.continuousCoverageKnown, false);
  assert.equal(summary.appliances[0].applianceId, "dishwasher-1");
});

test("counts more than 100 cycles, scopes multiple appliances, and retains empty known appliances", () => {
  const history = Array.from({ length: 135 }, (_, index) => cycle(index));
  history.push(cycle(136, {
    applianceId: "dishwasher-2", applianceName: "Second",
    firstObservedAt: "2026-10-01T19:00:00.000Z",
    lastObservedAt: "2026-10-28T22:00:00.000Z",
  }));
  const summary = buildCycleSummary(history, [{ id: "dishwasher-3", name: "New" }], now);
  assert.equal(summary.totalObserved, 136);
  assert.equal(summary.appliances.length, 3);
  assert.equal(summary.earliestObservedAt, "2026-10-01T19:00:00.000Z");
  assert.equal(summary.latestObservedAt, "2026-10-28T22:00:00.000Z");
  const selected = selectCycleSummary(summary, "dishwasher-2");
  assert.equal(selected.totalObserved, 1);
  assert.equal(selected.appliances.length, 1);
  assert.equal(selected.summarizedAt, summary.summarizedAt);
  assert.equal(selectCycleSummary(summary, "dishwasher-3").totalObserved, 0);
  assert.throws(() => selectCycleSummary(summary, "unknown"), /Unknown appliance ID/);
});

test("distinguishes empty history from missing, malformed, or inconsistent data", () => {
  const empty = buildCycleSummary([], [], now);
  assert.equal(empty.totalObserved, 0);
  assert.equal(empty.earliestObservedAt, null);
  assert.equal(empty.latestObservedAt, null);
  assert.deepEqual(selectCycleSummary(empty), empty);
  for (const invalid of [undefined, null, {}, [null], [cycle(1, { status: "invalid" })],
    [cycle(1, { firstObservedAt: "invalid" })], [cycle(1, { observationGaps: null })],
    [cycle(1, { result: "unknown" })], [cycle(1), cycle(1)]]) {
    assert.throws(() => buildCycleSummary(invalid, [], now), /Invalid persisted cycle history/);
  }
  for (const invalid of [undefined, null, {}, { ...empty, totalObserved: 1 },
    { ...empty, appliances: [{ ...buildCycleSummary(fixture()).appliances[0] }] },
    { ...empty, earliestObservedAt: "invalid" }]) {
    assert.throws(() => selectCycleSummary(invalid), /missing or invalid cycle summary/);
  }
});

test("malformed persisted local history cannot silently become an empty array", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cycle-summary-storage-"));
  t.after(() => rm(directory, { recursive: true }));
  const file = path.join(directory, "store.json");
  await writeFile(file, JSON.stringify({ cycles: null }));
  await assert.rejects(new Storage("local", "unused", file).initialize(), /Unable to read local storage/);
});

async function startApi(t, cycles) {
  const directory = await mkdtemp(path.join(tmpdir(), "cycle-summary-api-"));
  t.after(() => rm(directory, { recursive: true }));
  await mkdir(path.join(directory, ".data"));
  await writeFile(path.join(directory, ".data/dishwasher-loop.json"), JSON.stringify({
    events: [], cycles,
  }));
  const child = spawn(process.execPath, [
    new URL("../src/server.js", import.meta.url).pathname,
  ], {
    cwd: directory,
    env: {
      ...process.env,
      HOME_CONNECT_CLIENT_ID: "test",
      HOME_CONNECT_CLIENT_SECRET: "test",
      HOME_CONNECT_REDIRECT_URI: "http://localhost/auth/callback",
      COOKIE_SECRET: "test-cookie-secret-at-least-32-characters",
      AZURE_STORAGE_CONNECTION_STRING: "local",
      REQUIRE_MICROSOFT_AUTH: "true",
      APP_ALLOWED_PRINCIPAL_IDS: "test-user",
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service startup timed out: ${logs}`)), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Service exited ${code}: ${logs}`));
    });
    child.stdout.on("data", () => {
      const match = logs.match(/listening on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return `http://localhost:${port}`;
}

test("authenticated summary API uses all durable records and dashboard shares the contract", async (t) => {
  const base = await startApi(t, [
    ...fixture(), ...Array.from({ length: 110 }, (_, index) => cycle(index + 10)),
  ]);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/api/cycles/summary`)).status, 401);
  assert.equal((await fetch(`${base}/api/cycles/summary`, {
    headers: { "x-ms-client-principal-id": "not-allowed" },
  })).status, 403);
  const headers = { "x-ms-client-principal-id": "test-user" };
  const response = await fetch(`${base}/api/cycles/summary`, { headers });
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.totalObserved, 117);
  assert.equal(summary.completed, 114);
  const dashboard = await (await fetch(`${base}/api/dashboard`, { headers })).json();
  assert.equal(dashboard.cycles.length, 20);
  assert.equal(dashboard.cycleSummary.totalObserved, summary.totalObserved);
  assert.equal(dashboard.cycleSummary.incomplete, 2);
  assert.equal((await fetch(`${base}/api/cycles/analytics`)).status, 401);
  assert.equal((await fetch(`${base}/api/cycles/analytics`, {
    headers: { "x-ms-client-principal-id": "not-allowed" },
  })).status, 403);
  const analyticsResponse = await fetch(`${base}/api/cycles/analytics?applianceId=dishwasher-1`, { headers });
  assert.equal(analyticsResponse.status, 200);
  const analytics = await analyticsResponse.json();
  assert.equal(analytics.summary.totalObserved, 117);
  assert.equal(analytics.history.totalObserved, 117);
  assert.deepEqual(analytics.programs, [{ programKey: null, programName: null, count: 117 }]);
  const range = await fetch(`${base}/api/cycles/analytics?period=range&from=2026-10-01T00:00:00Z&to=2026-10-11T00:00:00Z&timeZone=UTC`, { headers });
  assert.equal(range.status, 200);
  assert.equal((await range.json()).summary.totalObserved, 117);
  const weekly = await fetch(`${base}/api/cycles/analytics?period=this-week&timeZone=Europe%2FPrague`, { headers });
  assert.equal(weekly.status, 200);
  assert.equal((await weekly.json()).interval.period, "this-week");
  for (const query of ["period=range", "timeZone=invalid", "period=all&from=invalid",
    "applianceId=a&applianceId=b"]) {
    const invalid = await fetch(`${base}/api/cycles/analytics?${query}`, { headers });
    assert.equal(invalid.status, 400);
    assert.ok((await invalid.json()).error);
  }
  const recent = await (await fetch(`${base}/api/cycles?limit=100`, { headers })).json();
  assert.equal(recent.cycles.length, 100);
  const dashboardClient = new DashboardClient({
    target: "local",
    baseUrl: base,
    fetchImplementation: async (url) => {
      assert.equal(url.href, `${base}/api/cycles/summary`);
      return Response.json(summary);
    },
  });
  const server = createDishwasherMcpServer({ dashboardClient });
  const client = new Client({ name: "snapshot-reconciliation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "get_dishwasher_cycle_summary", arguments: { applianceId: "dishwasher-1" },
    });
    assert.deepEqual(result.structuredContent, { source: "local", ...summary });
  } finally {
    await client.close();
    await server.close();
  }
});

test("summary API distinguishes true empty history from malformed persisted records", async (t) => {
  const headers = { "x-ms-client-principal-id": "test-user" };
  const emptyBase = await startApi(t, []);
  const empty = await fetch(`${emptyBase}/api/cycles/summary`, { headers });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).totalObserved, 0);
  const emptyAnalytics = await fetch(`${emptyBase}/api/cycles/analytics`, { headers });
  assert.equal(emptyAnalytics.status, 200);
  assert.equal((await emptyAnalytics.json()).summary.totalObserved, 0);
  const invalidBase = await startApi(t, [cycle(1, { status: "invalid" })]);
  const invalid = await fetch(`${invalidBase}/api/cycles/summary`, { headers });
  assert.equal(invalid.status, 500);
  const error = await invalid.json();
  assert.ok(error.error);
  assert.equal(error.totalObserved, undefined);
  const invalidAnalytics = await fetch(`${invalidBase}/api/cycles/analytics`, { headers });
  assert.equal(invalidAnalytics.status, 500);
  assert.ok((await invalidAnalytics.json()).error);
});

test("MCP returns compact structured selected-source summaries and actionable failures", async () => {
  let payload = buildCycleSummary(fixture(), [], now);
  let status = 200;
  const requests = [];
  const dashboardClient = new DashboardClient({
    target: "azure",
    baseUrl: "https://dishwasher.example",
    tokenProvider: { async getAccessToken() { return "test-token"; } },
    fetchImplementation: async (url, options) => {
      requests.push({ url, options });
      return Response.json(payload, { status });
    },
  });
  const server = createDishwasherMcpServer({ dashboardClient });
  const client = new Client({ name: "cycle-summary-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tool = (await client.listTools()).tools.find(
      (item) => item.name === "get_dishwasher_cycle_summary",
    );
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.match(tool.description, /observed so far/);
    const call = (args = {}) => client.callTool({
      name: "get_dishwasher_cycle_summary", arguments: args,
    });
    const result = await call({ applianceId: "dishwasher-1" });
    assert.deepEqual(result.structuredContent, {
      source: "azure", ...payload,
    });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.ok(JSON.stringify(result.structuredContent).length < 2_000);
    assert.equal(requests[0].url.href, "https://dishwasher.example/api/cycles/summary");
    assert.equal(requests[0].options.redirect, "manual");
    assert.ok(requests[0].options.headers.Authorization);
    const unknown = await call({ applianceId: "unknown" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Unknown appliance/);
    payload = buildCycleSummary([], [], now);
    assert.equal((await call()).structuredContent.totalObserved, 0);
    for (const invalid of [null, {}, { ...payload, completed: 7 }]) {
      payload = invalid;
      const failed = await call();
      assert.equal(failed.isError, true);
      assert.equal(failed.structuredContent, undefined);
      assert.match(failed.content[0].text, /missing or invalid cycle summary/);
    }
    status = 503;
    const before = requests.length;
    const failed = await call();
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /HTTP 503/);
    assert.equal(requests.length, before + 1);
    assert.ok(requests.every((request) => request.url.origin === "https://dishwasher.example"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("Azure summary reads preserve auth errors and never retry locally or return zero", async () => {
  for (const [response, expected] of [
    [() => new Response(null, { status: 401 }), /rejected the Microsoft access token/],
    [() => new Response(null, { status: 403 }), /not allowed/],
    [() => new Response(null, { status: 302 }), /redirect instead of API data/],
    [() => new Response("<html>login</html>"), /non-JSON response/],
    [() => new Response("{", { headers: { "content-type": "application/json" } }), /malformed JSON/],
    [() => { throw new Error("offline"); }, /Check the Azure base URL/],
  ]) {
    let calls = 0;
    const client = new DashboardClient({
      target: "azure",
      baseUrl: "https://dishwasher.example",
      tokenProvider: { async getAccessToken() { return "test-token"; } },
      fetchImplementation: async (url) => {
        calls += 1;
        assert.equal(url.origin, "https://dishwasher.example");
        return response();
      },
    });
    await assert.rejects(client.getCycleSummary(), expected);
    assert.equal(calls, 1);
  }
});

test("advisor routes observed-so-far questions to durable summary, not inventory or events", async () => {
  const instructions = await readFile(
    new URL("../.github/agents/dishwasher.agent.md", import.meta.url), "utf8",
  );
  assert.match(instructions, /Call `get_dishwasher_cycle_summary`/);
  assert.match(instructions, /How many washing cycles have been observed so far/);
  assert.match(instructions, /Never infer totals from capsule inventory, recent events/);
  assert.match(instructions, /`totalObserved` from `completed`, `running`,/);
  assert.match(instructions, /continuous coverage is not established/);
  assert.match(instructions, /an error, never a zero count/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildSupplyForecast, validateSupplyForecast } from "../src/supply-forecast.js";
import { buildDishwasherOverview, DashboardClient } from "../src/mcp/dashboard.js";
import { createDishwasherMcpServer } from "../src/mcp/server.js";
import { buildRecommendations } from "../public/components/recommendations.js";
import { renderSuppliesCard } from "../public/components/supplies.js";
import { capsuleRecommendation, capsuleState } from "../public/lib/supply.js";

const now = new Date("2026-10-30T19:00:00.000Z");
const day = 86_400_000;
const at = (days) => new Date(now.valueOf() - days * day).toISOString();
function cycle(index, days = 1, overrides = {}) {
  return {
    cycleId: `cycle-${index}`, applianceId: "kitchen", applianceName: "Kitchen",
    status: "finished", result: "finished", programKey: null,
    firstObservedAt: at(days), lastObservedAt: at(days - 0.1),
    startedAt: at(days), finishedAt: at(days - 0.1),
    startConfidence: "observed", finishConfidence: "observed",
    durationSeconds: 8640, observationGaps: [], ...overrides,
  };
}
function history(total = 28) {
  return Array.from({ length: total }, (_, index) => cycle(index, index === 0 ? 29 : 1));
}
function forecast(count, records = history()) {
  return buildSupplyForecast(records, count, [], now);
}

test("calculates rolling consumption and exact reorder boundary, not the legacy stock threshold", () => {
  const records = history(29);
  const result = forecast(7, records);
  assert.equal(result.window.completedCycles, 28);
  assert.equal(result.window.observedDays, 28);
  assert.equal(result.capsulesPerDay, 1);
  assert.equal(result.estimatedDaysRemaining, 7);
  assert.equal(result.action, "order");
  assert.equal(result.reason, "within-reorder-window");
  assert.equal(result.policy.reorderThresholdDays, result.policy.deliveryDays + result.policy.safetyBufferDays);
  assert.equal(forecast(8, records).action, "none");
  const lowUsage = [cycle(1, 28), cycle(2, 14), cycle(3, 1)];
  assert.equal(forecast(5, lowUsage).action, "none");
  assert.equal(capsuleState(5, forecast(5, lowUsage)), "ok");
  assert.equal(capsuleRecommendation(5, forecast(5, lowUsage)), null);
});

test("shortens window to available history and applies minimum days/cycles without fake zero rates", () => {
  const records = [cycle(1, 7), cycle(2, 3), cycle(3, 1)];
  const result = forecast(3, records);
  assert.equal(result.window.observedDays, 7);
  assert.equal(result.capsulesPerDay, 3 / 7);
  assert.equal(result.estimatedDaysRemaining, 7);
  assert.equal(result.action, "order");
  for (const short of [[cycle(1, 6.99), cycle(2), cycle(3)], [cycle(1, 8), cycle(2)], []]) {
    const insufficient = forecast(8, short);
    assert.equal(insufficient.status, "insufficient-history");
    assert.equal(insufficient.capsulesPerDay, null);
    assert.equal(insufficient.estimatedDaysRemaining, null);
    assert.equal(insufficient.action, "unknown");
  }
  assert.equal(forecast(4, []).reason, "stock-only-low");
  assert.equal(forecast(0, []).reason, "out-of-stock");
  assert.equal(forecast(0, []).action, "order");
  assert.match(capsuleRecommendation(4, forecast(4, [])).text, /pouze podle počtu zásob/);
  assert.equal(forecast(6, []).action, "unknown");
});

test("counts completions across shared appliances, flags inference, gaps and unfinished records", () => {
  const records = [cycle(1, 10), cycle(2, 4, {
    applianceId: "old", applianceName: "Old", startedAt: null,
    startConfidence: "missing", finishConfidence: "inferred", durationSeconds: null,
  }), cycle(3, 2, { programKey: "Dishcare.Dishwasher.Program.PreRinse",
    observationGaps: [{ startedAt: at(2), endedAt: null }] }),
  cycle(4, 3, { status: "incomplete", result: "unknown", finishedAt: null,
    finishConfidence: "missing", durationSeconds: null }),
  cycle(5, 1, { status: "running", result: "unknown", finishedAt: null,
    finishConfidence: "missing", durationSeconds: null })];
  const result = forecast(2, records);
  assert.equal(result.scope, "shared-stock-all-appliances");
  assert.deepEqual(result.history.appliances.map((item) => item.applianceId), ["kitchen", "old"]);
  assert.equal(result.window.completedCycles, 3);
  assert.equal(result.window.inferredCompletions, 1);
  assert.equal(result.window.unfinishedRecords, 2);
  assert.equal(result.window.cyclesWithObservationGaps, 1);
  assert.deepEqual(result.uncertainty, ["continuous-coverage-unknown",
    "one-tablet-per-completion-assumption", "inferred-completions", "unfinished-records", "observation-gaps"]);
  assert.equal(result.policy.capsulesPerCompletedCycle, 1);
});

test("uses completion time [from,to) and elapsed days, not local calendar/DST day counts", () => {
  const records = [cycle(0, 40), cycle(1, 30, {
    finishedAt: at(28), lastObservedAt: at(28),
  }), cycle(2, 2, { finishedAt: at(0), lastObservedAt: at(0) }),
  cycle(3, 28.2), cycle(4, 1), cycle(5, 1)];
  const result = forecast(20, records);
  assert.equal(result.window.completedCycles, 3);
  assert.equal(result.window.from, at(28));
  assert.equal(result.window.to, at(0));
  assert.equal(result.window.observedDays, 28);
  const fractional = buildSupplyForecast([cycle(1, 12.34567), cycle(2), cycle(3)], 8, [], now);
  assert.equal(fractional.status, "estimated");
});

test("zero observed usage and invalid inventory/history are explicit limitations or errors", () => {
  const noUsage = forecast(20, [cycle(1, 40)]);
  assert.equal(noUsage.status, "no-observed-usage");
  assert.equal(noUsage.capsulesPerDay, null);
  assert.equal(noUsage.action, "unknown");
  for (const count of [null, undefined, -1, 1000, 1.2, "8"]) {
    const result = forecast(count);
    assert.equal(result.inventoryCount, null);
    assert.equal(result.status, "inventory-unavailable");
    assert.equal(result.action, "unknown");
    assert.equal(result.estimatedDaysRemaining, null);
  }
  assert.throws(() => forecast(8, null), /Invalid persisted cycle history/);
  assert.throws(() => forecast(8, [cycle(1), cycle(1)]), /Invalid persisted cycle history/);
  const good = forecast(7, history(29));
  for (const bad of [null, {}, { ...good, action: "none" },
    { ...good, estimatedDaysRemaining: 999 }, { ...good, uncertainty: [] },
    { ...good, policy: { ...good.policy, reorderThresholdDays: 8 } }]) {
    assert.throws(() => validateSupplyForecast(bad, 7), /invalid supply forecast/);
  }
  assert.throws(() => validateSupplyForecast(good, 9), /invalid supply forecast/);
});

test("dashboard and overview agree, including no live diagnostics and stale inventory edits", () => {
  const result = forecast(7, history(29));
  const dashboard = { authorized: true, events: [], diagnostics: [], capsuleCount: 7,
    monitorStatus: "Ready", supplyForecast: result };
  const overview = buildDishwasherOverview(dashboard, now.valueOf());
  assert.deepEqual(overview.recommendations, buildRecommendations(dashboard, now.valueOf()));
  assert.equal(overview.supplies.dishwasherCapsules.forecast.action, "order");
  assert.equal(overview.supplies.dishwasherCapsules.state, "low");
  assert.match(renderSuppliesCard([], 7, result), /capsule-count low/);
  assert.match(overview.recommendations.at(-1).text, /Objednejte nyní/);
  assert.match(overview.recommendations.at(-1).text, /všech myček/);
  assert.equal(capsuleState(100, result), "ok");
  assert.doesNotMatch(capsuleRecommendation(100, result).text, /Objednejte nyní/);
  assert.throws(() => buildDishwasherOverview({ ...dashboard, supplyForecast: {} }), /invalid supply forecast/);
  const missing = buildDishwasherOverview({ ...dashboard, capsuleCount: null,
    supplyForecast: forecast(null) });
  assert.equal(missing.supplies.dishwasherCapsules.forecast.status, "inventory-unavailable");
});

test("MCP status includes grounded supply action from one dashboard fetch and preserves failures", async (t) => {
  let calls = 0;
  let payload = { authorized: true, events: [], diagnostics: [], capsuleCount: 7,
    monitorStatus: "Ready", supplyForecast: forecast(7, history(29)) };
  const dashboardClient = new DashboardClient({ target: "local", baseUrl: "http://localhost:3000",
    fetchImplementation: async () => { calls++; return Response.json(payload); } });
  const server = createDishwasherMcpServer({ dashboardClient });
  const client = new Client({ name: "supply-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(left), server.connect(right)]);
  const result = await client.callTool({ name: "get_dishwasher_overview", arguments: {} });
  assert.equal(calls, 1);
  assert.equal(result.structuredContent.source, "local");
  assert.equal(result.structuredContent.supplies.dishwasherCapsules.forecast.action, "order");
  assert.match(result.structuredContent.recommendations.at(-1).text, /Objednejte nyní/);
  payload = { ...payload, supplyForecast: null };
  const failed = await client.callTool({ name: "get_dishwasher_overview", arguments: {} });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent, undefined);
});

test("advisor presents backend supply actions without purchasing or inventing rules", async () => {
  const instructions = await readFile(new URL("../.github/agents/dishwasher.agent.md", import.meta.url), "utf8");
  assert.match(instructions, /recommended supply action/);
  assert.match(instructions, /not your own reorder rule/);
  assert.match(instructions, /stock-only-low/);
  assert.match(instructions, /Do not purchase, change inventory/);
});

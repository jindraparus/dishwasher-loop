import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildDishwasherEvents,
  buildDishwasherOverview,
  DashboardClient,
} from "../src/mcp/dashboard.js";
import { createDishwasherMcpServer } from "../src/mcp/server.js";

test("maps dashboard state to a structured dishwasher overview", () => {
  const now = Date.parse("2026-10-11T07:00:00.000Z");
  const dashboard = dashboardFixture();
  const overview = buildDishwasherOverview(dashboard, now);

  assert.equal(overview.monitorStatus, "Sledována 1 myčka");
  assert.deepEqual(overview.supplies.dishwasherCapsules, {
    state: "low",
    count: 4,
  });
  assert.equal(overview.appliances[0].program.running, true);
  assert.equal(overview.appliances[0].program.name, "Eco 50");
  assert.equal(overview.appliances[0].program.remainingSeconds, 3_000);
  assert.equal(overview.appliances[0].program.estimatedFinishAt, "2026-10-11T07:50:00.000Z");
  assert.equal(overview.appliances[0].status[0].displayValue, "Probíhá");
  assert.deepEqual(
    overview.recommendations.map((recommendation) => recommendation.title),
    ["Doplňte sůl do myčky", "Doplňte tablety do myčky", "Probíhá mycí cyklus"],
  );
});

test("limits and sanitizes recent dishwasher events", () => {
  const dashboard = dashboardFixture();
  dashboard.events.push({
    applianceId: "dishwasher-1",
    applianceName: "Kitchen dishwasher",
    eventType: "EVENT",
    eventId: "event-2",
    receivedAt: "2026-10-11T06:59:00.000Z",
    data: { items: [] },
    internalValue: "must not leak",
  });

  const events = buildDishwasherEvents(dashboard, 1);

  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]), [
    "applianceId",
    "applianceName",
    "eventType",
    "eventId",
    "receivedAt",
    "data",
  ]);
});

test("does not report missing connectivity as connected", () => {
  const dashboard = dashboardFixture();
  delete dashboard.diagnostics[0].connected;

  const overview = buildDishwasherOverview(dashboard);

  assert.equal(overview.appliances[0].connected, null);
});

test("dashboard client reports unavailable, malformed, and unauthorized services", async (t) => {
  await t.test("unavailable local service", async () => {
    const client = new DashboardClient({
      fetchImplementation: async () => {
        throw new Error("connection refused");
      },
    });
    await assert.rejects(client.getDashboard(), /Start the local service with npm start/);
  });

  await t.test("non-JSON response", async () => {
    const client = new DashboardClient({
      fetchImplementation: async () => new Response("<html>wrong service</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    });
    await assert.rejects(client.getDashboard(), /non-JSON response/);
  });

  await t.test("incomplete payload", async () => {
    const client = new DashboardClient({
      fetchImplementation: async () => Response.json({ authorized: true }),
    });
    await assert.rejects(client.getDashboard(), /incomplete dashboard payload/);
  });

  await t.test("invalid appliance diagnostics", async () => {
    const dashboard = dashboardFixture();
    dashboard.diagnostics[0].statusItems = null;
    const client = new DashboardClient({
      fetchImplementation: async () => Response.json(dashboard),
    });
    await assert.rejects(client.getDashboard(), /invalid appliance diagnostics/);
  });

  await t.test("Home Connect authorization required", async () => {
    const client = new DashboardClient({
      fetchImplementation: async () => Response.json({
        ...dashboardFixture(),
        authorized: false,
      }),
    });
    await assert.rejects(client.getDashboard(), /Home Connect is not authorized/);
  });
});

test("MCP server exposes bounded read-only tools and actionable errors", async () => {
  const dashboardClient = {
    async getDashboard() {
      throw new Error("Local dashboard is unavailable for the test.");
    },
  };
  const documents = {
    async search() {
      return [];
    },
    async read() {
      return {};
    },
  };
  const server = createDishwasherMcpServer({ dashboardClient, documents });
  const client = new Client({ name: "dishwasher-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "get_dishwasher_overview",
      "list_dishwasher_events",
      "read_dishwasher_documentation",
      "search_dishwasher_documentation",
    ]);

    const result = await client.callTool({
      name: "get_dishwasher_overview",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Local dashboard is unavailable/);

    const invalidLimit = await client.callTool({
      name: "list_dishwasher_events",
      arguments: { limit: 51 },
    });
    assert.equal(invalidLimit.isError, true);
    assert.match(invalidLimit.content[0].text, /Invalid arguments/);
  } finally {
    await client.close();
    await server.close();
  }
});

function dashboardFixture() {
  return {
    authorized: true,
    monitorStatus: "Sledována 1 myčka",
    capsuleCount: 4,
    diagnostics: [{
      id: "dishwasher-1",
      name: "Kitchen dishwasher",
      brand: "Bosch",
      type: "Dishwasher",
      model: "SMV6",
      connected: true,
      statusItems: [{
        key: "BSH.Common.Status.OperationState",
        value: "BSH.Common.EnumType.OperationState.Run",
      }],
      statusError: "",
      consumables: {
        salt: { state: "low", label: "Brzy doplnit" },
        rinseAid: { state: "ok", label: "Dostatek" },
      },
      program: {
        activeKey: "Dishcare.Dishwasher.Program.Eco50",
        selectedKey: "Dishcare.Dishwasher.Program.Eco50",
        progress: 40,
        remainingSeconds: 3_000,
        remainingUpdatedAt: "2026-10-11T07:00:00.000Z",
      },
      lastEventType: "STATUS",
      lastEventAt: "2026-10-11T07:00:00.000Z",
    }],
    events: [{
      applianceId: "dishwasher-1",
      applianceName: "Kitchen dishwasher",
      eventType: "STATUS",
      eventId: "event-1",
      receivedAt: "2026-10-11T07:00:00.000Z",
      data: { items: [] },
    }],
  };
}

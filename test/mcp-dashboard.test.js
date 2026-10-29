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

test("uses target-specific dashboard timeouts", () => {
  const localClient = new DashboardClient({
    target: "local",
    baseUrl: "http://localhost:3000",
  });
  const azureClient = new DashboardClient({
    target: "azure",
    baseUrl: "https://dishwasher.example",
    tokenProvider: { async getAccessToken() {} },
  });

  assert.equal(localClient.timeoutMs, 5_000);
  assert.equal(azureClient.timeoutMs, 30_000);
});

test("dashboard client reports unavailable, malformed, and unauthorized services", async (t) => {
  await t.test("unavailable local service", async () => {
    const client = new DashboardClient({
      target: "local",
      baseUrl: "http://localhost:3000",
      fetchImplementation: async () => {
        throw new Error("connection refused");
      },
    });
    await assert.rejects(client.getDashboard(), /Start the local service with npm start/);
  });

  await t.test("non-JSON response", async () => {
    const client = new DashboardClient({
      target: "local",
      baseUrl: "http://localhost:3000",
      fetchImplementation: async () => new Response("<html>wrong service</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    });
    await assert.rejects(client.getDashboard(), /non-JSON response/);
  });

  await t.test("incomplete payload", async () => {
    const client = new DashboardClient({
      target: "local",
      baseUrl: "http://localhost:3000",
      fetchImplementation: async () => Response.json({ authorized: true }),
    });
    await assert.rejects(client.getDashboard(), /incomplete dashboard payload/);
  });

  await t.test("invalid appliance diagnostics", async () => {
    const dashboard = dashboardFixture();
    dashboard.diagnostics[0].statusItems = null;
    const client = new DashboardClient({
      target: "local",
      baseUrl: "http://localhost:3000",
      fetchImplementation: async () => Response.json(dashboard),
    });
    await assert.rejects(client.getDashboard(), /invalid appliance diagnostics/);
  });

  await t.test("Home Connect authorization required", async () => {
    const client = new DashboardClient({
      target: "local",
      baseUrl: "http://localhost:3000",
      fetchImplementation: async () => Response.json({
        ...dashboardFixture(),
        authorized: false,
      }),
    });
    await assert.rejects(client.getDashboard(), /Home Connect is not authorized/);
  });
});

test("Azure dashboard access uses a bearer token without falling back", async (t) => {
  await t.test("sends the delegated token and returns dashboard data", async () => {
    const requests = [];
    const client = new DashboardClient({
      target: "azure",
      baseUrl: "https://dishwasher.example",
      tokenProvider: {
        async getAccessToken() {
          return "secret-access-token";
        },
      },
      fetchImplementation: async (url, options) => {
        requests.push({ url, options });
        return Response.json(dashboardFixture());
      },
    });

    assert.deepEqual(await client.getDashboard(), dashboardFixture());
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.href, "https://dishwasher.example/api/dashboard");
    assert.equal(requests[0].options.headers.Authorization, "Bearer secret-access-token");
    assert.equal(requests[0].options.redirect, "manual");
  });

  await t.test("reports allowlist rejection", async () => {
    const client = azureClient(async () => new Response("forbidden", { status: 403 }));
    await assert.rejects(client.getDashboard(), /not allowed.*Azure allowlist/i);
  });

  await t.test("reports expired or invalid authentication", async () => {
    const client = azureClient(async () => new Response("unauthorized", { status: 401 }));
    await assert.rejects(client.getDashboard(), /rejected the Microsoft access token/);
  });

  await t.test("reports authentication redirects", async () => {
    const client = azureClient(async () => new Response(null, {
      status: 302,
      headers: { location: "https://login.microsoftonline.com/" },
    }));
    await assert.rejects(client.getDashboard(), /redirect instead of API data/);
  });

  await t.test("does not retry Azure failures against local", async () => {
    let calls = 0;
    const client = azureClient(async () => {
      calls += 1;
      throw new Error("network unavailable");
    });
    await assert.rejects(client.getDashboard(), /Azure base URL/);
    assert.equal(calls, 1);
  });
});

test("MCP server exposes bounded read-only tools and actionable errors", async () => {
  const dashboardClient = {
    source: "local",
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
      "get_dishwasher_cycle_analytics",
      "get_dishwasher_cycle_summary",
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

test("MCP handshake completes before Azure authentication and reports source metadata", async () => {
  let dashboardCalls = 0;
  const dashboardClient = {
    source: "azure",
    async getDashboard() {
      dashboardCalls += 1;
      return dashboardFixture();
    },
  };
  const server = createDishwasherMcpServer({
    dashboardClient,
    documents: {
      async search() {
        return [];
      },
      async read() {
        return {};
      },
    },
  });
  const client = new Client({ name: "dishwasher-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    assert.equal(dashboardCalls, 0);

    const overview = await client.callTool({
      name: "get_dishwasher_overview",
      arguments: {},
    });
    assert.equal(overview.structuredContent.source, "azure");
    assert.equal(dashboardCalls, 1);

    const events = await client.callTool({
      name: "list_dishwasher_events",
      arguments: { limit: 1 },
    });
    assert.equal(events.structuredContent.source, "azure");
  } finally {
    await client.close();
    await server.close();
  }
});

function azureClient(fetchImplementation) {
  return new DashboardClient({
    target: "azure",
    baseUrl: "https://dishwasher.example",
    tokenProvider: {
      async getAccessToken() {
        return "secret-access-token";
      },
    },
    fetchImplementation,
  });
}

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

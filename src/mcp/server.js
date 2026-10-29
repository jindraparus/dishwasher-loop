import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildDishwasherEvents,
  buildDishwasherOverview,
  DashboardClient,
} from "./dashboard.js";
import { AzureTokenProvider } from "./azure-auth.js";
import { loadMcpConfig } from "./config.js";
import { DishwasherDocuments } from "./documents.js";
import { cycleAnalyticsInput } from "../cycle-analytics.js";

const MAX_EVENT_LIMIT = 50;

export function createDishwasherMcpServer({
  dashboardClient,
  documents = new DishwasherDocuments(),
} = {}) {
  if (!dashboardClient) {
    throw new Error("A configured dashboard client is required.");
  }
  const server = new McpServer({
    name: "dishwasher-loop",
    version: "0.1.0",
  });

  server.registerTool("get_dishwasher_overview", {
    title: "Get dishwasher overview",
    description: "Get current dishwasher status, program, supplies, and recommendations.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  }, () => handleTool(async () => {
    const dashboard = await dashboardClient.getDashboard();
    return {
      source: dashboardClient.source,
      ...buildDishwasherOverview(dashboard),
    };
  }));

  server.registerTool("list_dishwasher_events", {
    title: "List dishwasher events",
    description: "List recent raw events, not washing-cycle totals. For observed so far or completed wash counts, use get_dishwasher_cycle_summary.",
    inputSchema: {
      limit: z.number().int().min(1).max(MAX_EVENT_LIMIT).default(20)
        .describe(`Maximum number of events to return, up to ${MAX_EVENT_LIMIT}.`),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  }, ({ limit }) => handleTool(async () => {
    const dashboard = await dashboardClient.getDashboard();
    return {
      source: dashboardClient.source,
      events: buildDishwasherEvents(dashboard, limit),
      limit,
    };
  }));

  server.registerTool("get_dishwasher_cycle_summary", {
    title: "Get observed dishwasher cycle totals",
    description: "Answer how many washing cycles have been observed so far from all persisted cycle history, not recent events or capsule inventory. Returns total observed, completed (including inferred finishes), running and incomplete counts, boundary uncertainty, observation gaps and appliance scope. For program popularity or weekly/date-range counts use get_dishwasher_cycle_analytics. Recorded history is not lifetime usage or proof of continuous monitoring.",
    inputSchema: {
      applianceId: z.string().trim().min(1).optional()
        .describe("Appliance ID from the overview or summary. Omit for explicitly aggregated totals across all recorded appliances."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  }, ({ applianceId }) => handleTool(async () => {
    return {
      source: dashboardClient.source,
      ...await dashboardClient.getCycleSummary(applianceId),
    };
  }));

  server.registerTool("get_dishwasher_cycle_analytics", {
    title: "Get dishwasher program usage and date-range cycle counts",
    description: "Answer most-used washing program and this-week or date-range cycle-count questions from persisted history. Counts all observed records, including incomplete ones, by startedAt with explicit firstObservedAt fallback for missing starts. Returns program counts, all ties (null means unknown), interval, appliance scope, full-history coverage and uncertainty. This week is Monday to now in the service timezone unless overridden. Not lifetime usage or proof of continuous monitoring.",
    inputSchema: cycleAnalyticsInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  }, (options) => handleTool(async () => ({
    source: dashboardClient.source,
    ...await dashboardClient.getCycleAnalytics(options),
  })));

  server.registerTool("search_dishwasher_documentation", {
    title: "Search dishwasher documentation",
    description: "Search locally available dishwasher manuals and guidance.",
    inputSchema: {
      query: z.string().trim().min(1).describe("Terms to search for."),
      limit: z.number().int().min(1).max(10).default(5)
        .describe("Maximum number of matching sections to return."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  }, ({ query, limit }) => handleTool(async () => ({
    query,
    matches: await documents.search(query, limit),
  })));

  server.registerTool("read_dishwasher_documentation", {
    title: "Read dishwasher documentation",
    description: "Read a document or exact section found by dishwasher documentation search.",
    inputSchema: {
      document: z.string().trim().min(1)
        .describe("Document path returned by search_dishwasher_documentation."),
      section: z.string().trim().min(1).optional()
        .describe("Exact heading or page returned by search; omit to read from the start."),
      maxCharacters: z.number().int().min(1_000).max(20_000).default(12_000)
        .describe("Maximum number of document characters to return."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  }, ({ document, section, maxCharacters }) => handleTool(
    () => documents.read(document, section, maxCharacters),
  ));

  return server;
}

async function handleTool(operation) {
  try {
    const result = await operation();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

async function main() {
  const config = loadMcpConfig();
  const tokenProvider = config.target === "azure"
    ? new AzureTokenProvider(config)
    : undefined;
  const dashboardClient = new DashboardClient({
    target: config.target,
    baseUrl: config.baseUrl,
    tokenProvider,
  });
  const server = createDishwasherMcpServer({ dashboardClient });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) {
  main().catch((error) => {
    console.error("Dishwasher Loop MCP server failed", error);
    process.exitCode = 1;
  });
}

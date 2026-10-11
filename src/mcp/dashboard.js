import { buildRecommendations } from "../../public/components/recommendations.js";
import { formatKey, formatProgramName, formatValue } from "../../public/lib/format.js";
import {
  adjustedRemainingSeconds,
  isProgramActive,
} from "../../public/lib/program.js";

const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_TIMEOUT_MS = 5_000;

export class DashboardClient {
  constructor({
    baseUrl = process.env.DISHWASHER_LOOP_BASE_URL || DEFAULT_BASE_URL,
    fetchImplementation = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.dashboardUrl = new URL("/api/dashboard", normalizeBaseUrl(baseUrl));
    this.fetchImplementation = fetchImplementation;
    this.timeoutMs = timeoutMs;
  }

  async getDashboard() {
    let response;
    try {
      response = await this.fetchImplementation(this.dashboardUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `Unable to reach Dishwasher Loop at ${this.dashboardUrl.origin}. `
        + "Start the local service with npm start and try again.",
        { cause: error },
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      throw new Error(
        `Dishwasher Loop returned HTTP ${response.status}. `
        + "Check the local service logs and authentication state.",
      );
    }
    if (!contentType.includes("application/json")) {
      throw new Error(
        "Dishwasher Loop returned a non-JSON response. "
        + "Confirm that the configured URL points to the local Dishwasher Loop service.",
      );
    }

    let dashboard;
    try {
      dashboard = await response.json();
    } catch (error) {
      throw new Error("Dishwasher Loop returned malformed JSON.", { cause: error });
    }
    validateDashboard(dashboard);
    if (!dashboard.authorized) {
      throw new Error(
        "Home Connect is not authorized. Open the local Dishwasher Loop dashboard "
        + "and complete the Home Connect connection first.",
      );
    }
    return dashboard;
  }
}

export function buildDishwasherOverview(dashboard, now = Date.now()) {
  validateDashboard(dashboard);
  const recommendations = buildRecommendations(dashboard, now);

  return {
    observedAt: new Date(now).toISOString(),
    monitorStatus: dashboard.monitorStatus,
    appliances: dashboard.diagnostics.map((diagnostic) => {
      const program = diagnostic.program || {};
      const running = isProgramActive(diagnostic, now);
      const remainingSeconds = running
        ? adjustedRemainingSeconds(program, now)
        : null;
      return {
        id: diagnostic.id,
        name: diagnostic.name,
        brand: diagnostic.brand || "",
        type: diagnostic.type || "",
        model: diagnostic.model || "",
        connected: typeof diagnostic.connected === "boolean"
          ? diagnostic.connected
          : null,
        statusError: diagnostic.statusError || "",
        status: (diagnostic.statusItems || []).map((item) => ({
          key: item.key,
          label: formatKey(item.key),
          value: item.value,
          unit: item.unit || "",
          displayValue: formatValue(item.value, item.unit),
        })),
        program: {
          running,
          activeKey: program.activeKey || "",
          selectedKey: program.selectedKey || "",
          name: formatProgramName(program.activeKey || program.selectedKey || ""),
          progressPercent: Number.isFinite(program.progress)
            ? Math.round(program.progress)
            : null,
          remainingSeconds,
          estimatedFinishAt: remainingSeconds === null
            ? null
            : new Date(now + remainingSeconds * 1000).toISOString(),
          remainingUpdatedAt: program.remainingUpdatedAt || "",
        },
        consumables: {
          salt: normalizeConsumable(diagnostic.consumables?.salt),
          rinseAid: normalizeConsumable(diagnostic.consumables?.rinseAid),
        },
        lastEvent: diagnostic.lastEventAt
          ? {
            type: diagnostic.lastEventType || "",
            receivedAt: diagnostic.lastEventAt,
          }
          : null,
      };
    }),
    supplies: {
      dishwasherCapsules: Number.isInteger(dashboard.capsuleCount)
        ? { state: dashboard.capsuleCount <= 5 ? "low" : "ok", count: dashboard.capsuleCount }
        : { state: "unknown", count: null },
    },
    recommendations,
  };
}

export function buildDishwasherEvents(dashboard, limit) {
  validateDashboard(dashboard);
  return dashboard.events.slice(0, limit).map((event) => ({
    applianceId: event.applianceId,
    applianceName: event.applianceName,
    eventType: event.eventType,
    eventId: event.eventId || "",
    receivedAt: event.receivedAt,
    data: event.data,
  }));
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid DISHWASHER_LOOP_BASE_URL: ${value}`, { cause: error });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("DISHWASHER_LOOP_BASE_URL must use http or https.");
  }
  return url;
}

function validateDashboard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dishwasher Loop returned an invalid dashboard payload.");
  }
  if (typeof value.authorized !== "boolean"
    || typeof value.monitorStatus !== "string"
    || !Array.isArray(value.diagnostics)
    || !Array.isArray(value.events)) {
    throw new Error("Dishwasher Loop returned an incomplete dashboard payload.");
  }
  if (value.diagnostics.some((diagnostic) => !diagnostic
    || typeof diagnostic !== "object"
    || !Array.isArray(diagnostic.statusItems))) {
    throw new Error("Dishwasher Loop returned invalid appliance diagnostics.");
  }
  if (value.events.some((event) => !event || typeof event !== "object")) {
    throw new Error("Dishwasher Loop returned invalid event data.");
  }
}

function normalizeConsumable(value) {
  return {
    state: ["ok", "low", "unknown"].includes(value?.state) ? value.state : "unknown",
    label: typeof value?.label === "string" ? value.label : "Unknown",
  };
}

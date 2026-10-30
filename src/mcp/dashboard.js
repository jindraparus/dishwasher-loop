import { buildRecommendations } from "../../public/components/recommendations.js";
import { formatKey, formatProgramName, formatValue } from "../../public/lib/format.js";
import {
  adjustedRemainingSeconds,
  isProgramActive,
} from "../../public/lib/program.js";
import { selectCycleSummary } from "../cycle-summary.js";
import { validateSupplyForecast } from "../supply-forecast.js";
import { capsuleState, validInventory } from "../../public/lib/supply.js";
import { parseCycleAnalyticsOptions, validateCycleAnalytics } from "../cycle-analytics.js";

const LOCAL_TIMEOUT_MS = 5_000;
const AZURE_TIMEOUT_MS = 30_000;

export class DashboardClient {
  constructor({
    target,
    baseUrl,
    tokenProvider,
    fetchImplementation = globalThis.fetch,
    timeoutMs,
  } = {}) {
    if (!["local", "azure"].includes(target)) {
      throw new Error("Dashboard target must be local or azure.");
    }
    this.source = target;
    this.dashboardUrl = new URL("/api/dashboard", normalizeBaseUrl(baseUrl, target));
    this.cycleSummaryUrl = new URL("/api/cycles/summary", this.dashboardUrl);
    if (target === "azure" && !tokenProvider) {
      throw new Error("Azure dashboard access requires a token provider.");
    }
    this.tokenProvider = tokenProvider;
    this.fetchImplementation = fetchImplementation;
    this.timeoutMs = timeoutMs ?? (target === "azure" ? AZURE_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
  }

  async getDashboard() {
    const dashboard = await this.getJson(this.dashboardUrl);
    validateDashboard(dashboard);
    if (!dashboard.authorized) {
      throw new Error(
        `Home Connect is not authorized. Open the ${this.source} Dishwasher Loop dashboard `
        + "and complete the Home Connect connection first.",
      );
    }
    return dashboard;
  }

  async getCycleSummary(applianceId) {
    return selectCycleSummary(await this.getJson(this.cycleSummaryUrl), applianceId);
  }

  async getCycleAnalytics(options = {}) {
    const input = parseCycleAnalyticsOptions(options);
    const url = new URL("/api/cycles/analytics", this.dashboardUrl);
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const result = validateCycleAnalytics(await this.getJson(url));
    if (result.interval.period !== input.period
      || (input.timeZone !== undefined && result.interval.timeZone !== input.timeZone)
      || (input.period === "range"
        && (result.interval.from !== new Date(input.from).toISOString()
          || result.interval.to !== new Date(input.to).toISOString()))
      || (input.applianceId !== undefined
        && (result.history.appliances.length !== 1
          || result.history.appliances[0].applianceId !== input.applianceId))) {
      throw new Error("Dishwasher Loop returned cycle analytics for a different scope or interval.");
    }
    return result;
  }

  async getJson(url) {
    const headers = { Accept: "application/json" };
    if (this.source === "azure") {
      headers.Authorization = `Bearer ${await this.tokenProvider.getAccessToken()}`;
    }

    let response;
    try {
      response = await this.fetchImplementation(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `Unable to reach Dishwasher Loop at ${url.origin}. `
        + (this.source === "local"
          ? "Start the local service with npm start and try again."
          : "Check the Azure base URL, network connection, and App Service status."),
        { cause: error },
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `${capitalize(this.source)} Dishwasher Loop returned a redirect instead of API data. `
        + (this.source === "azure"
          ? "Verify that the bearer-token audience and delegated scope match App Service Easy Auth."
          : "Confirm that the configured URL points to the local Dishwasher Loop API."),
      );
    }
    if (this.source === "azure" && response.status === 401) {
      throw new Error(
        "Azure rejected the Microsoft access token. Sign in again and verify the "
        + "tenant, audience, delegated scope, and Easy Auth configuration.",
      );
    }
    if (this.source === "azure" && response.status === 403) {
      throw new Error(
        "The signed-in Microsoft account is not allowed to access Dishwasher Loop. "
        + "Add its tenant-local object ID to the Azure allowlist or use an allowed account.",
      );
    }
    if (!response.ok) {
      throw new Error(
        `Dishwasher Loop returned HTTP ${response.status}. `
        + `Check the ${this.source} service logs and authentication state.`,
      );
    }
    if (!contentType.includes("application/json")) {
      throw new Error(
        "Dishwasher Loop returned a non-JSON response. "
        + (this.source === "local"
          ? "Confirm that the configured URL points to the local Dishwasher Loop service."
          : "Confirm the Azure URL, bearer-token audience, delegated scope, and Easy Auth settings."),
      );
    }

    let dashboard;
    try {
      dashboard = await response.json();
    } catch (error) {
      throw new Error("Dishwasher Loop returned malformed JSON.", { cause: error });
    }
    return dashboard;
  }
}

export function buildDishwasherOverview(dashboard, now = Date.now()) {
  validateDashboard(dashboard);
  const forecast = dashboard.supplyForecast === undefined ? undefined
    : validateSupplyForecast(dashboard.supplyForecast,
      validInventory(dashboard.capsuleCount) ? dashboard.capsuleCount : null);
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
      dishwasherCapsules: validInventory(dashboard.capsuleCount)
        ? { state: capsuleState(dashboard.capsuleCount, forecast), count: dashboard.capsuleCount,
          ...(forecast ? { forecast } : {}) }
        : { state: "unknown", count: null, ...(forecast ? { forecast } : {}) },
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

function normalizeBaseUrl(value, target) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    const setting = target === "azure"
      ? "DISHWASHER_LOOP_AZURE_BASE_URL"
      : "DISHWASHER_LOOP_BASE_URL";
    throw new Error(`Invalid ${setting}: ${value}`, { cause: error });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Dishwasher Loop base URL must use http or https.");
  }
  if (target === "azure" && url.protocol !== "https:") {
    throw new Error("Azure Dishwasher Loop base URL must use https.");
  }
  return url;
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
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

import { HomeConnectError, homeConnectFailureKind } from "./home-connect.js";

export const STATUS_CHECK_INTERVAL_MS = 5 * 60_000;
export const OFFLINE_GRACE_MS = 5 * 60_000;

export class ConnectivityTracker {
  constructor(storage, logger = console) {
    this.storage = storage;
    this.logger = logger;
  }

  async record(appliance, error = null, now = new Date()) {
    const previous = await this.storage.getConnectivity(appliance.haId);
    const failureKind = error ? homeConnectFailureKind(error) : null;
    const checkResult = error
      ? (failureKind === "appliance_offline" ? "offline" : "unknown")
      : "online";
    const observedAt = now.toISOString();
    const state = {
      state: previous?.state || "unknown",
      offlineSince: previous?.offlineSince || "",
      alertActive: previous?.alertActive || false,
    };
    if (checkResult === "online") {
      state.state = "online";
      state.offlineSince = "";
      state.alertActive = false;
    } else if (checkResult === "offline") {
      state.state = "offline";
      state.offlineSince ||= observedAt;
      state.alertActive = state.alertActive
        || now.getTime() - Date.parse(state.offlineSince) >= OFFLINE_GRACE_MS;
    } else if (!state.alertActive) {
      // Unknown checks interrupt the grace period, but cannot resolve an active outage.
      state.offlineSince = "";
    }
    const changed = !previous || previous.state !== state.state
      || previous.offlineSince !== state.offlineSince
      || previous.alertActive !== state.alertActive;
    if (changed) {
      await this.storage.saveConnectivity(appliance.haId, state);
    }
    this.logger.info(JSON.stringify({
      event: "dishwasher.connectivity",
      applianceId: appliance.haId,
      applianceName: appliance.name || appliance.brand || "Dishwasher",
      observedAt,
      checkResult,
      ...state,
      transition: changed,
      failureKind,
      httpStatus: error instanceof HomeConnectError ? error.status : null,
    }));
    return checkResult;
  }
}

export function logHomeConnectFailure(logger, operation, error, applianceId) {
  logger.warn(JSON.stringify({
    event: "home_connect.failure",
    operation,
    failureKind: homeConnectFailureKind(error),
    applianceId,
    observedAt: new Date().toISOString(),
    httpStatus: error instanceof HomeConnectError ? error.status : null,
  }));
}

import { AuthenticationRequiredError } from "./home-connect.js";
import { consumeSse } from "./sse.js";

export class DishwasherMonitor {
  constructor(client, storage, logger = console, eventFilter = {}) {
    this.client = client;
    this.storage = storage;
    this.logger = logger;
    this.eventFilter = {
      types: eventFilter.types || ["STATUS", "EVENT", "NOTIFY"],
      keys: eventFilter.keys || [],
    };
    this.controller = null;
    this.running = false;
    this.status = "Not connected";
    this.diagnostics = [];
  }

  start() {
    this.stop();
    this.controller = new AbortController();
    this.running = true;
    void this.run(this.controller.signal);
  }

  stop() {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
    this.status = "Not connected";
    this.diagnostics = [];
  }

  getStatus() {
    return this.status;
  }

  getDiagnostics() {
    return structuredClone(this.diagnostics);
  }

  async run(signal) {
    let retryDelay = 1_000;
    while (!signal.aborted) {
      try {
        const dishwashers = await this.client.listDishwashers();
        if (dishwashers.length === 0) {
          this.status = "Connected, but no dishwasher was found";
          await delay(60_000, signal);
          continue;
        }

        this.status = `Monitoring ${dishwashers.length} dishwasher${dishwashers.length === 1 ? "" : "s"}`;
        await this.loadDiagnostics(dishwashers);
        await this.monitorAll(dishwashers, signal);
        retryDelay = 1_000;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (error instanceof AuthenticationRequiredError) {
          this.status = "Authorization required";
          this.running = false;
          return;
        }
        this.status = `Reconnecting after an error: ${error.message}`;
        this.logger.error("Home Connect monitor error", error);
        await delay(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, 60_000);
      }
    }
  }

  async loadDiagnostics(appliances) {
    this.diagnostics = await Promise.all(appliances.map(async (appliance) => {
      let statusItems = [];
      let statusError = "";
      try {
        statusItems = await this.client.getApplianceStatus(appliance.haId);
      } catch (error) {
        statusError = error.message;
        this.logger.warn(`Unable to load status for ${appliance.haId}`, error);
      }

      return {
        id: appliance.haId,
        name: appliance.name || appliance.brand || "Dishwasher",
        brand: appliance.brand || "",
        type: appliance.type || "Dishwasher",
        model: appliance.enumber || appliance.vib || "",
        connected: appliance.connected,
        statusItems,
        statusError,
        lastEventType: "",
        lastEventAt: "",
      };
    }));
  }

  async monitorAll(appliances, parentSignal) {
    const cycleController = new AbortController();
    const abortCycle = () => cycleController.abort();
    parentSignal.addEventListener("abort", abortCycle, { once: true });

    try {
      await Promise.all(appliances.map(async (appliance) => {
        try {
          await this.monitorAppliance(appliance, cycleController.signal);
        } catch (error) {
          cycleController.abort();
          throw error;
        }
      }));
    } finally {
      cycleController.abort();
      parentSignal.removeEventListener("abort", abortCycle);
    }
  }

  async monitorAppliance(appliance, signal) {
    const response = await this.client.openEventStream(appliance.haId, signal);
    if (!response.body) {
      throw new Error("Home Connect event stream returned no response body");
    }

    await consumeSse(response.body, async (message) => {
      this.updateDiagnostics(appliance.haId, message);
      if (!shouldPersistEvent(message, this.eventFilter)) {
        return;
      }
      await this.storage.saveEvent({
        applianceId: appliance.haId,
        applianceName: appliance.name || appliance.brand || "Dishwasher",
        eventType: message.event,
        eventId: message.id,
        data: message.data,
      });
    }, signal);

    if (!signal.aborted) {
      throw new Error(`Event stream for ${appliance.name || appliance.haId} ended`);
    }
  }

  updateDiagnostics(applianceId, message) {
    const diagnostic = this.diagnostics.find((item) => item.id === applianceId);
    if (!diagnostic) {
      return;
    }

    diagnostic.connected = true;
    diagnostic.lastEventType = message.event;
    diagnostic.lastEventAt = new Date().toISOString();
    if (message.event !== "STATUS" || !Array.isArray(message.data?.items)) {
      return;
    }

    for (const item of message.data.items) {
      const existingIndex = diagnostic.statusItems.findIndex(
        (statusItem) => statusItem.key === item.key,
      );
      if (existingIndex === -1) {
        diagnostic.statusItems.push(item);
      } else {
        diagnostic.statusItems[existingIndex] = item;
      }
    }
  }
}

export function shouldPersistEvent(message, filter) {
  if (!filter.types.includes(message.event.toUpperCase())) {
    return false;
  }
  if (filter.keys.length === 0) {
    return true;
  }
  return Array.isArray(message.data?.items)
    && message.data.items.some((item) => filter.keys.includes(item.key));
}

function delay(milliseconds, signal) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

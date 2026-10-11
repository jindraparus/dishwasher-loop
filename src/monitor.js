import { AuthenticationRequiredError } from "./home-connect.js";
import { consumeSse } from "./sse.js";

const CONSUMABLE_EVENTS = {
  "Dishcare.Dishwasher.Event.SaltNearlyEmpty": "salt",
  "Dishcare.Dishwasher.Event.RinseAidNearlyEmpty": "rinseAid",
};

export class DishwasherMonitor {
  constructor(client, storage, logger = console, eventFilter = {}, cycleTracker = null) {
    this.client = client;
    this.storage = storage;
    this.logger = logger;
    this.eventFilter = {
      types: eventFilter.types || ["STATUS", "EVENT", "NOTIFY"],
      keys: eventFilter.keys || [],
    };
    this.cycleTracker = cycleTracker;
    this.controller = null;
    this.running = false;
    this.status = "Nepřipojeno";
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
    this.status = "Nepřipojeno";
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
          this.status = "Připojeno, ale nebyla nalezena žádná myčka";
          await delay(60_000, signal);
          continue;
        }

        this.status = monitoredDishwashersLabel(dishwashers.length);
        await this.loadDiagnostics(dishwashers);
        await this.monitorAll(dishwashers, signal);
        retryDelay = 1_000;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (error instanceof AuthenticationRequiredError) {
          this.status = "Je vyžadována autorizace";
          this.running = false;
          return;
        }
        this.status = `Opětovné připojení po chybě: ${error.message}`;
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
        name: appliance.name || appliance.brand || "Myčka nádobí",
        brand: appliance.brand || "",
        type: appliance.type || "Myčka nádobí",
        model: appliance.enumber || appliance.vib || "",
        connected: appliance.connected,
        statusItems,
        statusError,
        consumables: {
          salt: unknownConsumableStatus(),
          rinseAid: unknownConsumableStatus(),
        },
        program: {
          activeKey: "",
          selectedKey: "",
          progress: null,
          remainingSeconds: null,
          remainingUpdatedAt: "",
        },
        lastEventType: "",
        lastEventAt: "",
      };
    }));

    const recentEvents = await this.storage.listEvents(200);
    for (const event of recentEvents.toReversed()) {
      this.updateDiagnostics(event.applianceId, {
        event: event.eventType,
        data: event.data,
        receivedAt: event.receivedAt,
      });
    }
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
      if (!parentSignal.aborted) {
        await Promise.all(appliances.map(
          (appliance) => this.cycleTracker?.recordDisconnect(appliance.haId),
        ));
      }
    }
  }

  async monitorAppliance(appliance, signal) {
    try {
      const response = await this.client.openEventStream(appliance.haId, signal);
      if (!response.body) {
        throw new Error("Proud událostí Home Connect nevrátil tělo odpovědi");
      }
      await this.cycleTracker?.recordReconnect(appliance.haId);

      await consumeSse(response.body, async (message) => {
        const receivedAt = new Date().toISOString();
        const persistedMessage = {
          applianceId: appliance.haId,
          applianceName: appliance.name || appliance.brand || "Myčka nádobí",
          eventType: message.event,
          eventId: message.id || "",
          receivedAt,
          data: message.data,
        };
        this.updateDiagnostics(appliance.haId, { ...message, receivedAt });
        await this.cycleTracker?.processEvent(persistedMessage);
        if (shouldPersistEvent(message, this.eventFilter)) {
          await this.storage.saveEvent(persistedMessage);
        }
      }, signal);

      if (!signal.aborted) {
        throw new Error(`Proud událostí pro ${appliance.name || appliance.haId} skončil`);
      }
    } catch (error) {
      if (!signal.aborted) {
        await this.cycleTracker?.recordDisconnect(appliance.haId);
      }
      throw error;
    }
  }

  updateDiagnostics(applianceId, message) {
    const diagnostic = this.diagnostics.find((item) => item.id === applianceId);
    if (!diagnostic) {
      return;
    }

    diagnostic.connected = true;
    const receivedAt = message.receivedAt || new Date().toISOString();
    diagnostic.lastEventType = message.event;
    diagnostic.lastEventAt = receivedAt;
    if (!Array.isArray(message.data?.items)) {
      return;
    }

    for (const item of message.data.items) {
      const consumable = CONSUMABLE_EVENTS[item.key];
      if (consumable) {
        diagnostic.consumables[consumable] = consumableStatus(item.value);
      }
      updateProgram(diagnostic.program, item, receivedAt);
      if (message.event !== "STATUS") {
        continue;
      }

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

function updateProgram(program, item, receivedAt) {
  if (item.key === "BSH.Common.Root.ActiveProgram") {
    if (typeof item.value === "string") {
      program.activeKey = item.value;
    } else {
      program.activeKey = "";
      program.progress = null;
      program.remainingSeconds = 0;
      program.remainingUpdatedAt = receivedAt;
    }
  } else if (item.key === "BSH.Common.Root.SelectedProgram") {
    program.selectedKey = typeof item.value === "string" ? item.value : "";
  } else if (item.key === "BSH.Common.Option.ProgramProgress") {
    const progress = Number(item.value);
    program.progress = Number.isFinite(progress)
      ? Math.min(100, Math.max(0, progress))
      : null;
  } else if (item.key === "BSH.Common.Option.RemainingProgramTime") {
    const remainingSeconds = Number(item.value);
    program.remainingSeconds = Number.isFinite(remainingSeconds)
      ? Math.max(0, remainingSeconds)
      : null;
    program.remainingUpdatedAt = receivedAt;
  }
}

export function consumableStatus(value) {
  if (value === false) {
    return { state: "ok", label: "Dostatek" };
  }
  if (value === true) {
    return { state: "low", label: "Brzy doplnit" };
  }

  const state = String(value ?? "").split(".").at(-1).toLowerCase();
  if (state === "off") {
    return { state: "ok", label: "Dostatek" };
  }
  if (state === "present") {
    return { state: "low", label: "Brzy doplnit" };
  }
  if (state === "confirmed") {
    return { state: "low", label: "Brzy doplnit (upozornění potvrzeno)" };
  }
  return unknownConsumableStatus();
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

function unknownConsumableStatus() {
  return { state: "unknown", label: "Neznámé – čeká se na událost spotřebiče" };
}

function monitoredDishwashersLabel(count) {
  if (count === 1) {
    return "Sledována 1 myčka";
  }
  if (count >= 2 && count <= 4) {
    return `Sledovány ${count} myčky`;
  }
  return `Sledováno ${count} myček`;
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

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { TableClient } from "@azure/data-tables";

const SETTINGS_PARTITION = "settings";
const TOKENS_ROW = "oauth";
const SUPPLIES_ROW = "supplies";
const EVENTS_PARTITION = "events";
const CYCLES_PARTITION = "cycles";

export class Storage {
  constructor(connectionString, tableName, localFile = ".data/dishwasher-loop.json") {
    this.localFile = isLocalConnection(connectionString) ? path.resolve(localFile) : null;
    this.client = this.localFile
      ? null
      : TableClient.fromConnectionString(connectionString, tableName);
    this.localData = null;
    this.writePromise = Promise.resolve();
  }

  async initialize() {
    if (this.localFile) {
      await mkdir(path.dirname(this.localFile), { recursive: true });
      try {
        this.localData = JSON.parse(await readFile(this.localFile, "utf8"));
        this.localData.events ||= [];
        this.localData.cycles ||= [];
        this.localData.tokens ??= null;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw new Error(`Unable to read local storage file ${this.localFile}`, {
            cause: error,
          });
        }
        this.localData = { tokens: null, events: [], cycles: [] };
        await this.persistLocal();
      }
      return;
    }
    await this.client.createTable();
  }

  async getTokens() {
    if (this.localFile) {
      return this.localData.tokens;
    }
    try {
      const entity = await this.client.getEntity(SETTINGS_PARTITION, TOKENS_ROW);
      return {
        accessToken: entity.accessToken,
        refreshToken: entity.refreshToken,
        expiresAt: Number(entity.expiresAt),
      };
    } catch (error) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async saveTokens(tokens) {
    if (this.localFile) {
      this.localData.tokens = { ...tokens };
      await this.persistLocal();
      return;
    }
    await this.client.upsertEntity({
      partitionKey: SETTINGS_PARTITION,
      rowKey: TOKENS_ROW,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    }, "Replace");
  }

  async deleteTokens() {
    if (this.localFile) {
      this.localData.tokens = null;
      await this.persistLocal();
      return;
    }
    try {
      await this.client.deleteEntity(SETTINGS_PARTITION, TOKENS_ROW);
    } catch (error) {
      if (error.statusCode !== 404) {
        throw error;
      }
    }
  }

  async getCapsuleCount() {
    if (this.localFile) {
      return validCapsuleCount(this.localData.capsuleCount);
    }
    try {
      const entity = await this.client.getEntity(SETTINGS_PARTITION, SUPPLIES_ROW);
      return validCapsuleCount(entity.capsuleCount);
    } catch (error) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async saveEvent({
    applianceId,
    applianceName,
    eventType,
    eventId,
    data,
    receivedAt = new Date().toISOString(),
  }) {
    if (this.localFile) {
      this.localData.events.push({
        applianceId,
        applianceName,
        eventType: eventType || "message",
        eventId: eventId || "",
        receivedAt,
        data,
      });
      await this.persistLocal();
      return receivedAt;
    }
    await this.client.createEntity({
      partitionKey: EVENTS_PARTITION,
      rowKey: `${Date.now().toString().padStart(13, "0")}-${randomUUID()}`,
      applianceId,
      applianceName,
      eventType: eventType || "message",
      eventId: eventId || "",
      receivedAt,
      payload: JSON.stringify(data),
    });
    return receivedAt;
  }

  async listEvents(limit = 200) {
    return (await this.listAllEvents())
      .toSorted((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, limit);
  }

  async listAllEvents() {
    if (this.localFile) {
      return this.localData.events
        .toSorted(compareEvents);
    }
    const entities = [];
    const query = this.client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${EVENTS_PARTITION}'` },
    });

    for await (const entity of query) {
      entities.push({
        storageId: entity.rowKey,
        applianceId: entity.applianceId,
        applianceName: entity.applianceName,
        eventType: entity.eventType,
        eventId: entity.eventId,
        receivedAt: entity.receivedAt,
        data: parsePayload(entity.payload),
      });
    }

    return entities.sort(compareEvents);
  }

  async saveCycle(cycle) {
    const stored = structuredClone(cycle);
    if (this.localFile) {
      const index = this.localData.cycles.findIndex(
        (item) => item.cycleId === stored.cycleId,
      );
      if (index === -1) {
        this.localData.cycles.push(stored);
      } else {
        this.localData.cycles[index] = stored;
      }
      await this.persistLocal();
      return;
    }
    await this.client.upsertEntity(cycleToEntity(stored), "Replace");
  }

  async listCycles(limit = 50) {
    return (await this.listAllCycles()).slice(0, limit);
  }

  async listAllCycles() {
    if (this.localFile) {
      return this.localData.cycles
        .map((cycle) => structuredClone(cycle))
        .sort(compareCycles);
    }
    const cycles = [];
    const query = this.client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${CYCLES_PARTITION}'` },
    });
    for await (const entity of query) {
      cycles.push(entityToCycle(entity));
    }
    return cycles.sort(compareCycles);
  }

  persistLocal() {
    const temporaryFile = `${this.localFile}.${process.pid}.${randomUUID()}.tmp`;
    const write = this.writePromise.then(async () => {
      await writeFile(temporaryFile, JSON.stringify(this.localData, null, 2), {
        mode: 0o600,
      });
      await rename(temporaryFile, this.localFile);
    });
    this.writePromise = write.catch(() => {});
    return write;
  }
}

function parsePayload(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function isLocalConnection(connectionString) {
  return connectionString.trim().toLowerCase() === "local"
    || connectionString.trim().toLowerCase() === "usedevelopmentstorage=true";
}

function validCapsuleCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 999 ? value : null;
}

function compareEvents(left, right) {
  return left.receivedAt.localeCompare(right.receivedAt)
    || String(left.storageId || left.eventId || "")
      .localeCompare(String(right.storageId || right.eventId || ""));
}

function compareCycles(left, right) {
  return String(right.firstObservedAt).localeCompare(String(left.firstObservedAt));
}

export function cycleToEntity(cycle) {
  return {
    partitionKey: CYCLES_PARTITION,
    rowKey: cycle.cycleId,
    applianceId: cycle.applianceId,
    applianceName: cycle.applianceName,
    programKey: cycle.programKey || "",
    status: cycle.status,
    result: cycle.result,
    startedAt: cycle.startedAt || "",
    finishedAt: cycle.finishedAt || "",
    durationSeconds: Number.isFinite(cycle.durationSeconds)
      ? cycle.durationSeconds
      : -1,
    firstObservedAt: cycle.firstObservedAt,
    lastObservedAt: cycle.lastObservedAt,
    startConfidence: cycle.startConfidence,
    finishConfidence: cycle.finishConfidence,
    details: JSON.stringify({
      startEvidence: cycle.startEvidence,
      finishEvidence: cycle.finishEvidence,
      observationGaps: cycle.observationGaps,
      sourceEventIds: cycle.sourceEventIds,
      progressMin: cycle.progressMin,
      progressMax: cycle.progressMax,
      remainingInitialSeconds: cycle.remainingInitialSeconds,
      remainingLastSeconds: cycle.remainingLastSeconds,
      pendingTerminalSignals: cycle.pendingTerminalSignals,
    }),
  };
}

export function entityToCycle(entity) {
  const details = parsePayload(entity.details) || {};
  return {
    cycleId: entity.rowKey,
    applianceId: entity.applianceId,
    applianceName: entity.applianceName,
    programKey: entity.programKey || null,
    status: entity.status,
    result: entity.result,
    startedAt: entity.startedAt || null,
    finishedAt: entity.finishedAt || null,
    durationSeconds: Number(entity.durationSeconds) >= 0
      ? Number(entity.durationSeconds)
      : null,
    firstObservedAt: entity.firstObservedAt,
    lastObservedAt: entity.lastObservedAt,
    startConfidence: entity.startConfidence,
    finishConfidence: entity.finishConfidence,
    startEvidence: details.startEvidence || [],
    finishEvidence: details.finishEvidence || [],
    observationGaps: details.observationGaps || [],
    sourceEventIds: details.sourceEventIds || [],
    progressMin: details.progressMin ?? null,
    progressMax: details.progressMax ?? null,
    remainingInitialSeconds: details.remainingInitialSeconds ?? null,
    remainingLastSeconds: details.remainingLastSeconds ?? null,
    pendingTerminalSignals: details.pendingTerminalSignals || [],
  };
}

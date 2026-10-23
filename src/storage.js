import { createHash, randomUUID } from "node:crypto";
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
      }
      await this.updateCapsules();
      return;
    }
    await this.client.createTable();
    await this.updateCapsules();
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
      await this.updateLocal((data) => { data.tokens = { ...tokens }; });
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
      await this.updateLocal((data) => { data.tokens = null; });
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

  async setCapsuleCount(count) {
    if (validCapsuleCount(count) === null) {
      throw new RangeError("Počet tablet musí být celé číslo od 0 do 999.");
    }
    return this.updateCapsules({ count });
  }

  async updateCapsules({ count, cycle } = {}) {
    const marker = cycle
      ? `capsule-${createHash("sha256").update(cycle.cycleId).digest("hex")}`
      : null;
    const apply = (supplies, accounted = false) => {
      const next = { ...supplies };
      next.capsuleCount = validCapsuleCount(next.capsuleCount) ?? 50;
      next.capsuleSnapshotAt ||= new Date().toISOString();
      if (count !== undefined) {
        next.capsuleCount = count;
        next.capsuleSnapshotAt = new Date().toISOString();
      }
      const consume = !accounted && cycle?.status === "finished"
        && cycle.result === "finished"
        && Date.parse(cycle.finishedAt) > Date.parse(next.capsuleSnapshotAt);
      if (consume) {
        next.capsuleCount = Math.max(0, next.capsuleCount - 1);
      }
      return { next, consume };
    };
    if (this.localFile) {
      return this.updateLocal((data) => {
        const { next, consume } = apply(data, Boolean(data.capsuleCycles?.[marker]));
        data.capsuleCount = next.capsuleCount;
        data.capsuleSnapshotAt = next.capsuleSnapshotAt;
        if (consume) {
          data.capsuleCycles ||= {};
          data.capsuleCycles[marker] = true;
        }
        return data.capsuleCount;
      });
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const supplies = await this.getOptionalEntity(SUPPLIES_ROW);
      const accounted = marker && await this.getOptionalEntity(marker);
      const { next, consume } = apply(supplies || {}, Boolean(accounted));
      if (count === undefined && !consume && supplies
        && supplies.capsuleCount === next.capsuleCount
        && supplies.capsuleSnapshotAt === next.capsuleSnapshotAt) {
        return next.capsuleCount;
      }
      const entity = {
        partitionKey: SETTINGS_PARTITION,
        rowKey: SUPPLIES_ROW,
        capsuleCount: next.capsuleCount,
        capsuleSnapshotAt: next.capsuleSnapshotAt,
      };
      const actions = supplies
        ? [["update", entity, "Merge", { etag: supplies.etag }]]
        : [["create", entity]];
      if (consume) {
        actions.push(["create", { partitionKey: SETTINGS_PARTITION, rowKey: marker }]);
      }
      try {
        await this.client.submitTransaction(actions);
        return next.capsuleCount;
      } catch (error) {
        if (![409, 412].includes(error.statusCode) || attempt === 7) {
          throw error;
        }
      }
    }
  }

  async getOptionalEntity(rowKey) {
    try {
      return await this.client.getEntity(SETTINGS_PARTITION, rowKey);
    } catch (error) {
      if (error.statusCode === 404) return null;
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
      await this.updateLocal((dataStore) => dataStore.events.push({
        applianceId,
        applianceName,
        eventType: eventType || "message",
        eventId: eventId || "",
        receivedAt,
        data,
      }));
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
      await this.updateLocal((data) => {
        const index = data.cycles.findIndex((item) => item.cycleId === stored.cycleId);
        if (index === -1) data.cycles.push(stored);
        else data.cycles[index] = stored;
      });
    } else {
      await this.client.upsertEntity(cycleToEntity(stored), "Replace");
    }
    if (stored.status === "finished" && stored.result === "finished") {
      await this.updateCapsules({ cycle: stored });
    }
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

  updateLocal(mutate) {
    const write = this.writePromise.then(async () => {
      const next = structuredClone(this.localData);
      const result = mutate(next);
      const temporaryFile = `${this.localFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryFile, JSON.stringify(next, null, 2), {
        mode: 0o600,
      });
      await rename(temporaryFile, this.localFile);
      this.localData = next;
      return result;
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

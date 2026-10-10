import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { TableClient } from "@azure/data-tables";

const SETTINGS_PARTITION = "settings";
const TOKENS_ROW = "oauth";
const EVENTS_PARTITION = "events";

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
        this.localData.tokens ??= null;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw new Error(`Unable to read local storage file ${this.localFile}`, {
            cause: error,
          });
        }
        this.localData = { tokens: null, events: [] };
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

  async saveEvent({ applianceId, applianceName, eventType, eventId, data }) {
    const receivedAt = new Date().toISOString();
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
      return;
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
  }

  async listEvents(limit = 200) {
    if (this.localFile) {
      return this.localData.events
        .toSorted((left, right) => right.receivedAt.localeCompare(left.receivedAt))
        .slice(0, limit);
    }
    const entities = [];
    const query = this.client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${EVENTS_PARTITION}'` },
    });

    for await (const entity of query) {
      entities.push({
        applianceId: entity.applianceId,
        applianceName: entity.applianceName,
        eventType: entity.eventType,
        eventId: entity.eventId,
        receivedAt: entity.receivedAt,
        data: parsePayload(entity.payload),
      });
    }

    return entities
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, limit);
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

import { isDeepStrictEqual } from "node:util";
import { buildCycleStats } from "./cycles.js";

const FIELDS = [
  "cycleId", "applianceId", "programKey", "status", "result",
  "startedAt", "finishedAt", "durationSeconds", "firstObservedAt",
  "lastObservedAt", "startConfidence", "finishConfidence",
];

export async function readDeploymentCycles(storage, operation, logger = console) {
  try {
    return await storage.listAllCycles();
  } catch (error) {
    if (operation !== "capture" || error.statusCode !== 404 || error.code !== "TableNotFound") {
      throw error;
    }
    logger.info("No existing cycle table; capturing an empty baseline for the first deployment.");
    return [];
  }
}

export function captureCycleHistory(cycles, timezone, referenceTime = new Date().toISOString()) {
  validateCycles(cycles);
  if (!Number.isFinite(Date.parse(referenceTime))) {
    throw new Error("Invalid cycle-history reference time.");
  }
  const records = cycles.map((cycle) => Object.fromEntries(
    FIELDS.map((field) => [field, cycle[field]]),
  ));
  return {
    version: 1,
    referenceTime,
    timezone,
    cycles: records,
    stats: statistics(records, timezone, referenceTime),
  };
}

export function verifyCycleHistory(baseline, cycles, timezone) {
  if (baseline?.version !== 1
    || !baseline.stats?.week || !baseline.stats?.month
    || !Number.isFinite(Date.parse(baseline.referenceTime))) {
    throw new Error("Invalid cycle-history baseline.");
  }
  validateCycles(baseline.cycles);
  validateCycles(cycles);
  const differences = [];
  if (timezone !== baseline.timezone) {
    differences.push(`timezone: ${baseline.timezone} -> ${timezone}`);
  }
  const before = new Map(baseline.cycles.map((cycle) => [cycle.cycleId, cycle]));
  const after = new Map(cycles.map((cycle) => [cycle.cycleId, cycle]));
  const comparable = [];
  let progressed = 0;
  let added = 0;

  for (const previous of baseline.cycles) {
    const current = after.get(previous.cycleId);
    if (!current) {
      differences.push(`${previous.cycleId}: missing cycle`);
      continue;
    }
    const changed = FIELDS.filter((field) => !isDeepStrictEqual(previous[field], current[field]));
    if (changed.length > 0 && isLiveProgress(previous, current)) {
      progressed += 1;
      // Compare the original population, not statistics changed by live activity.
      comparable.push(previous);
    } else {
      comparable.push(current);
      for (const field of changed) {
        differences.push(
          `${previous.cycleId}.${field}: ${JSON.stringify(previous[field])} -> ${JSON.stringify(current[field])}`,
        );
      }
    }
  }
  for (const current of cycles) {
    if (before.has(current.cycleId)) continue;
    if (Date.parse(current.firstObservedAt) < Date.parse(baseline.referenceTime)) {
      differences.push(`${current.cycleId}: unexpected historical cycle`);
    } else {
      added += 1;
    }
  }
  const stats = statistics(comparable, timezone, baseline.referenceTime);
  for (const period of ["week", "month"]) {
    const fields = new Set([...Object.keys(baseline.stats[period]), ...Object.keys(stats[period])]);
    for (const field of fields) {
      const value = baseline.stats[period][field];
      if (!isDeepStrictEqual(value, stats[period][field])) {
        differences.push(
          `${period}.${field}: ${JSON.stringify(value)} -> ${JSON.stringify(stats[period][field])}`,
        );
      }
    }
  }
  if (differences.length > 0) {
    throw new Error(
      `Cycle-history verification failed (${differences.length} differences):\n`
      + differences.slice(0, 20).join("\n")
      + (differences.length > 20 ? "\nFurther differences omitted." : ""),
    );
  }
  return {
    preservedCycles: baseline.cycles.length,
    newCycles: added,
    progressedCycles: progressed,
    stats,
    liveStats: statistics(cycles, timezone, baseline.referenceTime),
  };
}

function statistics(cycles, timezone, referenceTime) {
  const now = new Date(referenceTime);
  return {
    week: buildCycleStats(cycles, "week", timezone, now),
    month: buildCycleStats(cycles, "month", timezone, now),
  };
}

function isLiveProgress(previous, current) {
  if (previous.status === "finished") {
    return FIELDS.filter((field) => field !== "lastObservedAt")
      .every((field) => isDeepStrictEqual(previous[field], current[field]))
      && Date.parse(current.lastObservedAt) >= Date.parse(previous.lastObservedAt);
  }
  if (!["running", "incomplete"].includes(previous.status)) return false;
  if (!["running", "incomplete", "finished"].includes(current.status)
    || (previous.status === "incomplete" && current.status === "running")) return false;
  for (const field of ["applianceId", "firstObservedAt"]) {
    if (previous[field] !== current[field]) return false;
  }
  for (const field of ["programKey", "startedAt"]) {
    if (previous[field] !== null && previous[field] !== current[field]) return false;
  }
  if (previous.startedAt && previous.startConfidence !== current.startConfidence) return false;
  if (!previous.startedAt && current.startConfidence
    !== (current.startedAt ? "observed" : previous.startConfidence)) return false;
  if (Date.parse(current.lastObservedAt) < Date.parse(previous.lastObservedAt)) return false;
  if (current.startedAt && Date.parse(current.startedAt) < Date.parse(previous.firstObservedAt)) {
    return false;
  }
  if (current.status !== "finished") {
    if (previous.status === "incomplete" && current.result !== previous.result) return false;
    const results = current.status === "running" ? ["unknown"] : ["unknown", "superseded"];
    return results.includes(current.result) && current.finishConfidence === "missing"
      && current.finishedAt === null && current.durationSeconds === null;
  }
  if (current.result !== "finished" || !current.finishedAt
    || (previous.status === "incomplete" && previous.result !== "unknown")
    || Date.parse(current.finishedAt) < Date.parse(previous.lastObservedAt)) return false;
  const duration = current.startedAt
    && current.startConfidence === "observed" && current.finishConfidence === "observed"
    ? Math.max(0, Math.round((Date.parse(current.finishedAt) - Date.parse(current.startedAt)) / 1000))
    : null;
  return current.durationSeconds === duration;
}

function validateCycles(cycles) {
  if (!Array.isArray(cycles)) throw new Error("Cycle history must be an array.");
  const ids = new Set();
  const boundaries = new Set();
  for (const cycle of cycles) {
    if (!cycle || FIELDS.some((field) => cycle[field] === undefined)
      || typeof cycle.cycleId !== "string" || !cycle.cycleId
      || typeof cycle.applianceId !== "string" || !cycle.applianceId
      || !["running", "incomplete", "finished"].includes(cycle.status)
      || !["unknown", "finished", "cancelled", "superseded"].includes(cycle.result)
      || !["missing", "inferred", "observed"].includes(cycle.startConfidence)
      || !["missing", "inferred", "observed"].includes(cycle.finishConfidence)
      || (cycle.programKey !== null && typeof cycle.programKey !== "string")
      || (cycle.durationSeconds !== null
        && (!Number.isFinite(cycle.durationSeconds) || cycle.durationSeconds < 0))
      || [cycle.startedAt, cycle.finishedAt].some(
        (at) => at !== null && !Number.isFinite(Date.parse(at)),
      )
      || !Number.isFinite(Date.parse(cycle.firstObservedAt))
      || !Number.isFinite(Date.parse(cycle.lastObservedAt))
      || Date.parse(cycle.lastObservedAt) < Date.parse(cycle.firstObservedAt)
      || (cycle.startedAt
        && Date.parse(cycle.startedAt) < Date.parse(cycle.firstObservedAt))) {
      throw new Error("Invalid cycle-history record.");
    }
    if (ids.has(cycle.cycleId)) throw new Error(`Duplicate cycle ID: ${cycle.cycleId}`);
    ids.add(cycle.cycleId);
    const boundary = JSON.stringify([cycle.applianceId, cycle.firstObservedAt]);
    if (boundaries.has(boundary)) {
      throw new Error(`Duplicate cycle observation: ${cycle.applianceId} at ${cycle.firstObservedAt}`);
    }
    boundaries.add(boundary);
  }
}

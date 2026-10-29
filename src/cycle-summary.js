import { z } from "zod";
import { hasCompleteBoundaries } from "./cycles.js";

const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative();
const counts = {
  totalObserved: count,
  completed: count,
  running: count,
  incomplete: count,
  inferredCompletions: count,
  completeBoundaries: count,
  missingStartBoundaries: count,
  missingFinishBoundaries: count,
  cyclesWithObservationGaps: count,
  earliestObservedAt: timestamp.nullable(),
  latestObservedAt: timestamp.nullable(),
};

function validCounts(value) {
  return value.totalObserved === value.completed + value.running + value.incomplete
    && value.inferredCompletions + value.completeBoundaries <= value.completed
    && value.missingStartBoundaries <= value.totalObserved
    && value.missingFinishBoundaries === value.running + value.incomplete
    && value.cyclesWithObservationGaps <= value.totalObserved
    && (value.totalObserved === 0
      ? value.earliestObservedAt === null && value.latestObservedAt === null
      : value.earliestObservedAt !== null && value.latestObservedAt !== null
        && value.earliestObservedAt <= value.latestObservedAt);
}

const applianceSummarySchema = z.object({
  applianceId: z.string().min(1),
  applianceName: z.string(),
  ...counts,
}).refine(validCounts, "Inconsistent cycle counts or observation range.");

export const cycleSummarySchema = z.object({
  scope: z.literal("persisted-cycle-history"),
  summarizedAt: timestamp,
  monitoringStartedAt: z.null(),
  continuousCoverageKnown: z.literal(false),
  ...counts,
  appliances: z.array(applianceSummarySchema),
}).refine((value) => {
  const total = combineSummaries(value.appliances);
  return validCounts(value)
    && new Set(value.appliances.map((item) => item.applianceId)).size === value.appliances.length
    && Object.keys(counts).every((key) => value[key] === total[key]);
}, "Summary must reconcile with its appliance summaries.");

const cycleSchema = z.object({
  cycleId: z.string().min(1),
  applianceId: z.string().min(1),
  applianceName: z.string(),
  status: z.enum(["finished", "running", "incomplete"]),
  result: z.enum(["finished", "unknown", "superseded"]),
  firstObservedAt: timestamp,
  lastObservedAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  startConfidence: z.enum(["observed", "inferred", "missing"]),
  finishConfidence: z.enum(["observed", "inferred", "missing"]),
  durationSeconds: z.number().nonnegative().nullable(),
  observationGaps: z.array(z.object({
    startedAt: timestamp,
    endedAt: timestamp.nullable(),
  }).refine((gap) => gap.endedAt === null || gap.startedAt <= gap.endedAt)),
}).refine((cycle) => cycle.firstObservedAt <= cycle.lastObservedAt
  && (cycle.status === "finished"
    ? cycle.result === "finished" && cycle.finishedAt !== null
      && cycle.finishConfidence !== "missing"
    : (cycle.status === "running" ? cycle.result === "unknown" : cycle.result !== "finished")
      && cycle.finishedAt === null
      && cycle.finishConfidence === "missing")
  && (cycle.startConfidence === "observed"
    ? cycle.startedAt !== null
    : cycle.startedAt === null), "Inconsistent cycle state or boundaries.");

export function buildCycleSummary(cycles, appliances = [], now = new Date()) {
  const parsed = z.array(cycleSchema).safeParse(cycles);
  if (!parsed.success
    || new Set(parsed.data.map((cycle) => cycle.cycleId)).size !== parsed.data.length) {
    throw new Error("Invalid persisted cycle history. Check service logs and cycle storage.");
  }
  const summaries = new Map(appliances.map((appliance) => [
    appliance.id,
    { applianceId: appliance.id, applianceName: appliance.name, ...emptyCounts() },
  ]));
  for (const cycle of parsed.data) {
    if (!summaries.has(cycle.applianceId)) {
      summaries.set(cycle.applianceId, {
        applianceId: cycle.applianceId,
        applianceName: cycle.applianceName,
        ...emptyCounts(),
      });
    }
    const summary = summaries.get(cycle.applianceId);
    summary.totalObserved += 1;
    summary[cycle.status === "finished" ? "completed" : cycle.status] += 1;
    summary.inferredCompletions += Number(cycle.status === "finished"
      && cycle.finishConfidence === "inferred");
    summary.completeBoundaries += Number(hasCompleteBoundaries(cycle));
    summary.missingStartBoundaries += Number(cycle.startedAt === null);
    summary.missingFinishBoundaries += Number(cycle.finishedAt === null);
    summary.cyclesWithObservationGaps += Number(cycle.observationGaps.length > 0);
    summary.earliestObservedAt = earliest(summary.earliestObservedAt, cycle.firstObservedAt);
    summary.latestObservedAt = latest(summary.latestObservedAt, cycle.lastObservedAt);
  }
  const result = [...summaries.values()].sort(
    (left, right) => left.applianceId.localeCompare(right.applianceId),
  );
  return cycleSummarySchema.parse({
    scope: "persisted-cycle-history",
    summarizedAt: now.toISOString(),
    monitoringStartedAt: null,
    continuousCoverageKnown: false,
    ...combineSummaries(result),
    appliances: result,
  });
}

export function selectCycleSummary(value, applianceId) {
  const parsed = cycleSummarySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Dishwasher Loop returned missing or invalid cycle summary data. "
      + "Deploy a service version supporting cycle summaries and check its logs and storage.",
    );
  }
  const summary = parsed.data;
  if (applianceId === undefined) {
    return summary;
  }
  const appliance = summary.appliances.find((item) => item.applianceId === applianceId);
  if (!appliance) {
    throw new Error("Unknown appliance ID. Use the cycle summary without a selector to list appliances.");
  }
  return {
    ...summary,
    ...combineSummaries([appliance]),
    appliances: [appliance],
  };
}

function emptyCounts() {
  return Object.fromEntries(Object.keys(counts).map((key) => [
    key, key.endsWith("At") ? null : 0,
  ]));
}

function combineSummaries(summaries) {
  const total = emptyCounts();
  for (const summary of summaries) {
    for (const key of Object.keys(counts)) {
      if (!key.endsWith("At")) total[key] += summary[key];
    }
    total.earliestObservedAt = earliest(total.earliestObservedAt, summary.earliestObservedAt);
    total.latestObservedAt = latest(total.latestObservedAt, summary.latestObservedAt);
  }
  return total;
}

function earliest(left, right) {
  return left === null ? right : right === null ? left : left < right ? left : right;
}

function latest(left, right) {
  return left === null ? right : right === null ? left : left > right ? left : right;
}

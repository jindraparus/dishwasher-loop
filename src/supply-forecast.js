import { z } from "zod";
import { buildCycleSummary, cycleSummarySchema, parseCycleHistory } from "./cycle-summary.js";

const DAY_MS = 86_400_000;
const policy = {
  windowDays: 28,
  minimumHistoryDays: 7,
  minimumCompletedCycles: 3,
  deliveryDays: 3,
  safetyBufferDays: 4,
  reorderThresholdDays: 7,
  stockOnlyThreshold: 5,
  capsulesPerCompletedCycle: 1,
};

const forecastSchema = z.object({
  summarizedAt: z.iso.datetime(),
  scope: z.literal("shared-stock-all-appliances"),
  countingBasis: z.literal("completed-by-finishedAt"),
  policy: z.object(Object.fromEntries(Object.entries(policy).map(([key, value]) =>
    [key, z.literal(value)]))),
  inventoryCount: z.number().int().min(0).max(999).nullable(),
  history: cycleSummarySchema,
  window: z.object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    bounds: z.literal("[from,to)"),
    observedDays: z.number().min(0).max(28),
    completedCycles: z.number().int().nonnegative(),
    inferredCompletions: z.number().int().nonnegative(),
    unfinishedRecords: z.number().int().nonnegative(),
    cyclesWithObservationGaps: z.number().int().nonnegative(),
  }),
  status: z.enum(["estimated", "inventory-unavailable", "insufficient-history", "no-observed-usage"]),
  capsulesPerDay: z.number().positive().nullable(),
  estimatedDaysRemaining: z.number().nonnegative().nullable(),
  action: z.enum(["order", "none", "unknown"]),
  reason: z.enum(["out-of-stock", "within-reorder-window", "stock-only-low",
    "sufficient-estimated-stock", "estimate-unavailable", "inventory-unavailable"]),
  uncertainty: z.array(z.enum(["continuous-coverage-unknown", "one-tablet-per-completion-assumption",
    "inferred-completions", "unfinished-records", "observation-gaps"])),
});

function decision(inventoryCount, window) {
  const sufficient = window.observedDays >= policy.minimumHistoryDays
    && window.completedCycles >= policy.minimumCompletedCycles;
  const status = inventoryCount === null ? "inventory-unavailable"
    : sufficient ? "estimated"
      : window.observedDays >= policy.minimumHistoryDays && window.completedCycles === 0
        ? "no-observed-usage" : "insufficient-history";
  const capsulesPerDay = status === "estimated"
    ? window.completedCycles / window.observedDays : null;
  const estimatedDaysRemaining = capsulesPerDay === null ? null : inventoryCount / capsulesPerDay;
  const reason = inventoryCount === null ? "inventory-unavailable"
    : inventoryCount === 0 ? "out-of-stock"
      : estimatedDaysRemaining !== null
        ? estimatedDaysRemaining <= policy.reorderThresholdDays
          ? "within-reorder-window" : "sufficient-estimated-stock"
        : inventoryCount <= policy.stockOnlyThreshold ? "stock-only-low" : "estimate-unavailable";
  return {
    status, capsulesPerDay, estimatedDaysRemaining, reason,
    action: ["out-of-stock", "within-reorder-window", "stock-only-low"].includes(reason) ? "order"
      : reason === "sufficient-estimated-stock" ? "none" : "unknown",
  };
}

function uncertainty(window) {
  return [
    "continuous-coverage-unknown", "one-tablet-per-completion-assumption",
    ...(window.inferredCompletions ? ["inferred-completions"] : []),
    ...(window.unfinishedRecords ? ["unfinished-records"] : []),
    ...(window.cyclesWithObservationGaps ? ["observation-gaps"] : []),
  ];
}

export function buildSupplyForecast(cycles, capsuleCount, appliances = [], now = new Date()) {
  const history = buildCycleSummary(cycles, appliances, now);
  const records = parseCycleHistory(cycles);
  const end = now.valueOf();
  const observed = records.filter((cycle) => Date.parse(cycle.firstObservedAt) < end);
  const first = observed.reduce((earliest, cycle) =>
    Math.min(earliest, Date.parse(cycle.firstObservedAt)), end);
  const start = Math.max(end - policy.windowDays * DAY_MS, first);
  const within = (at) => Date.parse(at) >= start && Date.parse(at) < end;
  const completed = records.filter((cycle) => cycle.status === "finished" && within(cycle.finishedAt));
  const unfinished = records.filter((cycle) => cycle.status !== "finished"
    && Date.parse(cycle.firstObservedAt) < end && Date.parse(cycle.lastObservedAt) >= start);
  const window = {
    from: new Date(start).toISOString(), to: now.toISOString(), bounds: "[from,to)",
    observedDays: (end - start) / DAY_MS,
    completedCycles: completed.length,
    inferredCompletions: completed.filter((cycle) => cycle.finishConfidence === "inferred").length,
    unfinishedRecords: unfinished.length,
    cyclesWithObservationGaps: [...completed, ...unfinished]
      .filter((cycle) => cycle.observationGaps.length > 0).length,
  };
  const inventoryCount = Number.isInteger(capsuleCount) && capsuleCount >= 0 && capsuleCount <= 999
    ? capsuleCount : null;
  return validateSupplyForecast({
    summarizedAt: now.toISOString(),
    scope: "shared-stock-all-appliances",
    countingBasis: "completed-by-finishedAt",
    policy, inventoryCount, history, window,
    ...decision(inventoryCount, window),
    uncertainty: uncertainty(window),
  }, inventoryCount);
}

export function validateSupplyForecast(value, capsuleCount) {
  const parsed = forecastSchema.safeParse(value);
  if (parsed.success) {
    const result = parsed.data;
    const { window, history } = result;
    const expected = decision(result.inventoryCount, window);
    if (result.inventoryCount === capsuleCount
      && result.summarizedAt === history.summarizedAt && result.summarizedAt === window.to
      && Math.abs(Date.parse(window.to) - Date.parse(window.from) - window.observedDays * DAY_MS) < 0.001
      && window.completedCycles <= history.completed
      && window.inferredCompletions <= window.completedCycles
      && window.unfinishedRecords <= history.running + history.incomplete
      && window.cyclesWithObservationGaps <= window.completedCycles + window.unfinishedRecords
      && Object.entries(expected).every(([key, item]) => result[key] === item)
      && JSON.stringify(result.uncertainty) === JSON.stringify(uncertainty(window))) {
      return result;
    }
  }
  throw new Error("Missing or invalid supply forecast. Refresh the dashboard and check service logs.");
}

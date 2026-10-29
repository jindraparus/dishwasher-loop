import { z } from "zod";
import { formatProgramName } from "../public/lib/format.js";
import {
  buildCycleSummary, cycleSummarySchema, parseCycleHistory, selectCycleSummary,
} from "./cycle-summary.js";
import { cyclePeriodDates } from "./cycles.js";

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const timeZone = z.string().min(1).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}, "Use a valid IANA timezone.");

export const cycleAnalyticsInput = {
  applianceId: z.string().trim().min(1).optional()
    .describe("Appliance ID; omit to aggregate all recorded and discovered appliances."),
  period: z.enum(["all", "this-week", "range"]).default("all")
    .describe("All recorded history, Monday to now in timeZone, or an explicit [from, to) range."),
  timeZone: timeZone.optional()
    .describe("IANA timezone, defaulting to the service CYCLE_TIMEZONE (normally Europe/Prague)."),
  from: timestamp.optional().describe("Inclusive range start with explicit UTC offset; requires period=range."),
  to: timestamp.optional().describe("Exclusive range end with explicit UTC offset; requires period=range."),
};

const inputSchema = z.object(cycleAnalyticsInput).strict().refine(
  (value) => value.period === "range"
    ? value.from !== undefined && value.to !== undefined
      && Date.parse(value.from) < Date.parse(value.to)
    : value.from === undefined && value.to === undefined,
  "Use both from and to with from < to for period=range; omit them for other periods.",
);

export function parseCycleAnalyticsOptions(options) {
  const parsed = inputSchema.safeParse(options);
  if (!parsed.success) {
    throw new CycleAnalyticsInputError(`Invalid cycle analytics options: ${parsed.error.message}`);
  }
  return parsed.data;
}

export class CycleAnalyticsInputError extends Error {}

const programSchema = z.object({
  programKey: z.string().min(1).nullable(),
  programName: z.string().min(1).nullable(),
  count: count.positive(),
});

export const cycleAnalyticsSchema = z.object({
  scope: z.literal("persisted-cycle-analytics"),
  summarizedAt: z.iso.datetime(),
  countingBasis: z.literal("startedAt-or-firstObservedAt"),
  population: z.literal("all-observed-including-incomplete"),
  interval: z.object({
    period: z.enum(["all", "this-week", "range"]),
    timeZone,
    weekStartsOn: z.literal("Monday"),
    from: z.iso.datetime().nullable(),
    to: z.iso.datetime().nullable(),
    bounds: z.literal("[from,to)"),
  }).refine((value) => value.period === "all"
    ? value.from === null && value.to === null
    : value.from !== null && value.to !== null && value.from <= value.to),
  history: cycleSummarySchema,
  summary: cycleSummarySchema,
  missingStartFallbackCount: count,
  programs: z.array(programSchema),
  mostUsedPrograms: z.array(z.string().min(1).nullable()),
}).refine((value) => {
  const { summary, history, programs } = value;
  const winners = programs.filter((item) => item.count === programs[0]?.count)
    .map((item) => item.programKey);
  return value.summarizedAt === summary.summarizedAt
    && value.summarizedAt === history.summarizedAt
    && summary.totalObserved <= history.totalObserved
    && summary.appliances.length === history.appliances.length
    && summary.appliances.every((item, index) =>
      item.applianceId === history.appliances[index].applianceId
      && item.totalObserved <= history.appliances[index].totalObserved)
    && value.missingStartFallbackCount === summary.missingStartBoundaries
    && programs.reduce((total, item) => total + item.count, 0) === summary.totalObserved
    && new Set(programs.map((item) => item.programKey)).size === programs.length
    && programs.every((item, index) =>
      (item.programKey === null) === (item.programName === null)
      && (index === 0 || item.count <= programs[index - 1].count))
    && JSON.stringify(winners) === JSON.stringify(value.mostUsedPrograms);
}, "Analytics must reconcile counts, programs, scope, and timestamps.");

export function buildCycleAnalytics(cycles, appliances = [], options = {}, now = new Date(),
  defaultTimeZone = "Europe/Prague") {
  const input = parseCycleAnalyticsOptions(options);
  const timezone = timeZone.parse(input.timeZone ?? defaultTimeZone);
  const history = selectCycleSummary(buildCycleSummary(cycles, appliances, now), input.applianceId);
  const scoped = parseCycleHistory(cycles).filter((cycle) =>
    input.applianceId === undefined || cycle.applianceId === input.applianceId);
  const from = input.period === "this-week"
    ? startOfLocalDate(cyclePeriodDates("week", timezone, now).periodStart, timezone)
    : input.period === "range" ? new Date(input.from).toISOString() : null;
  const to = input.period === "this-week" ? now.toISOString()
    : input.period === "range" ? new Date(input.to).toISOString() : null;
  const filtered = scoped.filter((cycle) => {
    const at = Date.parse(cycle.startedAt ?? cycle.firstObservedAt);
    return from === null || (at >= Date.parse(from) && at < Date.parse(to));
  });
  const summary = buildCycleSummary(filtered, history.appliances.map((item) => ({
    id: item.applianceId, name: item.applianceName,
  })), now);
  const usage = new Map();
  for (const cycle of filtered) {
    const key = cycle.programKey || null;
    usage.set(key, (usage.get(key) ?? 0) + 1);
  }
  const programs = [...usage].map(([programKey, total]) => ({
    programKey,
    programName: programKey === null ? null : formatProgramName(programKey),
    count: total,
  })).sort((left, right) => right.count - left.count
    || (left.programKey ?? "").localeCompare(right.programKey ?? ""));
  return cycleAnalyticsSchema.parse({
    scope: "persisted-cycle-analytics",
    summarizedAt: now.toISOString(),
    countingBasis: "startedAt-or-firstObservedAt",
    population: "all-observed-including-incomplete",
    interval: {
      period: input.period, timeZone: timezone, weekStartsOn: "Monday",
      from, to, bounds: "[from,to)",
    },
    history,
    summary,
    missingStartFallbackCount: summary.missingStartBoundaries,
    programs,
    mostUsedPrograms: programs.filter((item) => item.count === programs[0]?.count)
      .map((item) => item.programKey),
  });
}

// Find the first instant on the local date rather than assuming a fixed UTC offset.
function startOfLocalDate(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  let low = Date.parse(`${date}T00:00:00.000Z`) - 36 * 3_600_000;
  let high = low + 72 * 3_600_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const parts = Object.fromEntries(formatter.formatToParts(middle)
      .map((part) => [part.type, part.value]));
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    if (key < date) low = middle + 1;
    else high = middle;
  }
  return new Date(low).toISOString();
}

export function validateCycleAnalytics(value) {
  const parsed = cycleAnalyticsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Dishwasher Loop returned missing or invalid cycle analytics data. "
      + "Deploy a service version supporting /api/cycles/analytics and check its logs and storage.");
  }
  return parsed.data;
}

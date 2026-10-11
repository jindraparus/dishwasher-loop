import { createHash } from "node:crypto";

const TERMINAL_WINDOW_MS = 5 * 60 * 1000;
const RUN = ".OperationState.Run";
const FINISHED = ".OperationState.Finished";
const READY = ".OperationState.Ready";
const INACTIVE = ".OperationState.Inactive";
const POWER_OFF = ".PowerState.Off";
const PRESENT = ".EventPresentState.Present";

export class CycleTracker {
  constructor(storage, logger = console, { terminalWindowMs = TERMINAL_WINDOW_MS } = {}) {
    this.storage = storage;
    this.logger = logger;
    this.terminalWindowMs = terminalWindowMs;
    this.states = new Map();
    this.cycles = new Map();
    this.terminalTimers = new Map();
  }

  async initialize() {
    const report = await backfillCycleHistory(this.storage, this.logger, {
      terminalWindowMs: this.terminalWindowMs,
    });
    const cycles = await this.storage.listAllCycles();
    for (const cycle of cycles) {
      this.cycles.set(cycle.cycleId, structuredClone(cycle));
      const state = this.stateFor(cycle.applianceId);
      if (cycle.status === "running"
        && (!state.open || cycle.firstObservedAt > state.open.firstObservedAt)) {
        state.open = this.cycles.get(cycle.cycleId);
        this.scheduleTerminalResolution(state.open);
      } else if (cycle.status !== "running"
        && (!state.lastClosed || cycle.lastObservedAt > state.lastClosed.lastObservedAt)) {
        state.lastClosed = this.cycles.get(cycle.cycleId);
      }
    }
    return report;
  }

  async processEvent(event, { persist = true } = {}) {
    if (!event?.applianceId || !event.receivedAt || !Array.isArray(event.data?.items)) {
      return null;
    }

    const at = normalizeTimestamp(event.receivedAt);
    const state = this.stateFor(event.applianceId);
    const signals = extractSignals(event.data.items);
    const sourceId = eventIdentity(event);
    const alreadyProcessed = [...this.cycles.values()].find(
      (item) => item.sourceEventIds.includes(sourceId),
    );
    if (alreadyProcessed) {
      this.updateLastState(state, signals);
      return structuredClone(alreadyProcessed);
    }
    let cycle = state.open;
    let changed = false;

    if (signals.selectedProgram) {
      state.selectedProgram = signals.selectedProgram;
    }

    if (cycle && signals.activeProgram
      && cycle.programKey && cycle.programKey !== signals.activeProgram) {
      await this.closeIncomplete(cycle, at, "superseded", persist);
      this.clearTerminalTimer(cycle.cycleId);
      state.lastClosed = cycle;
      state.open = null;
      cycle = null;
    }

    const activeProgramStarted = signals.activeProgram
      && signals.activeProgram !== state.lastActiveProgram
      && String(event.eventType).toUpperCase() === "NOTIFY";
    const operationStarted = signals.operationRun
      && state.lastOperationState
      && !String(state.lastOperationState).endsWith(RUN);
    const strongStart = signals.programStarted || activeProgramStarted || operationStarted;
    const supportingStart = Boolean(
      signals.activeProgram
      || signals.operationRun
      || signals.progress !== null
      || signals.remainingSeconds !== null,
    );

    if (!cycle && (strongStart || supportingStart)) {
      if (this.isPostFinishTelemetry(state.lastClosed, at, strongStart)) {
        this.updateLastState(state, signals);
        return state.lastClosed;
      }
      cycle = createCycle(event, signals, at, strongStart);
      state.open = cycle;
      this.cycles.set(cycle.cycleId, cycle);
      changed = true;
    }

    if (cycle) {
      changed = updateOpenCycle(cycle, signals, at, sourceId, strongStart) || changed;
      const strongFinish = signals.programFinished || signals.operationFinished;
      if (strongFinish) {
        finishCycle(cycle, at, signals.programFinished
          ? "program-finished"
          : "operation-finished", "observed", sourceId);
        state.open = null;
        state.lastClosed = cycle;
        this.clearTerminalTimer(cycle.cycleId);
        changed = true;
      } else {
        changed = updateTerminalEvidence(
          cycle,
          signals,
          at,
          this.terminalWindowMs,
        ) || changed;
        if (cycle.pendingTerminalSignals.length >= 2) {
          finishCycle(
            cycle,
            at,
            "correlated-terminal-signals",
            "inferred",
            sourceId,
          );
          state.open = null;
          state.lastClosed = cycle;
          this.clearTerminalTimer(cycle.cycleId);
          changed = true;
        } else if (persist && cycle.pendingTerminalSignals.length > 0) {
          this.scheduleTerminalResolution(cycle);
        }
      }
    } else if (signals.programFinished || signals.operationFinished) {
      const evidence = signals.programFinished
        ? "program-finished"
        : "operation-finished";
      if (state.lastClosed?.status === "incomplete"
        && state.lastClosed.result === "unknown") {
        finishCycle(state.lastClosed, at, evidence, "observed", sourceId);
        cycle = state.lastClosed;
        changed = true;
      } else if (isRecentCycle(state.lastClosed, at, this.terminalWindowMs)) {
        changed = addUnique(state.lastClosed.finishEvidence, evidence);
        changed = addUnique(state.lastClosed.sourceEventIds, sourceId) || changed;
        state.lastClosed.lastObservedAt = maxTimestamp(state.lastClosed.lastObservedAt, at);
        cycle = state.lastClosed;
      } else {
        cycle = createFinishOnlyCycle(event, signals, at, sourceId);
        this.cycles.set(cycle.cycleId, cycle);
        state.lastClosed = cycle;
        changed = true;
      }
    }

    this.updateLastState(state, signals);
    if (changed && persist && cycle) {
      await this.storage.saveCycle(cycle);
    }
    return cycle ? structuredClone(cycle) : null;
  }

  async recordDisconnect(applianceId, at = new Date().toISOString()) {
    const cycle = this.stateFor(applianceId).open;
    if (!cycle) {
      return;
    }
    const lastGap = cycle.observationGaps.at(-1);
    if (!lastGap || lastGap.endedAt) {
      cycle.observationGaps.push({ startedAt: normalizeTimestamp(at), endedAt: null });
      await this.storage.saveCycle(cycle);
    }
  }

  async recordReconnect(applianceId, at = new Date().toISOString()) {
    const cycle = this.stateFor(applianceId).open;
    const lastGap = cycle?.observationGaps.at(-1);
    if (lastGap && !lastGap.endedAt) {
      lastGap.endedAt = normalizeTimestamp(at);
      cycle.lastObservedAt = maxTimestamp(cycle.lastObservedAt, lastGap.endedAt);
      await this.storage.saveCycle(cycle);
    }
  }

  async closeIncomplete(cycle, at, result, persist = true) {
    cycle.status = "incomplete";
    cycle.result = result;
    cycle.finishedAt = null;
    cycle.durationSeconds = null;
    cycle.finishConfidence = "missing";
    cycle.lastObservedAt = maxTimestamp(cycle.lastObservedAt, at);
    cycle.pendingTerminalSignals = [];
    this.clearTerminalTimer(cycle.cycleId);
    if (persist) {
      await this.storage.saveCycle(cycle);
    }
  }

  stateFor(applianceId) {
    if (!this.states.has(applianceId)) {
      this.states.set(applianceId, {
        open: null,
        lastClosed: null,
        lastActiveProgram: null,
        lastOperationState: null,
        selectedProgram: null,
      });
    }
    return this.states.get(applianceId);
  }

  isPostFinishTelemetry(lastClosed, at, strongStart) {
    return Boolean(
      lastClosed
      && !strongStart
      && isRecentCycle(lastClosed, at, this.terminalWindowMs),
    );
  }

  updateLastState(state, signals) {
    if (signals.hasActiveProgram) {
      state.lastActiveProgram = signals.activeProgram;
    }
    if (signals.operationState) {
      state.lastOperationState = signals.operationState;
    }
  }

  scheduleTerminalResolution(cycle) {
    if (cycle.status !== "running" || cycle.pendingTerminalSignals.length === 0) {
      return;
    }
    this.clearTerminalTimer(cycle.cycleId);
    const latestSignalAt = cycle.pendingTerminalSignals
      .map((signal) => Date.parse(signal.observedAt))
      .reduce((latest, value) => Math.max(latest, value), 0);
    const delay = Math.max(0, latestSignalAt + this.terminalWindowMs - Date.now());
    const timer = setTimeout(() => {
      this.terminalTimers.delete(cycle.cycleId);
      const state = this.stateFor(cycle.applianceId);
      if (state.open?.cycleId !== cycle.cycleId
        || cycle.pendingTerminalSignals.length === 0) {
        return;
      }
      void this.closeIncomplete(
        cycle,
        cycle.lastObservedAt,
        "unknown",
      ).then(() => {
        state.open = null;
        state.lastClosed = cycle;
      }).catch((error) => {
        this.logger.error?.("Unable to resolve incomplete dishwasher cycle", error);
      });
    }, delay);
    timer.unref?.();
    this.terminalTimers.set(cycle.cycleId, timer);
  }

  clearTerminalTimer(cycleId) {
    const timer = this.terminalTimers.get(cycleId);
    if (timer) {
      clearTimeout(timer);
      this.terminalTimers.delete(cycleId);
    }
  }

  async resolveExpiredTerminals(at = new Date().toISOString(), persist = true) {
    const reference = Date.parse(normalizeTimestamp(at));
    for (const state of this.states.values()) {
      const cycle = state.open;
      if (!cycle || cycle.pendingTerminalSignals.length === 0) {
        continue;
      }
      const latestSignal = cycle.pendingTerminalSignals
        .map((signal) => Date.parse(signal.observedAt))
        .reduce((latest, value) => Math.max(latest, value), 0);
      if (latestSignal + this.terminalWindowMs > reference) {
        continue;
      }
      await this.closeIncomplete(cycle, cycle.lastObservedAt, "unknown", persist);
      state.open = null;
      state.lastClosed = cycle;
    }
  }
}

export async function backfillCycleHistory(storage, logger = console, options = {}) {
  const events = await storage.listAllEvents();
  if (events.length === 0) {
    return { events: 0, cycles: 0, complete: 0, incomplete: 0 };
  }

  const tracker = new CycleTracker(storage, logger, options);
  for (const event of events) {
    await tracker.processEvent(event, { persist: false });
  }
  await tracker.resolveExpiredTerminals(new Date().toISOString(), false);
  const cycles = [...tracker.cycles.values()];
  for (const cycle of cycles) {
    await storage.saveCycle(cycle);
  }
  const report = {
    events: events.length,
    cycles: cycles.length,
    complete: cycles.filter(hasCompleteBoundaries).length,
    incomplete: cycles.filter((cycle) => !hasCompleteBoundaries(cycle)).length,
  };
  logger.info?.("Cycle history backfill complete", report);
  return report;
}

export function buildCycleStats(cycles, period, timezone, now = new Date()) {
  if (!["week", "month"].includes(period)) {
    throw new Error("Period must be week or month.");
  }
  validateTimezone(timezone);
  const current = localDateParts(now, timezone);
  const start = period === "month"
    ? { year: current.year, month: current.month, day: 1 }
    : addUtcDays(current, -(dayOfWeek(current) + 6) % 7);
  const end = period === "month"
    ? addUtcDays({ year: start.year, month: start.month + 1, day: 1 }, -1)
    : addUtcDays(start, 6);
  const startKey = dateKey(start);
  const endKey = dateKey(end);
  const periodCycles = cycles.filter((cycle) => {
    if (!cycle.finishedAt || cycle.result !== "finished") {
      return false;
    }
    const key = dateKey(localDateParts(new Date(cycle.finishedAt), timezone));
    return key >= startKey && key <= endKey;
  });
  const knownDurations = periodCycles
    .map((cycle) => cycle.durationSeconds)
    .filter(Number.isFinite);
  const programs = new Map();
  for (const cycle of periodCycles) {
    const program = cycle.programKey || "unknown";
    programs.set(program, (programs.get(program) || 0) + 1);
  }
  const [mostUsedProgram = null, mostUsedProgramCount = 0] = [...programs]
    .sort((left, right) => right[1] - left[1])[0] || [];
  const incompleteCycleCount = cycles.filter((cycle) => {
    if (cycle.status !== "incomplete") {
      return false;
    }
    const reference = cycle.finishedAt || cycle.lastObservedAt || cycle.firstObservedAt;
    const key = dateKey(localDateParts(new Date(reference), timezone));
    return key >= startKey && key <= endKey;
  }).length;

  return {
    period,
    timezone,
    periodStart: startKey,
    periodEnd: endKey,
    completedCycleCount: periodCycles.length,
    completeBoundaryCount: periodCycles.filter(hasCompleteBoundaries).length,
    incompleteCycleCount,
    totalDurationSeconds: knownDurations.reduce((total, value) => total + value, 0),
    averageDurationSeconds: knownDurations.length > 0
      ? Math.round(knownDurations.reduce((total, value) => total + value, 0)
        / knownDurations.length)
      : null,
    mostUsedProgram,
    mostUsedProgramCount,
  };
}

export function parseCycleLimit(value, fallback = 50, maximum = 100) {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(String(value))) {
    throw new Error("Limit must be an integer.");
  }
  const limit = Number(value);
  if (limit < 1 || limit > maximum) {
    throw new Error(`Limit must be between 1 and ${maximum}.`);
  }
  return limit;
}

function extractSignals(items) {
  const signals = {
    activeProgram: null,
    hasActiveProgram: false,
    selectedProgram: null,
    operationState: null,
    operationRun: false,
    operationFinished: false,
    programStarted: false,
    programFinished: false,
    progress: null,
    remainingSeconds: null,
    terminalSignals: [],
    hasCycleEvidence: false,
  };
  for (const item of items) {
    const key = String(item?.key || "");
    const value = item?.value;
    if (key.endsWith("Root.ActiveProgram")) {
      signals.hasActiveProgram = true;
      signals.activeProgram = typeof value === "string" && value ? value : null;
      if (signals.activeProgram === null) {
        signals.terminalSignals.push("active-program-cleared");
      }
    } else if (key.endsWith("Root.SelectedProgram") && typeof value === "string") {
      signals.selectedProgram = value;
    } else if (key.endsWith("Status.OperationState")) {
      signals.operationState = String(value);
      signals.operationRun = signals.operationState.endsWith(RUN);
      signals.operationFinished = signals.operationState.endsWith(FINISHED);
      if (signals.operationState.endsWith(READY)
        || signals.operationState.endsWith(INACTIVE)) {
        signals.terminalSignals.push("operation-terminal");
      }
    } else if (key.endsWith("Event.ProgramStarted")
      && (value === true || String(value).endsWith(PRESENT))) {
      signals.programStarted = true;
    } else if (key.endsWith("Event.ProgramFinished")
      && (value === true || String(value).endsWith(PRESENT))) {
      signals.programFinished = true;
    } else if (key.endsWith("Option.ProgramProgress") && Number.isFinite(Number(value))) {
      signals.progress = Math.min(100, Math.max(0, Number(value)));
      if (signals.progress === 100) {
        signals.terminalSignals.push("progress-complete");
      }
    } else if (key.endsWith("Option.RemainingProgramTime")
      && Number.isFinite(Number(value))) {
      signals.remainingSeconds = Math.max(0, Number(value));
    } else if (key.endsWith("Setting.PowerState") && String(value).endsWith(POWER_OFF)) {
      signals.terminalSignals.push("power-off");
    }
  }
  signals.terminalSignals = [...new Set(signals.terminalSignals)];
  signals.hasCycleEvidence = Boolean(
    signals.hasActiveProgram
    || signals.selectedProgram
    || signals.operationState
    || signals.programStarted
    || signals.programFinished
    || signals.progress !== null
    || signals.remainingSeconds !== null
    || signals.terminalSignals.length > 0,
  );
  return signals;
}

function createCycle(event, signals, at, strongStart) {
  const programKey = signals.activeProgram || signals.selectedProgram || null;
  const startedAt = strongStart ? at : null;
  return {
    cycleId: cycleId(event.applianceId, startedAt || `observed:${at}`),
    applianceId: event.applianceId,
    applianceName: event.applianceName || "Myčka nádobí",
    programKey,
    status: "running",
    result: "unknown",
    startedAt,
    finishedAt: null,
    durationSeconds: null,
    firstObservedAt: at,
    lastObservedAt: at,
    startEvidence: strongStart ? startEvidence(signals) : ["mid-cycle-observation"],
    finishEvidence: [],
    startConfidence: strongStart ? "observed" : "inferred",
    finishConfidence: "missing",
    observationGaps: [],
    sourceEventIds: [],
    progressMin: signals.progress,
    progressMax: signals.progress,
    remainingInitialSeconds: signals.remainingSeconds,
    remainingLastSeconds: signals.remainingSeconds,
    pendingTerminalSignals: [],
  };
}

function createFinishOnlyCycle(event, signals, at, sourceId) {
  return {
    ...createCycle(event, signals, at, false),
    cycleId: cycleId(event.applianceId, `finish:${at}`),
    status: "finished",
    result: "finished",
    startedAt: null,
    finishedAt: at,
    startEvidence: [],
    finishEvidence: [signals.programFinished ? "program-finished" : "operation-finished"],
    startConfidence: "missing",
    finishConfidence: "observed",
    sourceEventIds: [sourceId],
  };
}

function updateOpenCycle(cycle, signals, at, sourceId, strongStart) {
  let changed = false;
  if (signals.hasCycleEvidence && at > cycle.lastObservedAt) {
    cycle.lastObservedAt = at;
    changed = true;
  }
  if (!cycle.programKey && (signals.activeProgram || signals.selectedProgram)) {
    cycle.programKey = signals.activeProgram || signals.selectedProgram;
    changed = true;
  }
  if (strongStart) {
    if (!cycle.startedAt) {
      cycle.startedAt = at;
      cycle.startConfidence = "observed";
      changed = true;
    }
    for (const evidence of startEvidence(signals)) {
      changed = addUnique(cycle.startEvidence, evidence) || changed;
    }
    changed = addUnique(cycle.sourceEventIds, sourceId) || changed;
  }
  if (signals.progress !== null) {
    cycle.progressMin = cycle.progressMin === null
      ? signals.progress
      : Math.min(cycle.progressMin, signals.progress);
    cycle.progressMax = cycle.progressMax === null
      ? signals.progress
      : Math.max(cycle.progressMax, signals.progress);
    changed = true;
  }
  if (signals.remainingSeconds !== null) {
    cycle.remainingInitialSeconds ??= signals.remainingSeconds;
    cycle.remainingLastSeconds = signals.remainingSeconds;
    changed = true;
  }
  return changed;
}

function updateTerminalEvidence(cycle, signals, at, windowMs) {
  const minimumTime = Date.parse(at) - windowMs;
  const previous = cycle.pendingTerminalSignals.length;
  cycle.pendingTerminalSignals = cycle.pendingTerminalSignals
    .filter((signal) => Date.parse(signal.observedAt) >= minimumTime);
  for (const signal of signals.terminalSignals) {
    const existing = cycle.pendingTerminalSignals.find((item) => item.signal === signal);
    if (existing) {
      existing.observedAt = at;
    } else {
      cycle.pendingTerminalSignals.push({ signal, observedAt: at });
    }
  }
  return previous !== cycle.pendingTerminalSignals.length
    || signals.terminalSignals.length > 0;
}

function finishCycle(cycle, at, evidence, confidence, sourceId) {
  cycle.status = "finished";
  cycle.result = "finished";
  cycle.finishedAt = at;
  cycle.finishConfidence = confidence;
  cycle.lastObservedAt = maxTimestamp(cycle.lastObservedAt, at);
  addUnique(cycle.finishEvidence, evidence);
  addUnique(cycle.sourceEventIds, sourceId);
  cycle.durationSeconds = cycle.startedAt
    && cycle.startConfidence === "observed"
    && confidence === "observed"
    ? Math.max(0, Math.round((Date.parse(at) - Date.parse(cycle.startedAt)) / 1000))
    : null;
  cycle.pendingTerminalSignals = [];
}

function startEvidence(signals) {
  return [
    signals.programStarted && "program-started",
    signals.activeProgram && "active-program",
    signals.operationRun && "operation-run",
  ].filter(Boolean);
}

function hasCompleteBoundaries(cycle) {
  return Boolean(
    cycle.result === "finished"
    && cycle.startedAt
    && cycle.finishedAt
    && cycle.startConfidence === "observed"
    && cycle.finishConfidence === "observed"
    && Number.isFinite(cycle.durationSeconds),
  );
}

function cycleId(applianceId, boundary) {
  return createHash("sha256")
    .update(`${applianceId}\0${boundary}`)
    .digest("hex")
    .slice(0, 32);
}

function eventIdentity(event) {
  if (event.eventId) {
    return `id:${event.eventId}`;
  }
  return `hash:${createHash("sha256")
    .update(JSON.stringify([
      event.applianceId,
      event.eventType,
      event.receivedAt,
      event.data,
    ]))
    .digest("hex")
    .slice(0, 32)}`;
}

function isRecentCycle(cycle, at, windowMs) {
  if (!cycle?.lastObservedAt) {
    return false;
  }
  const difference = Date.parse(at) - Date.parse(cycle.lastObservedAt);
  return difference >= 0 && difference <= windowMs;
}

function addUnique(values, value) {
  if (!value || values.includes(value)) {
    return false;
  }
  values.push(value);
  return true;
}

function maxTimestamp(left, right) {
  return !left || right > left ? right : left;
}

function normalizeTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Invalid cycle event timestamp: ${value}`);
  }
  return date.toISOString();
}

function validateTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch (error) {
    throw new Error(`Invalid cycle statistics timezone: ${timezone}`, { cause: error });
  }
}

function localDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
  };
}

function dayOfWeek(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function addUtcDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function dateKey(parts) {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

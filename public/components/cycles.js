import {
  escapeHtml,
  formatDate,
  formatDuration,
  formatProgramName,
} from "../lib/format.js";

export function renderCycleStatsCard(stats = {}) {
  const week = stats.week || emptyStats();
  const month = stats.month || emptyStats();
  return `<section class="card cycle-stats-card">
    <div class="card-heading"><h2>Statistiky mytí</h2><span class="icon" aria-hidden="true">▥</span></div>
    <div class="cycle-stats">
      ${renderMetric("Tento týden", week.completedCycleCount)}
      ${renderMetric("Tento měsíc", month.completedCycleCount)}
      ${renderMetric(
        "Průměrná délka",
        month.averageDurationSeconds === null
          ? "Není k dispozici"
          : formatDuration(month.averageDurationSeconds),
      )}
      ${renderMetric(
        "Nejčastější program",
        month.mostUsedProgram
          ? formatProgramName(month.mostUsedProgram)
          : "Není k dispozici",
      )}
    </div>
    ${month.incompleteCycleCount > 0
      ? `<p class="cycle-note">${escapeHtml(incompleteRecordsNote(
        month.incompleteCycleCount,
      ))}</p>`
      : ""}
  </section>`;
}

export function renderCyclesCard(cycles = []) {
  return `<section class="card cycles-card">
    <div class="card-heading">
      <div><p class="eyebrow">Pozorované cykly</p><h2>Historie mytí</h2></div>
      <span class="subtle">Počet: ${cycles.length}</span>
    </div>
    ${cycles.length === 0
      ? `<p class="empty">Zatím nebyl zaznamenán žádný mycí cyklus.</p>`
      : `<div class="cycle-list">${cycles.map(renderCycle).join("")}</div>`}
  </section>`;
}

function renderCycle(cycle) {
  const program = cycle.programKey
    ? formatProgramName(cycle.programKey)
    : "Neznámý program";
  const status = cycleStatus(cycle);
  const started = cycle.startedAt
    ? formatDate(cycle.startedAt)
    : "Začátek nebyl zachycen";
  const finished = cycle.status === "running"
    ? "Právě probíhá"
    : cycle.finishedAt ? formatDate(cycle.finishedAt) : "Konec nebyl zachycen";
  const duration = Number.isFinite(cycle.durationSeconds)
    ? formatDuration(cycle.durationSeconds)
    : "Nelze spolehlivě určit";

  return `<article class="cycle">
    <div>
      <h3>${escapeHtml(program)}</h3>
      <p class="cycle-time">${escapeHtml(started)} → ${escapeHtml(finished)}</p>
    </div>
    <span class="cycle-status ${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>
    <strong class="cycle-duration">${escapeHtml(duration)}</strong>
  </article>`;
}

function renderMetric(label, value) {
  return `<div class="cycle-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function cycleStatus(cycle) {
  if (cycle.status === "running") {
    return { label: "Probíhá", tone: "running" };
  }
  if (cycle.status === "finished" && cycle.startedAt && cycle.finishedAt) {
    return { label: "Dokončeno", tone: "finished" };
  }
  if (cycle.status === "finished") {
    return { label: "Dokončeno, neúplná data", tone: "incomplete" };
  }
  return { label: "Neúplný záznam", tone: "incomplete" };
}

function emptyStats() {
  return {
    completedCycleCount: 0,
    incompleteCycleCount: 0,
    averageDurationSeconds: null,
    mostUsedProgram: null,
  };
}

function incompleteRecordsNote(count) {
  if (count === 1) {
    return "1 neúplný záznam není zahrnut do průměrné délky.";
  }
  if (count >= 2 && count <= 4) {
    return `${count} neúplné záznamy nejsou zahrnuty do průměrné délky.`;
  }
  return `${count} neúplných záznamů není zahrnuto do průměrné délky.`;
}

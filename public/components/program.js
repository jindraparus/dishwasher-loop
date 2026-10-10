import {
  escapeHtml,
  formatDuration,
  formatProgramName,
  formatValue,
} from "../lib/format.js";
import {
  adjustedRemainingSeconds,
  findStatusValue,
  isProgramActive,
} from "../lib/program.js";

export function renderProgramCard(diagnostics, now = Date.now()) {
  const diagnostic = diagnostics[0];
  const operationState = findStatusValue(diagnostic, ".OperationState");
  const running = isProgramActive(diagnostic, now);
  const program = diagnostic?.program;
  const programKey = program?.activeKey || program?.selectedKey;
  const programName = programKey ? formatProgramName(programKey) : "Program unavailable";

  if (!running) {
    return `<section class="card program-card">
      <div class="card-heading"><h2>Current program</h2><span class="icon" aria-hidden="true">◷</span></div>
      <p class="program-state">${escapeHtml(formatValue(operationState || "Idle"))}</p>
      <h3 class="program-name">No wash in progress</h3>
      ${programKey ? `<p class="subtle">Selected program: ${escapeHtml(programName)}</p>` : `<p class="subtle">Program details will appear when a wash starts.</p>`}
    </section>`;
  }

  const progress = Number.isFinite(program?.progress) ? Math.round(program.progress) : null;
  const remainingSeconds = adjustedRemainingSeconds(program, now);
  const estimatedFinish = remainingSeconds === null
    ? ""
    : new Date(now + remainingSeconds * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

  return `<section class="card program-card">
    <div class="card-heading"><h2>Current program</h2><span class="icon" aria-hidden="true">◷</span></div>
    <p class="program-state">Washing in progress</p>
    <h3 class="program-name">${escapeHtml(programName)}</h3>
    ${progress === null ? "" : `<progress class="program-progress" max="100" value="${progress}" aria-label="Program progress">${progress}%</progress>`}
    <div class="program-metrics">
      <div class="program-metric"><span>Remaining</span><strong>${escapeHtml(remainingSeconds === null ? "Waiting for update" : formatDuration(remainingSeconds))}</strong></div>
      <div class="program-metric"><span>Estimated finish</span><strong>${escapeHtml(estimatedFinish || "Waiting for update")}</strong></div>
      ${progress === null ? "" : `<div class="program-metric"><span>Progress</span><strong>${progress}%</strong></div>`}
      <div class="program-metric"><span>Appliance</span><strong>${escapeHtml(diagnostic?.name || "Dishwasher")}</strong></div>
    </div>
  </section>`;
}

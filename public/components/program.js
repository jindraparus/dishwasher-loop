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
  const programName = programKey ? formatProgramName(programKey) : "Program není k dispozici";

  if (!running) {
    return `<section class="card program-card">
      <div class="card-heading"><h2>Aktuální program</h2><span class="icon" aria-hidden="true">◷</span></div>
      <p class="program-state">${escapeHtml(formatValue(operationState || "Nečinná"))}</p>
      <h3 class="program-name">Právě neprobíhá mytí</h3>
      ${programKey ? `<p class="subtle">Vybraný program: ${escapeHtml(programName)}</p>` : `<p class="subtle">Podrobnosti programu se zobrazí po spuštění mytí.</p>`}
    </section>`;
  }

  const progress = Number.isFinite(program?.progress) ? Math.round(program.progress) : null;
  const remainingSeconds = adjustedRemainingSeconds(program, now);
  const estimatedFinish = remainingSeconds === null
    ? ""
    : new Date(now + remainingSeconds * 1000).toLocaleTimeString("cs-CZ", {
      hour: "2-digit",
      minute: "2-digit",
    });

  return `<section class="card program-card">
    <div class="card-heading"><h2>Aktuální program</h2><span class="icon" aria-hidden="true">◷</span></div>
    <p class="program-state">Probíhá mytí</p>
    <h3 class="program-name">${escapeHtml(programName)}</h3>
    ${progress === null ? "" : `<progress class="program-progress" max="100" value="${progress}" aria-label="Průběh programu">${progress}%</progress>`}
    <div class="program-metrics">
      <div class="program-metric"><span>Zbývá</span><strong>${escapeHtml(remainingSeconds === null ? "Čeká se na aktualizaci" : formatDuration(remainingSeconds))}</strong></div>
      <div class="program-metric"><span>Odhad dokončení</span><strong>${escapeHtml(estimatedFinish || "Čeká se na aktualizaci")}</strong></div>
      ${progress === null ? "" : `<div class="program-metric"><span>Průběh</span><strong>${progress}%</strong></div>`}
      <div class="program-metric"><span>Spotřebič</span><strong>${escapeHtml(diagnostic?.name || "Myčka nádobí")}</strong></div>
    </div>
  </section>`;
}

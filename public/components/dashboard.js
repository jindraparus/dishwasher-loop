import { escapeHtml } from "../lib/format.js";
import { renderDiagnosticsCard } from "./diagnostics.js";
import { renderCyclesCard, renderCycleStatsCard } from "./cycles.js";
import { renderEventsCard } from "./events.js";
import { renderHeader } from "./header.js";
import { renderProgramCard } from "./program.js";
import { renderRecommendationsCard } from "./recommendations.js";
import { renderSuppliesCard } from "./supplies.js";

export function renderDashboard(state, { error = "", now = Date.now() } = {}) {
  const diagnostics = state.diagnostics || [];
  const events = state.events || [];

  return `<div class="shell">
    ${renderHeader(state)}
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    <main class="dashboard">
      ${renderDiagnosticsCard(diagnostics)}
      ${renderProgramCard(diagnostics, now)}
      ${renderSuppliesCard(diagnostics, state.capsuleCount, state.supplyForecast)}
      ${renderRecommendationsCard(state, now)}
      ${renderCycleStatsCard(state.cycleStats)}
      ${renderCyclesCard(state.cycles, now)}
      ${renderEventsCard(events)}
    </main>
  </div>`;
}

export function renderDashboardError(message) {
  return `<div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">◌</div>
        <div><p class="eyebrow">Péče o domácnost</p><h1>Dishwasher Loop</h1></div>
      </div>
    </header>
    <p class="error" role="alert">${escapeHtml(message)}</p>
    <button class="button" type="button" data-retry>Zkusit znovu</button>
  </div>`;
}

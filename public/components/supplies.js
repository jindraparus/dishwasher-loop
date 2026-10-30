import { escapeHtml } from "../lib/format.js";
import { capsuleState as supplyState } from "../lib/supply.js";

export function renderSuppliesCard(diagnostics, capsuleCount, forecast) {
  const diagnostic = diagnostics[0];
  const salt = diagnostic?.consumables?.salt
    || { state: "unknown", label: "Čeká se na spotřebič" };
  const capsuleLabel = Number.isInteger(capsuleCount) ? capsuleCount : "Není k dispozici";
  const capsuleState = supplyState(capsuleCount, forecast);

  return `<section class="card supplies-card">
    <div class="card-heading"><h2>Zásoby</h2><span class="icon" aria-hidden="true">◇</span></div>
    <div class="supply">
      <div><div class="supply-label">Sůl do myčky</div><div class="supply-value ${escapeHtml(salt.state)}">${escapeHtml(salt.label)}</div></div>
    </div>
    <div class="supply">
      <div><div class="supply-label">Tablety do myčky</div><div class="capsule-count ${capsuleState}">${escapeHtml(capsuleLabel)}</div></div>
      ${Number.isInteger(capsuleCount) ? `<span class="subtle">zbývá</span>` : ""}
    </div>
  </section>`;
}

import { escapeHtml } from "../lib/format.js";

export function renderSuppliesCard(diagnostics, capsuleCount) {
  const diagnostic = diagnostics[0];
  const salt = diagnostic?.consumables?.salt
    || { state: "unknown", label: "Waiting for appliance" };
  const capsuleLabel = Number.isInteger(capsuleCount) ? capsuleCount : "Not available";
  const capsuleState = !Number.isInteger(capsuleCount)
    ? "unknown"
    : capsuleCount <= 5 ? "low" : "ok";

  return `<section class="card supplies-card">
    <div class="card-heading"><h2>Supplies</h2><span class="icon" aria-hidden="true">◇</span></div>
    <div class="supply">
      <div><div class="supply-label">Dishwasher salt</div><div class="supply-value ${escapeHtml(salt.state)}">${escapeHtml(salt.label)}</div></div>
    </div>
    <div class="supply">
      <div><div class="supply-label">Washing capsules</div><div class="capsule-count ${capsuleState}">${escapeHtml(capsuleLabel)}</div></div>
      ${Number.isInteger(capsuleCount) ? `<span class="subtle">remaining</span>` : ""}
    </div>
  </section>`;
}

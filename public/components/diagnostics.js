import {
  escapeHtml,
  formatApplianceType,
  formatDate,
  formatEventType,
  formatKey,
  formatValue,
} from "../lib/format.js";

export function renderDiagnosticsCard(diagnostics) {
  return `<section class="card diagnostics-card">
    <div class="card-heading"><h2>Aktuální diagnostika</h2><span class="icon" aria-hidden="true">◎</span></div>
    ${diagnostics.length === 0
      ? `<p class="empty">Pro zobrazení diagnostiky připojte Home Connect.</p>`
      : diagnostics.map(renderAppliance).join("")}
  </section>`;
}

function renderAppliance(diagnostic) {
  const details = [
    ["Připojení", diagnostic.connected === true ? "Připojeno"
      : diagnostic.connected === false ? "Odpojeno" : "Neznámé"],
    ...diagnostic.statusItems.map((item) => [
      formatKey(item.key),
      formatValue(item.value, item.unit),
    ]),
  ];
  if (diagnostic.lastEventType) {
    details.push([
      "Poslední událost",
      `${formatEventType(diagnostic.lastEventType)} · ${formatDate(diagnostic.lastEventAt)}`,
    ]);
  }
  if (diagnostic.statusError) {
    details.push(["Stav", `Nedostupné: ${diagnostic.statusError}`]);
  }

  return `<section class="appliance">
    <h3>${escapeHtml(diagnostic.name)}</h3>
    <p class="metadata">${escapeHtml(
      [diagnostic.brand, formatApplianceType(diagnostic.type), diagnostic.model].filter(Boolean).join(" · "),
    )}</p>
    <dl>${details.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
  </section>`;
}

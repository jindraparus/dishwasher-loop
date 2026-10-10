import {
  escapeHtml,
  formatDate,
  formatKey,
  formatValue,
} from "../lib/format.js";

export function renderDiagnosticsCard(diagnostics) {
  return `<section class="card diagnostics-card">
    <div class="card-heading"><h2>Current diagnostics</h2><span class="icon" aria-hidden="true">◎</span></div>
    ${diagnostics.length === 0
      ? `<p class="empty">Connect Home Connect to see appliance diagnostics.</p>`
      : diagnostics.map(renderAppliance).join("")}
  </section>`;
}

function renderAppliance(diagnostic) {
  const details = [
    ["Connection", diagnostic.connected === false ? "Offline" : "Online"],
    ...diagnostic.statusItems.map((item) => [
      formatKey(item.key),
      formatValue(item.value, item.unit),
    ]),
  ];
  if (diagnostic.lastEventType) {
    details.push([
      "Last event",
      `${diagnostic.lastEventType} · ${formatDate(diagnostic.lastEventAt)}`,
    ]);
  }
  if (diagnostic.statusError) {
    details.push(["Status", `Unavailable: ${diagnostic.statusError}`]);
  }

  return `<section class="appliance">
    <h3>${escapeHtml(diagnostic.name)}</h3>
    <p class="metadata">${escapeHtml(
      [diagnostic.brand, diagnostic.type, diagnostic.model].filter(Boolean).join(" · "),
    )}</p>
    <dl>${details.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
  </section>`;
}

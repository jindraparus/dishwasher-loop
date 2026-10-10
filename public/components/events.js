import { escapeHtml, formatDate, formatEventType } from "../lib/format.js";

export function renderEventsCard(events) {
  return `<section class="card events-card">
    <div class="card-heading">
      <div><p class="eyebrow">Poslední aktivita</p><h2>Historie událostí</h2></div>
      <span class="subtle">Počet: ${events.length}</span>
    </div>
    ${events.length === 0
      ? `<p class="empty">Zatím nebyly přijaty žádné události myčky.</p>`
      : `<div class="event-list">${events.map(renderEvent).join("")}</div>`}
  </section>`;
}

function renderEvent(event) {
  return `<details>
    <summary>
      <strong>${escapeHtml(event.applianceName)}</strong>
      <span class="type">${escapeHtml(formatEventType(event.eventType))}</span>
      <time datetime="${escapeHtml(event.receivedAt)}">${escapeHtml(formatDate(event.receivedAt))}</time>
    </summary>
    <pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
  </details>`;
}

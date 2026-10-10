import { escapeHtml, formatDate } from "../lib/format.js";

export function renderEventsCard(events) {
  return `<section class="card events-card">
    <div class="card-heading">
      <div><p class="eyebrow">Latest activity</p><h2>Event history</h2></div>
      <span class="subtle">${events.length} shown</span>
    </div>
    ${events.length === 0
      ? `<p class="empty">No dishwasher events received yet.</p>`
      : `<div class="event-list">${events.map(renderEvent).join("")}</div>`}
  </section>`;
}

function renderEvent(event) {
  return `<details>
    <summary>
      <strong>${escapeHtml(event.applianceName)}</strong>
      <span class="type">${escapeHtml(event.eventType)}</span>
      <time datetime="${escapeHtml(event.receivedAt)}">${escapeHtml(formatDate(event.receivedAt))}</time>
    </summary>
    <pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
  </details>`;
}

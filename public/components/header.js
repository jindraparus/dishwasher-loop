import { escapeHtml } from "../lib/format.js";

export function renderHeader({ authorized, monitorStatus }) {
  return `<header class="topbar">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">◌</div>
      <div>
        <p class="eyebrow">Péče o domácnost</p>
        <h1>Dishwasher Loop</h1>
        <p class="subtle">Klidný přehled každého mytí.</p>
      </div>
    </div>
    <div class="actions">
      <span class="status-pill">${escapeHtml(monitorStatus)}</span>
      ${authorized
        ? `<form method="post" action="/auth/disconnect"><button class="button button-secondary" type="submit">Odpojit</button></form>`
        : `<a class="button" href="/auth/login">Připojit Home Connect</a>`}
      <button class="button button-secondary settings-button" type="button" data-settings
        aria-label="Nastavení zásob" aria-haspopup="dialog" aria-controls="capsule-settings">
        <span aria-hidden="true">&#9881;</span>
      </button>
    </div>
  </header>`;
}

export function renderPage({
  events,
  authorized,
  monitorStatus,
  diagnostics,
  capsuleCount,
  error,
}) {
  const recommendations = buildRecommendations({
    authorized,
    diagnostics,
    capsuleCount,
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="refresh" content="30">
    <title>Dishwasher Loop</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #16333b;
        --muted: #647980;
        --surface: #ffffff;
        --canvas: #edf4f3;
        --line: #d7e4e2;
        --primary: #087f75;
        --primary-dark: #056159;
        --primary-soft: #dff4f0;
        --warning: #a15c00;
        --warning-soft: #fff1d6;
        --danger: #a33a3a;
        --danger-soft: #fde8e7;
        --shadow: 0 18px 45px rgba(20, 54, 61, .09);
      }
      * { box-sizing: border-box; }
      body {
        background: var(--canvas);
        color: var(--ink);
        font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
      }
      button, input { font: inherit; }
      .shell { margin: 0 auto; max-width: 1240px; padding: 2rem 1.25rem 4rem; }
      .topbar {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 1.25rem;
        justify-content: space-between;
        margin-bottom: 1.5rem;
      }
      .brand { align-items: center; display: flex; gap: .9rem; }
      .brand-mark {
        align-items: center;
        background: var(--primary);
        border-radius: 1rem;
        color: white;
        display: flex;
        font-size: 1.45rem;
        height: 3.25rem;
        justify-content: center;
        width: 3.25rem;
      }
      h1, h2, h3, p { margin-top: 0; }
      h1 { font-size: clamp(1.55rem, 3vw, 2.15rem); letter-spacing: -.04em; margin-bottom: .1rem; }
      h2 { font-size: 1.05rem; letter-spacing: -.01em; margin: 0; }
      h3 { font-size: 1rem; margin-bottom: .2rem; }
      .eyebrow {
        color: var(--primary);
        font-size: .76rem;
        font-weight: 750;
        letter-spacing: .12em;
        margin-bottom: .2rem;
        text-transform: uppercase;
      }
      .subtle, .metadata { color: var(--muted); }
      .subtle { margin: 0; }
      .actions { align-items: center; display: flex; flex-wrap: wrap; gap: .75rem; }
      .status-pill {
        background: var(--primary-soft);
        border-radius: 999px;
        color: var(--primary-dark);
        font-size: .86rem;
        font-weight: 700;
        padding: .48rem .8rem;
      }
      .button {
        background: var(--primary);
        border: 0;
        border-radius: .7rem;
        color: white;
        cursor: pointer;
        display: inline-block;
        font-weight: 700;
        padding: .65rem 1rem;
        text-decoration: none;
      }
      .button:hover { background: var(--primary-dark); }
      .button-secondary { background: transparent; border: 1px solid var(--line); color: var(--ink); }
      .error {
        background: var(--danger-soft);
        border: 1px solid #f2c5c2;
        border-radius: .8rem;
        color: var(--danger);
        padding: .85rem 1rem;
      }
      .dashboard {
        display: grid;
        gap: 1.1rem;
        grid-template-columns: repeat(12, 1fr);
      }
      .card {
        background: var(--surface);
        border: 1px solid rgba(215, 228, 226, .9);
        border-radius: 1.1rem;
        box-shadow: var(--shadow);
        min-width: 0;
        padding: 1.25rem;
      }
      .diagnostics-card { grid-column: span 5; }
      .supplies-card { grid-column: span 3; }
      .recommendations-card { grid-column: span 4; }
      .events-card { grid-column: 1 / -1; margin-top: .15rem; }
      .card-heading {
        align-items: center;
        display: flex;
        gap: .65rem;
        justify-content: space-between;
        margin-bottom: 1.1rem;
      }
      .icon {
        align-items: center;
        background: var(--primary-soft);
        border-radius: .65rem;
        color: var(--primary-dark);
        display: inline-flex;
        font-size: 1.1rem;
        height: 2.15rem;
        justify-content: center;
        width: 2.15rem;
      }
      .appliance + .appliance { border-top: 1px solid var(--line); margin-top: 1rem; padding-top: 1rem; }
      .metadata { font-size: .84rem; margin: 0 0 .9rem; }
      dl { display: grid; gap: .48rem 1rem; grid-template-columns: minmax(120px, auto) 1fr; margin: 0; }
      dt { color: var(--muted); font-size: .88rem; }
      dd { font-weight: 650; margin: 0; overflow-wrap: anywhere; text-align: right; }
      .empty { color: var(--muted); margin: 1.5rem 0; text-align: center; }
      .supply {
        align-items: center;
        display: flex;
        gap: .8rem;
        justify-content: space-between;
        padding: .85rem 0;
      }
      .supply + .supply { border-top: 1px solid var(--line); }
      .supply-label { color: var(--muted); font-size: .82rem; margin-bottom: .12rem; }
      .supply-value { font-size: 1.08rem; font-weight: 760; }
      .supply-value.low { color: var(--warning); }
      .supply-value.ok { color: var(--primary-dark); }
      .supply-value.unknown { color: var(--muted); }
      .capsule-count { font-size: 2rem; font-weight: 800; letter-spacing: -.05em; }
      .inventory-form { display: flex; gap: .5rem; margin-top: .8rem; }
      .inventory-form input {
        border: 1px solid var(--line);
        border-radius: .65rem;
        min-width: 0;
        padding: .58rem .65rem;
        width: 100%;
      }
      .inventory-form .button { padding-inline: .85rem; }
      .recommendations { display: grid; gap: .7rem; list-style: none; margin: 0; padding: 0; }
      .recommendation {
        background: #f5f9f8;
        border-left: 3px solid var(--primary);
        border-radius: .55rem;
        padding: .72rem .8rem;
      }
      .recommendation.warning { background: var(--warning-soft); border-color: var(--warning); }
      .recommendation strong { display: block; font-size: .9rem; margin-bottom: .12rem; }
      .recommendation span { color: var(--muted); font-size: .84rem; }
      .event-list { display: grid; gap: .65rem; }
      details {
        background: #f8fbfa;
        border: 1px solid var(--line);
        border-radius: .75rem;
        overflow: hidden;
      }
      summary {
        align-items: center;
        cursor: pointer;
        display: grid;
        gap: .7rem;
        grid-template-columns: minmax(150px, 1fr) auto auto;
        list-style: none;
        padding: .8rem .9rem;
      }
      summary::-webkit-details-marker { display: none; }
      .type {
        background: var(--primary-soft);
        border-radius: 999px;
        color: var(--primary-dark);
        font-size: .72rem;
        font-weight: 750;
        padding: .18rem .55rem;
      }
      time { color: var(--muted); font-size: .78rem; }
      pre {
        background: #102f36;
        color: #d9eeeb;
        margin: 0;
        overflow: auto;
        padding: 1rem;
        white-space: pre-wrap;
      }
      @media (max-width: 950px) {
        .diagnostics-card, .supplies-card, .recommendations-card { grid-column: span 6; }
        .recommendations-card { grid-column: 1 / -1; }
      }
      @media (max-width: 640px) {
        .shell { padding: 1.2rem .8rem 3rem; }
        .diagnostics-card, .supplies-card, .recommendations-card { grid-column: 1 / -1; }
        .card { padding: 1rem; }
        summary { grid-template-columns: 1fr auto; }
        summary time { grid-column: 1 / -1; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">◌</div>
          <div>
            <p class="eyebrow">Home care</p>
            <h1>Dishwasher Loop</h1>
            <p class="subtle">A calm view of every wash.</p>
          </div>
        </div>
        <div class="actions">
          <span class="status-pill">${escapeHtml(monitorStatus)}</span>
          ${authorized
            ? `<form method="post" action="/auth/disconnect"><button class="button button-secondary" type="submit">Disconnect</button></form>`
            : `<a class="button" href="/auth/login">Connect Home Connect</a>`}
        </div>
      </header>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <main class="dashboard">
        <section class="card diagnostics-card">
          <div class="card-heading"><h2>Current diagnostics</h2><span class="icon" aria-hidden="true">◎</span></div>
          ${diagnostics.length === 0
            ? `<p class="empty">Connect Home Connect to see appliance diagnostics.</p>`
            : diagnostics.map(renderDiagnostics).join("")}
        </section>
        ${renderSupplies(diagnostics, capsuleCount)}
        <section class="card recommendations-card">
          <div class="card-heading"><h2>Recommendations</h2><span class="icon" aria-hidden="true">✦</span></div>
          <ul class="recommendations">${recommendations.map(renderRecommendation).join("")}</ul>
        </section>
        <section class="card events-card">
          <div class="card-heading">
            <div><p class="eyebrow">Latest activity</p><h2>Event history</h2></div>
            <span class="subtle">${events.length} shown</span>
          </div>
          ${events.length === 0
            ? `<p class="empty">No dishwasher events received yet.</p>`
            : `<div class="event-list">${events.map(renderEvent).join("")}</div>`}
        </section>
      </main>
    </div>
  </body>
</html>`;
}

function renderDiagnostics(diagnostic) {
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

function renderSupplies(diagnostics, capsuleCount) {
  const diagnostic = diagnostics[0];
  const salt = diagnostic?.consumables?.salt
    || { state: "unknown", label: "Waiting for appliance" };
  const capsuleLabel = Number.isInteger(capsuleCount) ? capsuleCount : "—";
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
      <span class="subtle">${Number.isInteger(capsuleCount) ? "remaining" : "not set"}</span>
    </div>
    <form class="inventory-form" method="post" action="/supplies/capsules">
      <input aria-label="Washing capsule count" name="count" type="number" min="0" max="999" step="1" value="${Number.isInteger(capsuleCount) ? capsuleCount : ""}" placeholder="Count" required>
      <button class="button" type="submit">Save</button>
    </form>
  </section>`;
}

export function buildRecommendations({ authorized, diagnostics, capsuleCount }) {
  const recommendations = [];
  const diagnostic = diagnostics[0];
  if (!authorized) {
    recommendations.push({
      title: "Connect Home Connect",
      text: "Authorize the appliance account to begin monitoring.",
      tone: "warning",
    });
    return recommendations;
  }
  if (!diagnostic) {
    recommendations.push({
      title: "Waiting for the dishwasher",
      text: "No paired dishwasher diagnostics are available yet.",
      tone: "warning",
    });
    return recommendations;
  }
  if (diagnostic.connected === false) {
    recommendations.push({
      title: "Dishwasher is offline",
      text: "Check appliance power and Home Connect connectivity.",
      tone: "warning",
    });
  }
  if (diagnostic.consumables?.salt?.state === "low") {
    recommendations.push({
      title: "Refill dishwasher salt",
      text: "Add salt before the next wash for reliable water softening.",
      tone: "warning",
    });
  } else if (diagnostic.consumables?.salt?.state === "unknown") {
    recommendations.push({
      title: "Salt status is pending",
      text: "Home Connect has not reported a salt warning state yet.",
      tone: "",
    });
  }
  if (diagnostic.consumables?.rinseAid?.state === "low") {
    recommendations.push({
      title: "Refill rinse aid",
      text: "The appliance reports that rinse aid is nearly empty.",
      tone: "warning",
    });
  }
  if (!Number.isInteger(capsuleCount)) {
    recommendations.push({
      title: "Set capsule inventory",
      text: "Enter the number of washing capsules currently available.",
      tone: "",
    });
  } else if (capsuleCount <= 5) {
    recommendations.push({
      title: "Restock washing capsules",
      text: `Only ${capsuleCount} ${capsuleCount === 1 ? "capsule remains" : "capsules remain"}.`,
      tone: "warning",
    });
  }

  const operationState = diagnostic.statusItems.find(
    (item) => String(item.key).endsWith(".OperationState"),
  )?.value;
  if (String(operationState).endsWith(".Run")) {
    recommendations.push({
      title: "Wash cycle in progress",
      text: "No action is needed while the current program is running.",
      tone: "",
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      title: "Everything looks ready",
      text: "The dishwasher is connected and supplies look sufficient.",
      tone: "",
    });
  }
  return recommendations;
}

function renderRecommendation(recommendation) {
  return `<li class="recommendation ${escapeHtml(recommendation.tone)}"><strong>${escapeHtml(recommendation.title)}</strong><span>${escapeHtml(recommendation.text)}</span></li>`;
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

function formatKey(key) {
  const shortKey = String(key || "Status").split(".").at(-1);
  return shortKey.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function formatValue(value, unit) {
  let displayedValue = value !== null && typeof value === "object"
    ? JSON.stringify(value)
    : String(value ?? "");
  if (typeof value === "string" && value.includes(".EnumType.")) {
    displayedValue = value.split(".").at(-1);
  }
  return unit ? `${displayedValue} ${unit}` : displayedValue;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

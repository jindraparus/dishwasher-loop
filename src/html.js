export function renderPage({ events, authorized, monitorStatus, diagnostics, error }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="refresh" content="30">
    <title>Dishwasher Loop</title>
    <style>
      body { margin: 0 auto; max-width: 900px; padding: 2rem 1rem; color: #202124; font: 16px/1.5 system-ui, sans-serif; }
      header { align-items: center; display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between; }
      h1 { margin: 0; }
      .status { color: #5f6368; margin: .25rem 0 2rem; }
      .error { background: #fce8e6; border-radius: .4rem; color: #a50e0e; padding: .75rem; }
      .button { background: #1a73e8; border: 0; border-radius: .4rem; color: white; cursor: pointer; display: inline-block; padding: .6rem 1rem; text-decoration: none; }
      h2 { margin-top: 2rem; }
      .diagnostics { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      .diagnostic { border: 1px solid #dadce0; border-radius: .5rem; padding: 1rem; }
      .diagnostic h3 { margin: 0 0 .25rem; }
      .metadata { color: #5f6368; margin: 0 0 1rem; }
      dl { display: grid; gap: .4rem 1rem; grid-template-columns: minmax(120px, auto) 1fr; margin: 0; }
      dt { color: #5f6368; }
      dd { margin: 0; overflow-wrap: anywhere; }
      article { border: 1px solid #dadce0; border-radius: .5rem; margin: .75rem 0; padding: 1rem; }
      article header { justify-content: flex-start; }
      .type { background: #e8f0fe; border-radius: 1rem; color: #174ea6; font-size: .8rem; padding: .15rem .55rem; }
      time { color: #5f6368; font-size: .9rem; }
      pre { background: #f8f9fa; border-radius: .3rem; margin-bottom: 0; overflow: auto; padding: .75rem; white-space: pre-wrap; }
      .empty { color: #5f6368; padding: 3rem 0; text-align: center; }
    </style>
  </head>
  <body>
    <header>
      <h1>Dishwasher Loop</h1>
      ${authorized ? `<form method="post" action="/auth/disconnect"><button class="button" type="submit">Disconnect</button></form>` : `<a class="button" href="/auth/login">Connect Home Connect</a>`}
    </header>
    <p class="status">${escapeHtml(monitorStatus)}</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <main>
      ${diagnostics.length > 0 ? `
        <h2>Dishwasher diagnostics</h2>
        <section class="diagnostics">${diagnostics.map(renderDiagnostics).join("")}</section>
      ` : ""}
      <h2>Event history</h2>
      ${events.length === 0 ? `<p class="empty">No dishwasher events received yet.</p>` : events.map(renderEvent).join("")}
    </main>
  </body>
</html>`;
}

function renderDiagnostics(diagnostic) {
  const details = [
    ["Connection", diagnostic.connected === false ? "Offline" : "Online"],
    ...diagnostic.statusItems.map((item) => [formatKey(item.key), formatValue(item.value, item.unit)]),
  ];
  if (diagnostic.lastEventType) {
    details.push([
      "Last event",
      `${diagnostic.lastEventType} at ${formatDate(diagnostic.lastEventAt)}`,
    ]);
  }
  if (diagnostic.statusError) {
    details.push(["Status", `Unavailable: ${diagnostic.statusError}`]);
  }

  return `<section class="diagnostic">
    <h3>${escapeHtml(diagnostic.name)}</h3>
    <p class="metadata">${escapeHtml(
      [diagnostic.brand, diagnostic.type, diagnostic.model].filter(Boolean).join(" · "),
    )}</p>
    <dl>${details.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
  </section>`;
}

function renderEvent(event) {
  return `<article>
    <header>
      <strong>${escapeHtml(event.applianceName)}</strong>
      <span class="type">${escapeHtml(event.eventType)}</span>
      <time datetime="${escapeHtml(event.receivedAt)}">${escapeHtml(formatDate(event.receivedAt))}</time>
    </header>
    <pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
  </article>`;
}

function formatKey(key) {
  const shortKey = String(key || "Status").split(".").at(-1);
  return shortKey.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function formatValue(value, unit) {
  const displayedValue = value !== null && typeof value === "object"
    ? JSON.stringify(value)
    : String(value ?? "");
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { escapeHtml, formatCycleDate, formatDate, formatEventType } from "../public/lib/format.js";
import { renderCyclesCard } from "../public/components/cycles.js";
import { renderDashboard } from "../public/components/dashboard.js";

function local(year, month, day, hour = 12, minute = 34, second = 56) {
  return new Date(year, month - 1, day, hour, minute, second);
}

function relative(date, label, now) {
  assert.equal(formatCycleDate(date.toISOString(), now.valueOf()),
    `${label}, ${date.toLocaleTimeString("cs-CZ")}`);
}

test("Thursday labels, exact-now, future-today and older absolute fallbacks", () => {
  const now = local(2026, 10, 29, 18);
  relative(local(2026, 10, 29), "Dnes", now);
  relative(local(2026, 10, 28), "Včera", now);
  relative(local(2026, 10, 27), "úterý", now);
  relative(local(2026, 10, 26), "pondělí", now);
  relative(now, "Dnes", now);
  for (const date of [local(2026, 10, 23), local(2026, 10, 29, 19), local(2026, 10, 30)]) {
    assert.equal(formatCycleDate(date.toISOString(), now.valueOf()), formatDate(date.toISOString()));
  }
  assert.equal(formatCycleDate("not-a-date", now.valueOf()), "not-a-date");
});

test("yesterday precedes week boundary and calendar arithmetic crosses month/year", () => {
  relative(local(2026, 10, 25), "Včera", local(2026, 10, 26));
  const saturday = local(2026, 10, 24).toISOString();
  assert.equal(formatCycleDate(saturday, local(2026, 10, 26).valueOf()), formatDate(saturday));
  relative(local(2026, 2, 28), "Včera", local(2026, 3, 1));
  relative(local(2025, 12, 31), "Včera", local(2026, 1, 1));
});

test("independent cross-day boundaries and midnight rerender preserve fallback messages", () => {
  const start = local(2026, 10, 28, 23).toISOString();
  const end = local(2026, 10, 29, 0, 0, 0).toISOString();
  const cycles = [
    { startedAt: start, finishedAt: end, status: "finished", result: "finished" },
    { startedAt: start, finishedAt: null, status: "running" },
    { startedAt: null, finishedAt: null, status: "incomplete" },
    { startedAt: "<invalid>", finishedAt: "bad-date", status: "incomplete" },
  ];
  const html = renderCyclesCard(cycles, local(2026, 10, 29, 0, 1, 0).valueOf());
  assert.ok(html.includes(`Včera, ${new Date(start).toLocaleTimeString("cs-CZ")} → Dnes, ${new Date(end).toLocaleTimeString("cs-CZ")}`));
  assert.match(html, /Včera, .* → Právě probíhá/);
  assert.match(html, /Začátek nebyl zachycen → Konec nebyl zachycen/);
  assert.match(html, /&lt;invalid&gt; → bad-date/);
  const before = renderCyclesCard(cycles.slice(0, 1), local(2026, 10, 28, 23, 59, 59).valueOf());
  assert.match(before, /Dnes,/);
  assert.ok(before.includes(escapeHtml(formatDate(end))));
});

test("dashboard forwards one reference time while events and diagnostics remain absolute", () => {
  const at = local(2026, 10, 29).toISOString();
  const state = {
    authorized: true, capsuleCount: 12,
    diagnostics: [{ name: "Kitchen", statusItems: [], lastEventType: "STATUS", lastEventAt: at }],
    events: [{ applianceName: "Kitchen", eventType: "STATUS", receivedAt: at, data: {} }],
    cycles: [{ status: "finished", result: "finished", startedAt: at, finishedAt: at }],
  };
  const html = renderDashboard(state, { now: local(2026, 10, 29, 18).valueOf() });
  assert.match(html, /Dnes, .* → Dnes,/);
  const absolute = escapeHtml(formatDate(at));
  assert.ok(html.includes(`${formatEventType("STATUS")} · ${absolute}`));
  assert.ok(html.includes(`<time datetime="${at}">${absolute}</time>`));
  const next = renderDashboard(state, { now: local(2026, 10, 30, 0, 1, 0).valueOf() });
  assert.match(next, /Včera, .* → Včera,/);
});

test("local calendar dates survive spring/autumn DST in isolated timezones", () => {
  const module = new URL("../public/lib/format.js", import.meta.url).href;
  for (const [zone, transitions] of [
    ["Europe/Prague", [[3, 29], [10, 25]]],
    ["America/New_York", [[3, 8], [11, 1]]],
  ]) {
    const code = `
      import assert from "node:assert/strict";
      import { formatCycleDate, formatDate } from ${JSON.stringify(module)};
      assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, ${JSON.stringify(zone)});
      for (const [month, day] of ${JSON.stringify(transitions)}) {
        const now = new Date(2026, month - 1, day + 1, 0, 30);
        const previous = new Date(2026, month - 1, day, 0, 15, 12);
        assert.equal(formatCycleDate(previous.toISOString(), now.valueOf()),
          "Včera, " + previous.toLocaleTimeString("cs-CZ"));
        const saturday = new Date(2026, month - 1, day - 1, 12);
        assert.equal(formatCycleDate(saturday.toISOString(), now.valueOf()),
          formatDate(saturday.toISOString()));
      }
      const thursday = new Date(2026, 9, 29, 18);
      const tuesday = new Date(2026, 9, 27, 12, 34, 56);
      assert.equal(formatCycleDate(tuesday.toISOString(), thursday.valueOf()),
        "úterý, " + tuesday.toLocaleTimeString("cs-CZ"));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, TZ: zone }, encoding: "utf8",
    });
    assert.equal(result.status, 0, `${zone}: ${result.stderr || result.error}`);
  }
});

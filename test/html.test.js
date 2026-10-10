import assert from "node:assert/strict";
import test from "node:test";
import { buildRecommendations, renderPage } from "../src/html.js";

test("renders appliance metadata and current status diagnostics", () => {
  const html = renderPage({
    events: [],
    authorized: true,
    monitorStatus: "Monitoring 1 dishwasher",
    capsuleCount: 12,
    error: "",
    diagnostics: [{
      id: "dishwasher-1",
      name: "Kitchen dishwasher",
      brand: "Bosch",
      type: "Dishwasher",
      model: "SMV6",
      connected: true,
      statusItems: [{
        key: "BSH.Common.Status.OperationState",
        value: "BSH.Common.EnumType.OperationState.Ready",
      }],
      program: {
        activeKey: "Dishcare.Dishwasher.Program.Eco50",
        selectedKey: "Dishcare.Dishwasher.Program.Eco50",
        progress: 37,
        remainingSeconds: 6240,
        remainingUpdatedAt: new Date().toISOString(),
      },
      consumables: {
        salt: { state: "ok", label: "Enough" },
        rinseAid: { state: "low", label: "Refill soon" },
      },
      statusError: "",
      lastEventType: "STATUS",
      lastEventAt: "2026-10-09T20:00:00.000Z",
    }],
  });

  assert.match(html, /Current diagnostics/);
  assert.match(html, /Current program/);
  assert.match(html, /Washing in progress/);
  assert.match(html, /Eco 50/);
  assert.match(html, /1h 44m/);
  assert.match(html, /Estimated finish/);
  assert.match(html, /<strong>37%<\/strong>/);
  assert.match(html, /Supplies/);
  assert.match(html, /Recommendations/);
  assert.match(html, /Bosch · Dishwasher · SMV6/);
  assert.match(html, /Operation State/);
  assert.match(html, /<dd>Ready<\/dd>/);
  assert.match(html, /Dishwasher salt/);
  assert.match(html, /Washing capsules/);
  assert.match(html, /class="capsule-count ok">12</);
});

test("recommends restocking low supplies", () => {
  const recommendations = buildRecommendations({
    authorized: true,
    capsuleCount: 3,
    diagnostics: [{
      connected: true,
      statusItems: [],
      consumables: {
        salt: { state: "low", label: "Refill soon" },
        rinseAid: { state: "ok", label: "Enough" },
      },
    }],
  });

  assert.deepEqual(recommendations.map((item) => item.title), [
    "Refill dishwasher salt",
    "Restock washing capsules",
  ]);
});

test("does not treat stale remaining time as an active wash", () => {
  const html = renderPage({
    events: [],
    authorized: true,
    monitorStatus: "Monitoring 1 dishwasher",
    capsuleCount: 12,
    error: "",
    diagnostics: [{
      id: "dishwasher-1",
      name: "Kitchen dishwasher",
      connected: true,
      statusItems: [{
        key: "BSH.Common.Status.OperationState",
        value: "BSH.Common.EnumType.OperationState.Ready",
      }],
      program: {
        activeKey: "",
        selectedKey: "Dishcare.Dishwasher.Program.Eco50",
        progress: 42,
        remainingSeconds: 5760,
        remainingUpdatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      },
      consumables: {},
      statusError: "",
      lastEventType: "",
      lastEventAt: "",
    }],
  });

  assert.match(html, /No wash in progress/);
  assert.doesNotMatch(html, /Washing in progress/);
});

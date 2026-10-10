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
        value: "BSH.Common.EnumType.OperationState.Run",
      }],
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
  assert.match(html, /Supplies/);
  assert.match(html, /Recommendations/);
  assert.match(html, /Bosch · Dishwasher · SMV6/);
  assert.match(html, /Operation State/);
  assert.match(html, /<dd>Run<\/dd>/);
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

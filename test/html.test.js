import assert from "node:assert/strict";
import test from "node:test";
import { renderPage } from "../src/html.js";

test("renders appliance metadata and current status diagnostics", () => {
  const html = renderPage({
    events: [],
    authorized: true,
    monitorStatus: "Monitoring 1 dishwasher",
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
      statusError: "",
      lastEventType: "STATUS",
      lastEventAt: "2026-10-09T20:00:00.000Z",
    }],
  });

  assert.match(html, /Dishwasher diagnostics/);
  assert.match(html, /Bosch · Dishwasher · SMV6/);
  assert.match(html, /Operation State/);
  assert.match(html, /BSH\.Common\.EnumType\.OperationState\.Run/);
});

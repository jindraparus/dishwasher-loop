import assert from "node:assert/strict";
import test from "node:test";
import { renderDashboard } from "../public/components/dashboard.js";
import { buildRecommendations } from "../public/components/recommendations.js";

test("renders appliance metadata and current status diagnostics", () => {
  const html = renderDashboard({
    events: [],
    authorized: true,
    monitorStatus: "Sledována 1 myčka",
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
        salt: { state: "ok", label: "Dostatek" },
        rinseAid: { state: "low", label: "Brzy doplnit" },
      },
      statusError: "",
      lastEventType: "STATUS",
      lastEventAt: "2026-10-09T20:00:00.000Z",
    }],
    cycles: [{
      cycleId: "cycle-1",
      programKey: "Dishcare.Dishwasher.Program.Eco50",
      status: "finished",
      result: "finished",
      startedAt: "2026-10-09T18:00:00.000Z",
      finishedAt: "2026-10-09T21:00:00.000Z",
      durationSeconds: 10_800,
    }],
    cycleStats: {
      week: {
        completedCycleCount: 1,
        incompleteCycleCount: 0,
        averageDurationSeconds: 10_800,
        mostUsedProgram: "Dishcare.Dishwasher.Program.Eco50",
      },
      month: {
        completedCycleCount: 3,
        incompleteCycleCount: 1,
        averageDurationSeconds: 9_000,
        mostUsedProgram: "Dishcare.Dishwasher.Program.Eco50",
      },
    },
  });

  assert.match(html, /Aktuální diagnostika/);
  assert.match(html, /Aktuální program/);
  assert.match(html, /Probíhá mytí/);
  assert.match(html, /Eco 50/);
  assert.match(html, /1 h 44 min/);
  assert.match(html, /Odhad dokončení/);
  assert.match(html, /<strong>37%<\/strong>/);
  assert.match(html, /Zásoby/);
  assert.match(html, /Doporučení/);
  assert.match(html, /Bosch · Myčka nádobí · SMV6/);
  assert.match(html, /Provozní stav/);
  assert.match(html, /<dd>Připraveno<\/dd>/);
  assert.match(html, /Sůl do myčky/);
  assert.match(html, /Tablety do myčky/);
  assert.match(html, /class="capsule-count ok">12</);
  assert.match(html, /Statistiky mytí/);
  assert.match(html, /Tento měsíc/);
  assert.match(html, /Historie mytí/);
  assert.match(html, /Dokončeno/);
  assert.match(html, /3 h/);
  assert.match(html, /1 neúplný záznam není zahrnut/);
});

test("recommends restocking low supplies", () => {
  const recommendations = buildRecommendations({
    authorized: true,
    capsuleCount: 3,
    diagnostics: [{
      connected: true,
      statusItems: [],
      consumables: {
        salt: { state: "low", label: "Brzy doplnit" },
        rinseAid: { state: "ok", label: "Dostatek" },
      },
    }],
  });

  assert.deepEqual(recommendations.map((item) => item.title), [
    "Doplňte sůl do myčky",
    "Doplňte tablety do myčky",
  ]);
});

test("shows unavailable when local capsule inventory is missing", () => {
  const html = renderDashboard({
    events: [],
    authorized: true,
    monitorStatus: "Sledována 1 myčka",
    capsuleCount: null,
    diagnostics: [],
  });

  assert.match(html, /Tablety do myčky/);
  assert.match(html, /Není k dispozici/);
  assert.doesNotMatch(html, /data-capsule-form/);
});

test("does not treat stale remaining time as an active wash", () => {
  const html = renderDashboard({
    events: [],
    authorized: true,
    monitorStatus: "Sledována 1 myčka",
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

  assert.match(html, /Právě neprobíhá mytí/);
  assert.doesNotMatch(html, /Probíhá mytí/);
});

test("renders incomplete cycle boundaries without inventing timestamps", () => {
  const html = renderDashboard({
    events: [],
    authorized: true,
    monitorStatus: "Sledována 1 myčka",
    capsuleCount: 12,
    diagnostics: [],
    cycles: [{
      cycleId: "cycle-1",
      programKey: null,
      status: "finished",
      result: "finished",
      startedAt: null,
      finishedAt: "2026-10-09T21:00:00.000Z",
      durationSeconds: null,
    }],
  });

  assert.match(html, /Začátek nebyl zachycen/);
  assert.match(html, /Dokončeno, neúplná data/);
  assert.match(html, /Nelze spolehlivě určit/);
});

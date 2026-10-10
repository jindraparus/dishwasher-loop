import assert from "node:assert/strict";
import test from "node:test";
import { shouldPersistEvent } from "../src/monitor.js";

test("ignores keep-alives with the default event type filter", () => {
  assert.equal(shouldPersistEvent({
    event: "KEEP-ALIVE",
    data: "",
  }, {
    types: ["STATUS", "EVENT", "NOTIFY"],
    keys: [],
  }), false);
});

test("keeps a selected event type when no item-key filter is configured", () => {
  assert.equal(shouldPersistEvent({
    event: "NOTIFY",
    data: { items: [{ key: "BSH.Common.Option.ProgramProgress" }] },
  }, {
    types: ["NOTIFY"],
    keys: [],
  }), true);
});

test("keeps only messages containing a selected item key", () => {
  const filter = {
    types: ["EVENT", "NOTIFY"],
    keys: ["BSH.Common.Event.ProgramFinished"],
  };

  assert.equal(shouldPersistEvent({
    event: "EVENT",
    data: { items: [{ key: "BSH.Common.Event.ProgramFinished" }] },
  }, filter), true);
  assert.equal(shouldPersistEvent({
    event: "NOTIFY",
    data: { items: [{ key: "BSH.Common.Option.ProgramProgress" }] },
  }, filter), false);
});

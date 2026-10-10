import assert from "node:assert/strict";
import test from "node:test";
import { parseSseBlock } from "../src/sse.js";

test("parses a Home Connect JSON event", () => {
  const message = parseSseBlock([
    "event: NOTIFY",
    "id: dishwasher-1",
    'data: {"items":[{"key":"BSH.Common.Event.ProgramFinished","value":true}]}',
  ].join("\n"));

  assert.deepEqual(message, {
    event: "NOTIFY",
    id: "dishwasher-1",
    data: {
      items: [{
        key: "BSH.Common.Event.ProgramFinished",
        value: true,
      }],
    },
  });
});

test("joins multiline data and ignores SSE comments", () => {
  const message = parseSseBlock([
    ": keep-alive",
    "event: STATUS",
    "data: first",
    "data: second",
  ].join("\n"));

  assert.deepEqual(message, {
    event: "STATUS",
    id: "",
    data: "first\nsecond",
  });
});

test("ignores blocks without data", () => {
  assert.equal(parseSseBlock(": keep-alive"), null);
});

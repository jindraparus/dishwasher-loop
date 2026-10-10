import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPSULE_COUNT_STORAGE_KEY,
  parseCapsuleCount,
  readCapsuleCount,
} from "../public/lib/capsules.js";

test("reads a valid capsule amount from browser local storage", () => {
  const storage = {
    getItem(key) {
      assert.equal(key, CAPSULE_COUNT_STORAGE_KEY);
      return "24";
    },
  };

  assert.equal(readCapsuleCount(storage), 24);
});

test("treats missing or invalid capsule amounts as unavailable", () => {
  assert.equal(parseCapsuleCount(null), null);
  assert.equal(parseCapsuleCount(""), null);
  assert.equal(parseCapsuleCount("-1"), null);
  assert.equal(parseCapsuleCount("1000"), null);
  assert.equal(parseCapsuleCount("12.5"), null);
});

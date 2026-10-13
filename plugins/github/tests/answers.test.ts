import assert from "node:assert/strict";
import { test } from "node:test";
import { answersOf, fit } from "../answers.ts";

test("answers keep text and yes/no, and drop the rest", () => {
  assert.deepEqual(answersOf({ a: "x", b: true, c: 3, d: null, e: ["y"] }), { a: "x", b: true });
  assert.deepEqual(answersOf(null), {});
  assert.deepEqual(answersOf(["x"]), {});
});

test("text is cut to fit with an ellipsis", () => {
  assert.equal(fit("short", 10), "short");
  assert.equal(fit("a".repeat(20), 10), `${"a".repeat(9)}…`);
});

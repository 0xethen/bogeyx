import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { bordaShare, isComplete, move, parseCriteria, pointsLeft } from "../sheet.ts";

test("criteria are one per non-empty line, trimmed", () => {
  assert.deepEqual(parseCriteria("Fun\n  Theme  \n\nPolish"), ["Fun", "Theme", "Polish"]);
});

test("criteria default to Overall and stop at eight", () => {
  assert.deepEqual(parseCriteria(undefined), ["Overall"]);
  assert.deepEqual(parseCriteria("\n  \n"), ["Overall"]);
  assert.equal(parseCriteria("1\n2\n3\n4\n5\n6\n7\n8\n9").length, 8);
});

test("a rating is complete when every criterion has a mark in range", () => {
  const criteria = ["Fun", "Theme"];
  assert.equal(isComplete({ Fun: 3, Theme: 5 }, criteria, 5), true);
  assert.equal(isComplete({ Fun: 3 }, criteria, 5), false);
  assert.equal(isComplete({ Fun: 3, Theme: 6 }, criteria, 5), false);
  assert.equal(isComplete({ Fun: 3, Theme: 2.5 }, criteria, 5), false);
});

test("moving an entry swaps it with its neighbor and stops at the ends", () => {
  assert.deepEqual(move(["a", "b", "c"], 1, -1), ["b", "a", "c"]);
  assert.deepEqual(move(["a", "b", "c"], 1, 1), ["a", "c", "b"]);
  assert.deepEqual(move(["a", "b", "c"], 0, -1), ["a", "b", "c"]);
  assert.deepEqual(move(["a", "b", "c"], 2, 5), ["a", "b", "c"]);
});

test("Borda shares run from 1 for first to 0 for last", () => {
  assert.equal(bordaShare(1, 3), 1);
  assert.equal(bordaShare(2, 3), 0.5);
  assert.equal(bordaShare(3, 3), 0);
  assert.equal(bordaShare(1, 1), null);
});

test("points left count every other allocation and this one", () => {
  const rows = [
    { submission_id: "a", points: 6 },
    { submission_id: "b", points: null },
    { submission_id: "c", points: 2 },
  ];
  assert.equal(pointsLeft(10, rows, "c", 3), 1);
  assert.equal(pointsLeft(10, rows, "b", 5), -3);
});

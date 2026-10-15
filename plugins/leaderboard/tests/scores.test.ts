import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { fileProblem, formatScore, lowerIsBetter } from "../scores.ts";

test("error metrics are lower-is-better, the others higher", () => {
  for (const metric of ["rmse", "mae", "log_loss"]) assert.equal(lowerIsBetter(metric), true);
  for (const metric of ["accuracy", "macro_f1"]) assert.equal(lowerIsBetter(metric), false);
});

test("scores show four decimals", () => {
  assert.equal(formatScore(0.5), "0.5000");
  assert.equal(formatScore(1 / 3), "0.3333");
});

test("only non-empty CSV files under 5 MB are sent", () => {
  assert.equal(fileProblem({ name: "p.CSV", size: 10 }), null);
  assert.match(fileProblem({ name: "p.txt", size: 10 }) ?? "", /csv/);
  assert.match(fileProblem({ name: "p.csv", size: 0 }) ?? "", /empty/);
  assert.match(fileProblem({ name: "p.csv", size: 6_000_000 }) ?? "", /5 MB/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCatalog, untranslated } from "../check.ts";

const source = {
  "a.hi": "Hi {name}",
  "a.n": "{n, plural, one {# thing} other {# things}}",
  "a.plain": "Plain",
};

test("a faithful translation has no problems, and gaps are only listed", () => {
  const es = { "a.hi": "Hola {name}", "a.n": "{n, plural, one {# cosa} other {# cosas}}" };
  assert.deepEqual(checkCatalog(source, es), []);
  assert.deepEqual(untranslated(source, es), ["a.plain"]);
});

test("unknown keys and changed slots are caught", () => {
  const problems = checkCatalog(source, {
    "a.nope": "x",
    "a.hi": "Hola {nombre}",
    "a.plain": "Llano {extra}",
  });
  assert.deepEqual(problems, [
    { key: "a.nope", problem: "English has no message with this key" },
    { key: "a.hi", problem: "uses {nombre} where English uses {name}" },
    { key: "a.plain", problem: "uses {extra} where English uses {}" },
  ]);
});

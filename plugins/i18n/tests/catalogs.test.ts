import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "@bogey/config/messages";
import { checkCatalog, untranslated } from "../check.ts";
import es from "../es.json" with { type: "json" };

test("the Spanish catalog only translates messages English has, with the same slots", () => {
  assert.deepEqual(checkCatalog(en, es), []);
});

test("Spanish covers every message, so nothing falls back to English", () => {
  assert.deepEqual(untranslated(en, es), []);
});

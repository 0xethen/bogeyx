import assert from "node:assert/strict";
import { describe, test } from "vite-plus/test";
import { en } from "@bogey/config/messages";
import { checkCatalog, untranslated } from "../check.ts";
import es from "../es.json" with { type: "json" };

// The catalogs trail Bogey's English while they're in progress, so these run only in CI's
// non-blocking i18n job (or locally with I18N_CATALOGS=1), not in `vp test`.
describe.runIf(process.env.I18N_CATALOGS === "1")("catalogs", () => {
  test("the Spanish catalog only translates messages English has, with the same slots", () => {
    assert.deepEqual(checkCatalog(en, es), []);
  });

  test("Spanish covers every message, so nothing falls back to English", () => {
    assert.deepEqual(untranslated(en, es), []);
  });
});

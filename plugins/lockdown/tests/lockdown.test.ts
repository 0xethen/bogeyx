import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  COMPANION_SOURCE,
  COUNTED,
  SIGNAL_KINDS,
  hello,
  newNonce,
  parseCompanionMessage,
} from "../companion.ts";
import { requestedUrl } from "../seb.ts";

test("a nonce is 32 hex characters and not repeated", () => {
  const one = newNonce();
  assert.match(one, /^[0-9a-f]{32}$/);
  assert.notEqual(one, newNonce());
});

test("the page says hello with its nonce", () => {
  assert.deepEqual(hello("abc"), { source: "bogey-lockdown", type: "hello", nonce: "abc" });
});

test("only the extension's messages for this nonce are read", () => {
  const attest = { source: COMPANION_SOURCE, type: "attest", nonce: "n1", version: "1.0.0" };
  assert.deepEqual(parseCompanionMessage(attest, "n1"), attest);
  assert.equal(parseCompanionMessage(attest, "n2"), null);
  assert.equal(parseCompanionMessage({ ...attest, source: "someone" }, "n1"), null);
  assert.equal(parseCompanionMessage({ ...attest, type: "other" }, "n1"), null);
  assert.equal(parseCompanionMessage("attest", "n1"), null);
  assert.equal(parseCompanionMessage(null, "n1"), null);
});

test("a signal must be one of the known kinds", () => {
  const signal = { source: COMPANION_SOURCE, type: "signal", nonce: "n", kind: "devtools" };
  assert.ok(parseCompanionMessage(signal, "n"));
  assert.equal(parseCompanionMessage({ ...signal, kind: "tab; drop table" }, "n"), null);
  for (const kind of SIGNAL_KINDS) assert.match(kind, /^[a-z][a-z_]{1,30}$/);
});

test("clipboard is recorded but doesn't count towards the limit", () => {
  assert.equal(COUNTED.has("clipboard"), false);
  assert.equal(COUNTED.has("window_blur"), true);
  assert.equal(COUNTED.has("devtools"), true);
});

test("the requested address is the outside one behind a proxy", () => {
  const inside = new Request("http://web:3000/api/x/lockdown/seb-check?event=e1", {
    method: "POST",
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "hacks.example.org" },
  });
  assert.equal(requestedUrl(inside), "https://hacks.example.org/api/x/lockdown/seb-check?event=e1");
  const direct = new Request("http://localhost:3000/api/x/lockdown/seb-check?event=e1", {
    method: "POST",
  });
  assert.equal(requestedUrl(direct), "http://localhost:3000/api/x/lockdown/seb-check?event=e1");
});

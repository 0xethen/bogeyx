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
import {
  donePath,
  readSebConfig,
  sebConfigKey,
  sebJson,
  sebLink,
  sebPlist,
  sebSettings,
  sha256Hex,
} from "../seb-config.ts";

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

const target = {
  startUrl: "https://bogey.test/events/cup",
  quitUrl: "https://bogey.test/events/cup/x/lockdown/done",
  hosts: ["bogey.test", "db.bogey.test"],
};

test("the file always quits on Bogey's quit link, without asking by default", () => {
  const settings = sebSettings(readSebConfig({}), target);
  assert.equal(settings.quitURL, target.quitUrl);
  assert.equal(settings.quitURLConfirm, false);
  assert.equal(donePath("cup"), "/events/cup/x/lockdown/done");
});

test("allowed apps are only written while switching to them is allowed", () => {
  const calculator = {
    os: "mac",
    title: "Calculator",
    executable: "Calculator",
    identifier: "com.apple.calculator",
  };
  const off = sebSettings(readSebConfig({ permittedApps: [calculator] }), target);
  assert.equal("permittedProcesses" in off, false);
  const on = sebSettings(
    readSebConfig({ allowSwitching: true, permittedApps: [calculator] }),
    target,
  );
  assert.ok(Array.isArray(on.permittedProcesses));
});

test("SEB-JSON sorts keys as SEB does, drops empty dictionaries and the originator", () => {
  assert.equal(
    sebJson({
      originatorVersion: "Bogey",
      b: 1,
      allowWLAN: true,
      allowWlan: false,
      empty: {},
      a: [],
    }),
    '{"a":[],"allowWlan":false,"allowWLAN":true,"b":1}',
  );
});

test("SEB-JSON leaves backslashes as they are and escapes quotes", () => {
  assert.equal(sebJson({ path: 'C:\\Apps\\"x"' }), '{"path":"C:\\Apps\\\\"x\\""}');
});

test("the Config Key is the SHA-256 of the SEB-JSON", async () => {
  const settings = sebSettings(readSebConfig({}), target);
  assert.equal(await sebConfigKey(settings), await sha256Hex(sebJson(settings)));
  assert.match(await sebConfigKey(settings), /^[0-9a-f]{64}$/);
});

test("the file opens the event and asks SEB to send its key", () => {
  const plist = sebPlist(sebSettings(readSebConfig({}), target));
  assert.match(
    plist,
    /<key>startURL<\/key>\n {2}<string>https:\/\/bogey.test\/events\/cup<\/string>/,
  );
  assert.match(plist, /<key>sendBrowserExamKey<\/key>\n {2}<true \/>/);
});

test("empty lists are left out, so SEB keeps its own", () => {
  const settings = sebSettings(readSebConfig({}), target);
  assert.equal("prohibitedProcesses" in settings, false);
  assert.equal("URLFilterRules" in settings, false);
});

test("filtering sites always allows the event's own hosts", () => {
  const settings = sebSettings(
    readSebConfig({
      filterUrls: true,
      rules: [{ action: "allow", expression: "docs.python.org", regex: false }],
    }),
    target,
  );
  const rules = settings.URLFilterRules;
  assert.ok(Array.isArray(rules));
  assert.deepEqual(
    rules.map((rule) =>
      typeof rule === "object" && !Array.isArray(rule) ? rule.expression : null,
    ),
    ["bogey.test", "db.bogey.test", "docs.python.org"],
  );
});

test("an unreadable stored configuration starts over", () => {
  assert.equal(readSebConfig({ allowQuit: "yes" }).allowQuit, true);
  assert.equal(readSebConfig(null).maxDisplays, 1);
});

test("a link to the file opens SEB", () => {
  assert.equal(
    sebLink("https://bogey.test/api/x/lockdown/seb-config/ab"),
    "sebs://bogey.test/api/x/lockdown/seb-config/ab",
  );
  assert.equal(sebLink("http://localhost:3000/f"), "seb://localhost:3000/f");
});

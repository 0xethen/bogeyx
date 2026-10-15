import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vite-plus/test";
import { listPlugins, parseTag, readListing } from "../manifests.ts";

let root: string;

function plugin(folder: string, body: string) {
  mkdirSync(join(root, "plugins", folder), { recursive: true });
  writeFileSync(join(root, "plugins", folder, "manifest.ts"), `export default {\n${body}};\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bogeyx-"));
  mkdirSync(join(root, "plugins"));
});

test("a manifest's top-level fields become its listing", () => {
  plugin(
    "hello",
    '  key: "hello",\n  name: "Hello",\n  version: "1.2.0",\n  api: 2,\n  description: "Says \\"hi\\"",\n  author: { name: "Ada" },\n  license: "MIT",\n',
  );
  expect(readListing(root, "hello")).toEqual({
    key: "hello",
    name: "Hello",
    version: "1.2.0",
    description: 'Says \\"hi\\"',
    api: 2,
    tag: "hello-v1.2.0",
    directory: "plugins/hello",
    author: "Ada",
    license: "MIT",
  });
});

test("the key must match the folder, and a version is required", () => {
  plugin("hello", '  key: "other",\n  version: "1.0.0",\n');
  expect(() => readListing(root, "hello")).toThrow(/folder must match/);
  plugin("bare", '  key: "bare",\n');
  expect(() => readListing(root, "bare")).toThrow(/needs a key and a version/);
});

test("dot-folders and folders without a manifest are skipped", () => {
  plugin("b", '  key: "b",\n  version: "1.0.0",\n');
  plugin("a", '  key: "a",\n  version: "1.0.0",\n');
  plugin(".parked", '  key: ".parked",\n  version: "1.0.0",\n');
  mkdirSync(join(root, "plugins", "empty"));
  expect(listPlugins(root).map((listing) => listing.key)).toEqual(["a", "b"]);
});

test("tags are <plugin>-v<version>, and plugin keys can have dashes", () => {
  expect(parseTag("extra-judging-v1.0.0")).toEqual({ plugin: "extra-judging", version: "1.0.0" });
  expect(parseTag("lockdown-v2.0.0-beta.1")).toEqual({
    plugin: "lockdown",
    version: "2.0.0-beta.1",
  });
  expect(parseTag("lockdown-1.0.0")).toBeNull();
  expect(parseTag("v1.0.0")).toBeNull();
});

// Builds index.json by scanning manifests as text, never importing plugin code.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const field = (source, name) =>
  source.match(new RegExp(`^  ${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"))?.[1];

const plugins = [];
const folder = join(root, "plugins");
for (const entry of readdirSync(folder).sort()) {
  const manifest = join(folder, entry, "manifest.ts");
  if (entry.startsWith(".") || !statSync(join(folder, entry)).isDirectory()) continue;
  if (!existsSync(manifest)) continue;
  const source = readFileSync(manifest, "utf8");
  const key = field(source, "key");
  const version = field(source, "version");
  const author = source.match(/author:\s*\{[^}]*?name:\s*"([^"]*)"/s)?.[1];
  const license = field(source, "license");
  if (!key || !version) throw new Error(`${entry}/manifest.ts needs a key and a version`);
  if (key !== entry)
    throw new Error(`${entry}/manifest.ts has key "${key}"; the folder must match`);
  plugins.push({
    key,
    name: field(source, "name") ?? key,
    version,
    description: field(source, "description") ?? "",
    api: Number(source.match(/^  api:\s*(\d+)/m)?.[1] ?? 0) || null,
    tag: `${key}-v${version}`,
    directory: `plugins/${key}`,
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
  });
}

if (process.argv.includes("--check")) {
  const current = existsSync(join(root, "index.json"))
    ? readFileSync(join(root, "index.json"), "utf8")
    : "";
  const next = `${JSON.stringify({ schema: 1, name: "Bogey first-party plugins", repository: "github:0xethen/bogeyx", plugins }, null, 2)}\n`;
  if (current !== next) {
    console.error("index.json is out of date; run node build-index.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(join(root, "index.json"), `${JSON.stringify({ schema: 1, name: "Bogey first-party plugins", repository: "github:0xethen/bogeyx", plugins }, null, 2)}\n`);
}

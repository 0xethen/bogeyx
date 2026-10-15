// Writes the extension for your instance into dist/: node build.mjs --host hacks.example.org [--host ...]
// Load dist/ as an unpacked extension, or pack it from chrome://extensions. Nothing is published.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hosts = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--host" && args[i + 1]) hosts.push(args[++i]);
}
if (hosts.length === 0) {
  console.error("Give at least one --host, the address people open Bogey at (hacks.example.org).");
  process.exit(1);
}
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i;
const bad = hosts.find((host) => !HOST.test(host));
if (bad) {
  console.error(`"${bad}" isn't a host name. Leave out https:// and any path.`);
  process.exit(1);
}

const template = JSON.parse(await readFile(join(here, "manifest.template.json"), "utf8"));
const matches = hosts.flatMap((host) => [`https://${host}/*`]);
// a trial on localhost is plain http
for (const host of hosts)
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) matches.push(`http://${host}/*`);
template.content_scripts[0].matches = matches;

const out = join(here, "dist");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(join(out, "manifest.json"), `${JSON.stringify(template, null, 2)}\n`);
await cp(join(here, "content.js"), join(out, "content.js"));
await cp(join(here, "background.js"), join(out, "background.js"));
console.log(`Wrote ${out} for ${matches.join(", ")}`);

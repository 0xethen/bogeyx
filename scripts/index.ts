// Writes index.json, the library listing `bogey plugins search` reads. --check fails if it's stale.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listPlugins, renderIndex } from "./manifests.ts";

const root = join(import.meta.dirname, "..");
const path = join(root, "index.json");
const next = renderIndex(listPlugins(root));

if (process.argv.includes("--check")) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current !== next) {
    console.error("index.json is out of date; run vp run index");
    process.exit(1);
  }
} else {
  writeFileSync(path, next);
}

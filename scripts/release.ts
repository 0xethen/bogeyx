// node scripts/release.ts <plugin>-v<version>: checks the tag against the manifest and writes
// dist/<plugin>-<version>.tar.gz, printing its path. --check only checks.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseTag, readListing } from "./manifests.ts";

const root = join(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const tag = process.argv.slice(2).find((arg) => !arg.startsWith("--"));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const parsed = tag ? parseTag(tag) : null;
if (!parsed) fail(`Give a tag like lockdown-v1.0.0${tag ? `, not "${tag}"` : ""}.`);
const { plugin, version } = parsed;
if (!existsSync(join(root, "plugins", plugin, "manifest.ts"))) fail(`No plugin named ${plugin}.`);
const listing = readListing(root, plugin);
if (listing.version !== version) {
  fail(`plugins/${plugin}/manifest.ts says version ${listing.version}, not ${version}.`);
}

if (!check) {
  const archive = join("dist", `${plugin}-${version}.tar.gz`);
  mkdirSync(join(root, "dist"), { recursive: true });
  execFileSync(
    "tar",
    ["-czf", archive, "--exclude=dist", "--exclude=.DS_Store", "-C", "plugins", plugin],
    { cwd: root, stdio: "inherit" },
  );
  console.log(archive);
}

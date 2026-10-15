// Reads plugin manifests as text, never importing plugin code.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const REPOSITORY = "github:0xethen/bogeyx";

export interface Listing {
  key: string;
  name: string;
  version: string;
  description: string;
  api: number | null;
  tag: string;
  directory: string;
  author?: string;
  license?: string;
}

export const field = (source: string, name: string) =>
  source.match(new RegExp(`^  ${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"))?.[1];

export function readListing(root: string, entry: string): Listing {
  const source = readFileSync(join(root, "plugins", entry, "manifest.ts"), "utf8");
  const key = field(source, "key");
  const version = field(source, "version");
  const author = source.match(/author:\s*\{[^}]*?name:\s*"([^"]*)"/s)?.[1];
  const license = field(source, "license");
  if (!key || !version) throw new Error(`${entry}/manifest.ts needs a key and a version`);
  if (key !== entry)
    throw new Error(`${entry}/manifest.ts has key "${key}"; the folder must match`);
  return {
    key,
    name: field(source, "name") ?? key,
    version,
    description: field(source, "description") ?? "",
    api: Number(source.match(/^  api:\s*(\d+)/m)?.[1] ?? 0) || null,
    tag: `${key}-v${version}`,
    directory: `plugins/${key}`,
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
  };
}

// folders starting with a dot (like .parked/) are skipped, as Bogey does
export function listPlugins(root: string): Listing[] {
  const folder = join(root, "plugins");
  return readdirSync(folder)
    .sort()
    .filter(
      (entry) =>
        !entry.startsWith(".") &&
        statSync(join(folder, entry)).isDirectory() &&
        existsSync(join(folder, entry, "manifest.ts")),
    )
    .map((entry) => readListing(root, entry));
}

export const renderIndex = (plugins: Listing[]) =>
  `${JSON.stringify({ schema: 1, name: "Bogey first-party plugins", repository: REPOSITORY, plugins }, null, 2)}\n`;

export function parseTag(tag: string): { plugin: string; version: string } | null {
  const match = tag.match(/^(.+)-v(\d+\.\d+\.\d+(?:[-+].*)?)$/);
  return match ? { plugin: match[1]!, version: match[2]! } : null;
}

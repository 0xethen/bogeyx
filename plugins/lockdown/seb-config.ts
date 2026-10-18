import { z } from "zod";
import { pluginPageUrl } from "@bogey/plugins/api";
import { manifest } from "./manifest.ts";

// The Safe Exam Browser configuration organizers build on Manage → Lockdown Browser. Bogey writes it
// as a `.seb` file (an unencrypted plist) and serves it at a link that opens SEB, and works out the
// file's Config Key the way SEB does, so a request carrying that key's hash counts as coming from SEB.
// Anyone who can download the file can work the key out too: it keeps people honest, not out.

/** A plist value, as far as a `.seb` file uses one. Numbers are integers. */
// ReadonlyArray rather than Tuple: a type alias can only refer to itself through an interface
export type PlistValue = string | number | boolean | ReadonlyArray<PlistValue> | PlistDict;
export type PlistDict = { readonly [key: string]: PlistValue };

const OS = { mac: 0, windows: 1 } as const;
const NEW_WINDOWS = { block: 0, same: 1, new: 2 } as const;

// SEB keys are compared byte for byte in the hash, and other clients may read text differently, so
// what organizers type stays printable ASCII.
const ascii = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .regex(/^[\x20-\x7e]*$/, "Use plain letters, digits and punctuation");

export const sebRuleSchema = z.object({
  action: z.enum(["allow", "block"]),
  expression: ascii(300).min(1, "Give an address"),
  regex: z.boolean(),
});
export type SebRule = z.infer<typeof sebRuleSchema>;

export const sebAppSchema = z.object({
  os: z.enum(["mac", "windows"]),
  title: ascii(80),
  executable: ascii(120).min(1, "Give the program's file name"),
  // a macOS bundle ID (com.apple.calculator); Windows apps leave it empty
  identifier: ascii(120),
});
export type SebApp = z.infer<typeof sebAppSchema>;

export const sebConfigSchema = z.object({
  // Exam
  allowQuit: z.boolean().default(true),
  quitPasswordHash: z
    .string()
    .regex(/^([0-9a-f]{64})?$/)
    .default(""),
  confirmQuit: z.boolean().default(false),
  // Browser
  showToolbar: z.boolean().default(false),
  allowReload: z.boolean().default(true),
  showTaskbar: z.boolean().default(true),
  showTime: z.boolean().default(true),
  allowZoom: z.boolean().default(true),
  allowSpellCheck: z.boolean().default(false),
  allowDictionary: z.boolean().default(false),
  newWindows: z.enum(["block", "same", "new"]).default("new"),
  allowDownloads: z.boolean().default(false),
  allowCamera: z.boolean().default(false),
  allowMicrophone: z.boolean().default(false),
  muteAudio: z.boolean().default(false),
  // Sites
  filterUrls: z.boolean().default(false),
  filterEmbedded: z.boolean().default(false),
  rules: z.array(sebRuleSchema).max(100).default([]),
  // Apps
  allowSwitching: z.boolean().default(false),
  permittedApps: z.array(sebAppSchema).max(50).default([]),
  prohibitedApps: z.array(sebAppSchema).max(100).default([]),
  // Security
  allowVirtualMachine: z.boolean().default(false),
  allowScreenSharing: z.boolean().default(false),
  allowScreenCapture: z.boolean().default(false),
  privateClipboard: z.boolean().default(true),
  allowRightClick: z.boolean().default(false),
  allowSiri: z.boolean().default(false),
  allowDictation: z.boolean().default(false),
  allowMirroring: z.boolean().default(false),
  maxDisplays: z.number().int().min(1).max(4).default(1),
});
export type SebConfig = z.infer<typeof sebConfigSchema>;

/** A stored configuration, with defaults for anything missing; anything unreadable starts over. */
export function readSebConfig(stored: unknown): SebConfig {
  const parsed = sebConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : sebConfigSchema.parse({});
}

/** Where SEB opens, and the hosts the event needs when only listed sites are allowed. */
/** Where the event page goes once problems close: SEB quits on it, other browsers go on to the scoreboard. */
export const donePath = (slug: string) => pluginPageUrl(manifest, "event", "/done", slug);

export interface SebTarget {
  startUrl: string;
  /** Opening it quits SEB: the page goes there once problems close, and a problem can link to it. */
  quitUrl: string;
  /** Hosts the page talks to (Bogey's own, the Supabase API), allowed whatever the filter says. */
  hosts: Tuple<string>;
}

const filterRule = (rule: SebRule): PlistDict => ({
  action: rule.action === "allow" ? 1 : 0,
  active: true,
  expression: rule.expression,
  regex: rule.regex,
});

const permittedApp = (app: SebApp): PlistDict => ({
  active: true,
  autostart: false,
  iconInTaskbar: true,
  runInBackground: false,
  allowUserToChooseApp: false,
  strongKill: false,
  os: OS[app.os],
  title: app.title || app.executable,
  description: "",
  executable: app.executable,
  originalName: app.executable,
  path: "",
  identifier: app.identifier,
  windowHandlingProcess: "",
  arguments: [],
});

const prohibitedApp = (app: SebApp): PlistDict => ({
  active: true,
  currentUser: true,
  strongKill: false,
  os: OS[app.os],
  executable: app.executable,
  originalName: app.executable,
  description: app.title,
  identifier: app.identifier,
  windowHandlingProcess: "",
  user: "",
});

/** The settings SEB reads, keyed as its own configuration tool writes them. */
export function sebSettings(config: SebConfig, target: SebTarget): PlistDict {
  // an expression without a scheme or path matches any, so a host lets its websockets through too
  const ownRules: SebRule[] = [...new Set(target.hosts)].map((host) => ({
    action: "allow",
    expression: host,
    regex: false,
  }));
  // A key the file leaves out keeps SEB's own default, and its lists aren't empty by default: an
  // empty list here would throw away the apps SEB closes on its own.
  const lists: PlistDict = {
    ...(config.filterUrls
      ? { URLFilterRules: [...ownRules, ...config.rules].map(filterRule) }
      : {}),
    // without switching there's no way to reach them
    ...(config.allowSwitching && config.permittedApps.length > 0
      ? { permittedProcesses: config.permittedApps.map(permittedApp) }
      : {}),
    ...(config.prohibitedApps.length > 0
      ? { prohibitedProcesses: config.prohibitedApps.map(prohibitedApp) }
      : {}),
  };
  return {
    originatorVersion: "Bogey",
    // 0: this file starts an exam, and leaves the computer's own SEB settings alone
    sebConfigPurpose: 0,
    startURL: target.startUrl,
    sendBrowserExamKey: true,
    // "Prefer modern": the web view that sends the key headers on every request
    browserWindowWebView: 3,
    allowPreferencesWindow: false,
    examSessionClearCookiesOnStart: false,

    allowQuit: config.allowQuit,
    ...(config.quitPasswordHash ? { hashedQuitPassword: config.quitPasswordHash } : {}),
    quitURL: target.quitUrl,
    quitURLConfirm: config.confirmQuit,

    enableBrowserWindowToolbar: config.showToolbar,
    browserWindowAllowReload: config.allowReload,
    showReloadButton: config.allowReload,
    showTaskBar: config.showTaskbar,
    showTime: config.showTime,
    enableZoomPage: config.allowZoom,
    enableZoomText: config.allowZoom,
    allowSpellCheck: config.allowSpellCheck,
    allowDictionaryLookup: config.allowDictionary,
    newBrowserWindowByLinkPolicy: NEW_WINDOWS[config.newWindows],
    newBrowserWindowByScriptPolicy: NEW_WINDOWS[config.newWindows],
    allowDownUploads: config.allowDownloads,
    browserMediaCaptureCamera: config.allowCamera,
    browserMediaCaptureMicrophone: config.allowMicrophone,
    audioMute: config.muteAudio,

    URLFilterEnable: config.filterUrls,
    URLFilterEnableContentFilter: config.filterUrls && config.filterEmbedded,
    allowSwitchToApplications: config.allowSwitching,

    allowVirtualMachine: config.allowVirtualMachine,
    allowScreenSharing: config.allowScreenSharing,
    enablePrintScreen: config.allowScreenCapture,
    enablePrivateClipboard: config.privateClipboard,
    enableRightMouse: config.allowRightClick,
    allowSiri: config.allowSiri,
    allowDictation: config.allowDictation,
    allowDisplayMirroring: config.allowMirroring,
    allowedDisplaysMaxNumber: config.maxDisplays,
    ...lists,
  };
}

// ── the file ────────────────────────────────────────────────────────────────

const xmlText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const isDict = (value: PlistValue): value is PlistDict =>
  typeof value === "object" && !Array.isArray(value);

function plistValue(value: PlistValue, indent: string): string {
  if (typeof value === "boolean") return `${indent}<${value} />`;
  if (typeof value === "number") return `${indent}<integer>${Math.trunc(value)}</integer>`;
  if (typeof value === "string") return `${indent}<string>${xmlText(value)}</string>`;
  if (isDict(value)) {
    const entries = Object.entries(value).map(
      ([key, entry]) =>
        `${indent}  <key>${xmlText(key)}</key>\n${plistValue(entry, `${indent}  `)}`,
    );
    return entries.length === 0
      ? `${indent}<dict />`
      : `${indent}<dict>\n${entries.join("\n")}\n${indent}</dict>`;
  }
  return value.length === 0
    ? `${indent}<array />`
    : `${indent}<array>\n${value.map((each) => plistValue(each, `${indent}  `)).join("\n")}\n${indent}</array>`;
}

/** The `.seb` file: an unencrypted XML plist, which SEB opens as it is. */
export function sebPlist(settings: PlistDict): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(settings, ""),
    "</plist>",
    "",
  ].join("\n");
}

// ── the Config Key ──────────────────────────────────────────────────────────

// SEB sorts keys the Unicode Collation Algorithm's way: case aside, then lower case first.
const collator = new Intl.Collator("und");

// SEB-JSON escapes what JSON must, except backslashes, which it leaves as they are.
const jsonString = (text: string) =>
  JSON.stringify(text.replaceAll("\\", "\u0000")).replaceAll("\\u0000", "\\");

function sebJsonValue(value: PlistValue): string | null {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(Math.trunc(value));
  if (typeof value === "string") return jsonString(value);
  if (isDict(value)) {
    const entries = Object.keys(value)
      .sort(collator.compare)
      .flatMap((key) => {
        const entry = value[key];
        const json = entry === undefined ? null : sebJsonValue(entry);
        return json === null ? [] : [`${jsonString(key)}:${json}`];
      });
    // empty dictionaries are left out, as SEB leaves them
    return entries.length === 0 ? null : `{${entries.join(",")}}`;
  }
  return `[${value.flatMap((each) => sebJsonValue(each) ?? []).join(",")}]`;
}

/**
 * The settings as SEB-JSON: no whitespace, keys sorted, empty dictionaries dropped and
 * `originatorVersion` left out (https://safeexambrowser.org/developer/seb-config-key.html).
 */
export function sebJson(settings: PlistDict): string {
  const { originatorVersion: _, ...rest } = settings;
  return sebJsonValue(rest) ?? "{}";
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The Config Key SEB works out from these settings, as 64 lower-case hex characters. */
export const sebConfigKey = (settings: PlistDict): Promise<string> => sha256Hex(sebJson(settings));

/** The link that opens SEB with a configuration: `sebs://` for https, `seb://` for http. */
export function sebLink(fileUrl: string): string {
  return fileUrl.replace(/^http(s?):\/\//, (_, secure: string) => `seb${secure}://`);
}

import { definePlugin } from "@bogey/plugins/api";

export const manifest = definePlugin({
  key: "lockdown",
  name: "Lockdown",
  api: 1,
  version: "1.3.0",
  description: "Asks for full screen and records tab switches while its window is open.",
  author: { name: "Ethen Tseggai", url: "https://github.com/0xethen" },
  license: "MIT",
  source: { repository: "github:0xethen/bogeyx", directory: "plugins/lockdown" },
  windows: [{ key: "armed", label: "Lockdown" }],
  permissions: ["review"],
  roles: [{ key: "proctor", label: "Proctor", grants: ["review"] }],
  // the database writes these as `lockdown.<kind>`
  actions: [
    "tab_switch",
    "fullscreen_exit",
    "fullscreen_entered",
    "inspect_menu",
    "window_blur",
    "devtools",
    "new_window",
    "clipboard",
    "seb_keys_saved",
    "seb_config_saved",
    "unlocked",
  ],
  // Safe Exam Browser's request headers only reach the server, which hands them to the database;
  // SEB downloads its configuration before anyone signs in
  serverRoutes: [
    { path: "/seb-check", method: "POST" },
    { path: "/seb-config/:token", method: "GET" },
  ],
  // which browser participants use, and Safe Exam Browser's configuration, on a page of its own
  settingsPages: [
    {
      key: "browser",
      label: "Lockdown Browser",
      description: "The browser participants have to use, and how Safe Exam Browser is set up.",
      route: "/browser",
    },
  ],
  // with the event's other security settings, in Manage → Security
  settingsSections: [
    {
      key: "lockdown",
      title: "Lockdown",
      description: "Full screen, tab switches and what happens when people leave the page.",
      page: "security",
      settings: [
        "mode",
        "during",
        "maxViolations",
        "whenStopped",
        "requireFullscreen",
        "recordTabsAlways",
      ],
    },
    {
      key: "browser",
      title: "Browser",
      description: "What participants open the event in.",
      page: "browser",
      settings: ["require", "desktopOnly"],
    },
    {
      key: "messages",
      title: "Lockdown messages",
      description: "What participants read when they leave the page or are stopped.",
      page: "security",
      settings: ["leaveTitle", "leaveBody", "blockedTitle", "blockedBody"],
    },
  ],
  routes: [
    { path: "/proctor", label: "Lockdown", permission: "lockdown.review" },
    { path: "/browser", area: "manage", label: "Lockdown Browser" },
    // where the event goes once problems close; Safe Exam Browser quits on it
    { path: "/done" },
  ],
  settings: {
    mode: {
      type: "select",
      label: "Mode",
      default: "monitor",
      options: [
        { value: "off", label: "Off" },
        { value: "monitor", label: "Record what happens" },
        { value: "enforce", label: "Record, and stop submissions after too many" },
      ],
    },
    // the rest only matter once lockdown is on
    during: {
      type: "select",
      label: "When it applies",
      description:
        "Participants are locked down whenever they have the event open, or only while the Lockdown window is open on the agenda.",
      default: "always",
      showWhen: { setting: "mode", in: ["monitor", "enforce"] },
      options: [
        { value: "always", label: "Whenever they have the event open" },
        { value: "window", label: 'Only while the "Lockdown" window is open' },
      ],
    },
    maxViolations: {
      type: "number",
      label: "Times someone can leave before submissions stop",
      description: "Organizers can let them back in.",
      default: 3,
      min: 1,
      max: 50,
      showWhen: { setting: "mode", in: ["enforce"] },
    },
    whenStopped: {
      type: "select",
      label: "When someone is stopped",
      description:
        "A banner leaves the event visible. Hiding it covers every page, so someone who was cheating can't read the problems.",
      default: "cover",
      showWhen: { setting: "mode", in: ["enforce"] },
      options: [
        { value: "cover", label: "Hide the event and say why" },
        { value: "banner", label: "Show a banner above the event" },
      ],
    },
    require: {
      type: "select",
      label: "Browser",
      description:
        "What participants have to use. The event stays covered until they open it in that browser; with stopping on, submissions from any other are refused too. Both report themselves, so they're a deterrent.",
      default: "none",
      showWhen: { setting: "mode", in: ["monitor", "enforce"] },
      options: [
        { value: "none", label: "Any browser" },
        { value: "extension", label: "Chrome or Edge with the Bogey lockdown extension" },
        { value: "seb", label: "Safe Exam Browser" },
      ],
    },
    requireFullscreen: {
      type: "boolean",
      label: "Require full screen",
      description:
        "Until participants enter full screen, the event is closed to them: every page sends them to its home, which asks for full screen.",
      default: true,
      showWhen: { setting: "mode", in: ["monitor", "enforce"] },
    },
    recordTabsAlways: {
      type: "boolean",
      label: "Record tab switches when not in full screen or covered",
      description:
        "Off: a tab switch counts only while the event is open in full screen and not covered. On: every tab switch counts.",
      default: false,
      showWhen: { setting: "mode", in: ["monitor", "enforce"] },
    },
    desktopOnly: {
      type: "boolean",
      label: "Turn away phones and tablets",
      description:
        "A mobile browser can't lock anything down. Safe Exam Browser can (it has an iPad app), so this is off while it's required.",
      default: true,
      showWhen: [
        { setting: "mode", in: ["monitor", "enforce"] },
        { setting: "require", in: ["none", "extension"] },
      ],
    },
    leaveTitle: {
      type: "string",
      label: "Title when someone leaves the page",
      description: "{times} becomes once, or a number of times. Empty shows nothing.",
      default: "",
      showWhen: { setting: "mode", in: ["monitor", "enforce"] },
    },
    leaveBody: {
      type: "string",
      label: "Text when someone leaves the page",
      description:
        "{count} is how many times so far, {max} the most before they're stopped. Empty shows nothing.",
      default: "",
      multiline: true,
      showWhen: { setting: "mode", in: ["monitor", "enforce"] },
    },
    blockedTitle: {
      type: "string",
      label: "Title when someone is stopped",
      default: "Submissions are stopped for you",
      showWhen: { setting: "mode", in: ["enforce"] },
    },
    blockedBody: {
      type: "string",
      label: "Text when someone is stopped",
      default: "You left the page too many times. Talk to an organizer to carry on.",
      multiline: true,
      showWhen: { setting: "mode", in: ["enforce"] },
    },
  },
  uses: {
    tables: ["lockdown_sessions", "lockdown_seb_keys", "lockdown_seb_configs"],
    settings: ["plugin.lockdown"],
  },
});

export default manifest;

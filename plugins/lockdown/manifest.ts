import { definePlugin } from "@bogey/plugins/api";

export const manifest = definePlugin({
  key: "lockdown",
  name: "Lockdown",
  api: 1,
  version: "1.0.0",
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
    "inspect_menu",
    "window_blur",
    "devtools",
    "new_window",
    "clipboard",
    "seb_keys_saved",
    "unlocked",
  ],
  // Safe Exam Browser's request headers only reach the server, which hands them to the database
  serverRoutes: [{ path: "/seb-check", method: "POST" }],
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
        "require",
        "requireFullscreen",
        "desktopOnly",
      ],
    },
    {
      key: "messages",
      title: "Lockdown messages",
      description: "What participants read when they leave the page or are stopped.",
      page: "security",
      settings: ["leaveTitle", "leaveBody", "blockedTitle", "blockedBody"],
    },
  ],
  routes: [{ path: "/proctor", label: "Lockdown", permission: "lockdown.review" }],
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
        { value: "window", label: "Only while the Lockdown window is open" },
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
      label: "Require to submit",
      description:
        "Stops submissions from browsers that haven't shown they have it. Both are a deterrent: they report themselves.",
      default: "none",
      showWhen: { setting: "mode", in: ["enforce"] },
      options: [
        { value: "none", label: "Nothing more" },
        { value: "extension", label: "The Bogey lockdown companion extension" },
        { value: "seb", label: "Safe Exam Browser (keys under Lockdown)" },
      ],
    },
    requireFullscreen: {
      type: "boolean",
      label: "Require full screen",
      description: "The event's pages stay covered until participants enter full screen.",
      default: true,
      showWhen: { setting: "mode", in: ["monitor", "enforce"] },
    },
    desktopOnly: {
      type: "boolean",
      label: "Turn away phones and tablets",
      description: "A mobile browser can't lock anything down.",
      default: true,
      showWhen: { setting: "mode", in: ["monitor", "enforce"] },
    },
    leaveTitle: {
      type: "string",
      label: "Title when someone leaves the page",
      description: "{times} becomes once, or a number of times.",
      default: "You left this page {times}",
      showWhen: { setting: "mode", in: ["monitor", "enforce"] },
    },
    leaveBody: {
      type: "string",
      label: "Text when someone leaves the page",
      description: "{count} is how many times so far, {max} the most before they're stopped.",
      default: "Organizers can see this.",
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
  uses: { tables: ["lockdown_sessions", "lockdown_seb_keys"], settings: ["plugin.lockdown"] },
});

export default manifest;

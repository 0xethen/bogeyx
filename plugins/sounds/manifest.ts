import { definePlugin } from "@bogey/plugins/api";

export const manifest = definePlugin({
  key: "sounds",
  name: "Sounds",
  api: 1,
  version: "1.0.0",
  description:
    "Your own sounds, uploaded or linked, for what happens in an event (announcements, messages, solved problems), music timed to the schedule, like a song that ends exactly when hacking does, and background music.",
  author: { name: "Ethen Tseggai", url: "https://github.com/0xethen" },
  license: "MIT",
  source: { repository: "github:0xethen/bogeyx", directory: "plugins/sounds" },
  // organizers set everything up; participants just hear it, and can turn it off with the speaker beside the bell
  routes: [{ path: "", area: "manage", label: "Sounds" }],
  homePanels: [
    {
      key: "now-playing",
      label: "Now playing",
      description: "The cue or background music playing now.",
    },
  ],
  commands: [
    { action: "toggle_mute", label: "Toggle event sounds", keywords: ["mute", "quiet"] },
  ],
  // what Sounds notices itself, since nothing else in the browser is watching for it
  signals: [
    { key: "message-received", label: "Someone else writes in a conversation you can read" },
    { key: "window-opened", label: "A window opens, like submissions" },
    { key: "window-closed", label: "A window closes" },
  ],
  actions: ["uploaded", "linked", "removed", "setup_saved"],
  actionLabels: {
    uploaded: "uploaded a sound",
    linked: "linked a sound",
    removed: "removed a sound",
    setup_saved: "saved the event's sounds",
  },
  limits: {
    maxLibraryMb: { label: "Uploaded sound per event", unit: "MB" },
  },
  settings: {
    effects: {
      type: "boolean",
      label: "Play sound effects",
      description:
        "Which sound plays for what is set on Manage → Sounds. Sounds start for each person the first time they click or type on a page, since browsers allow no sound before that; anyone can turn them off with the speaker button beside the notifications bell.",
      default: true,
    },
    effectsVolume: {
      type: "number",
      label: "Effects volume (%)",
      default: 70,
      min: 0,
      max: 100,
      scrub: true,
      showWhen: { setting: "effects", in: [true] },
    },
    duckMusic: {
      type: "boolean",
      label: "Lower music under sound effects",
      description:
        "Background music fades down while a sound effect plays, including when someone tries one out, then comes back up a moment after.",
      default: true,
    },
    cues: {
      type: "boolean",
      label: "Play cues",
      description: "Sounds timed to the schedule, set on Manage → Sounds.",
      default: true,
    },
    music: {
      type: "select",
      label: "Background music",
      description:
        "Plays for everyone on the event's pages, and steps aside while a music cue plays. Playlist songs from the library plays the sounds switched to In background music under Manage → Sounds → Library, in turn. Generated music needs nothing from the internet.",
      default: "off",
      options: [
        { value: "off", label: "None" },
        { value: "playlist", label: "Library playlist" },
        { value: "lofi", label: "Generated lo-fi beats" },
        { value: "ambient", label: "Generated ambient pads" },
        { value: "stream", label: "A radio stream" },
      ],
    },
    musicVolume: {
      type: "number",
      label: "Music volume (%)",
      description: "For background music and music cues.",
      default: 40,
      min: 0,
      max: 100,
      scrub: true,
    },
    listenerControls: {
      type: "boolean",
      label: "Let people pause the music",
      description:
        "Adds a play and pause button to the Now playing card on the event home, for the background music in that person's browser only. Cues can't be paused, and anyone can still turn all event sounds off beside the bell.",
      default: false,
      showWhen: { setting: "music", in: ["playlist", "lofi", "ambient", "stream"] },
    },
    streamUrl: {
      type: "string",
      label: "Stream address",
      description: "An https audio stream (MP3 or AAC) that allows playing on other sites.",
      placeholder: "https://...",
      default: "",
      showWhen: { setting: "music", in: ["stream"] },
    },
    streamName: {
      type: "string",
      label: "Stream name",
      default: "Event radio",
      showWhen: { setting: "music", in: ["stream"] },
    },
    tempo: {
      type: "number",
      label: "Beats per minute",
      default: 74,
      min: 50,
      max: 110,
      showWhen: { setting: "music", in: ["lofi", "ambient"] },
    },
  },
  // the volumes and background music sit on the Sounds page itself; the Extensions row keeps the switches
  settingsPages: [{ key: "sounds", label: "Sounds", route: "" }],
  settingsSections: [
    {
      key: "volume",
      title: "Volume",
      description: "How loud sound effects and music play for everyone.",
      page: "sounds",
      settings: ["effectsVolume", "musicVolume", "duckMusic"],
    },
    {
      key: "background-music",
      title: "Background music",
      page: "sounds",
      settings: ["music", "streamUrl", "streamName", "tempo", "listenerControls"],
    },
  ],
  uses: {
    tables: [
      "public.sounds_files",
      "public.sounds_effects",
      "public.sounds_cues",
      "public.events",
      "public.event_windows",
      "public.clarification_messages",
    ],
    settings: ["plugin.sounds"],
  },
});

export default manifest;

import { definePlugin } from "@bogey/plugins/api";

export const manifest = definePlugin({
  key: "i18n",
  name: "Languages",
  api: 1,
  version: "1.0.0",
  description: "Shows Bogey in other languages: Spanish to start, and a pattern for adding more.",
  author: { name: "Ethen Tseggai", url: "https://github.com/0xethen" },
  license: "MIT",
  source: { repository: "github:0xethen/bogeyx", directory: "plugins/i18n" },
  // each language is a catalog in this folder; the person's account language picks one
  locales: [{ code: "es", label: "Español" }],
  settings: {
    missing: {
      type: "select",
      // one answer for the whole instance; organizations and events see it but can't change it
      lock: "instance",
      label: "When a message isn't translated",
      description:
        "What people see where their language has no translation yet. A message that exists nowhere always shows as its key (like nav.notifications) instead of breaking the page.",
      default: "english",
      options: [
        { value: "english", label: "Show it in English" },
        { value: "es", label: "Show it in Español, then English" },
        { value: "key", label: "Show its key (to find what needs translating)" },
      ],
    },
  },
});

export default manifest;

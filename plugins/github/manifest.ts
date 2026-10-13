import { definePlugin } from "@bogey/plugins/api";

export const manifest = definePlugin({
  key: "github",
  name: "GitHub",
  api: 1,
  version: "1.0.0",
  description:
    "Fill a submission from a repository's README, and publish your projects to a section of your GitHub profile README.",
  author: { name: "Ethen Tseggai", url: "https://github.com/0xethen" },
  license: "MIT",
  source: { repository: "github:0xethen/bogeyx", directory: "plugins/github" },
  // the page reports these through log_event, so organizers see who published
  actions: ["readme_updated", "imported"],
  routes: [{ path: "", label: "GitHub", permission: "event.compete" }],
  settings: {
    writeReadme: {
      type: "boolean",
      label: "Offer to publish to GitHub profile READMEs",
      description: "Participants choose per account. This only offers it.",
      default: true,
    },
    sectionTitle: {
      type: "string",
      label: "README section heading",
      default: "Hackathon projects",
      placeholder: "Hackathon projects",
      showWhen: { setting: "writeReadme", in: [true] },
    },
  },
  uses: { network: ["api.github.com"] },
});

export default manifest;

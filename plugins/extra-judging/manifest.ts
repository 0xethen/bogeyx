import { definePlugin } from "@bogey/plugins/api";

const peerOn = { setting: "peerRating", in: [true] } as const;

export const manifest = definePlugin({
  key: "extra-judging",
  name: "Extra Judging",
  api: 1,
  version: "1.0.0",
  description:
    "Extra ways to rank a round than the rubric: pairwise comparison, peer rating by participants, ranked ballots and a points budget. Fun!",
  author: { name: "Ethen Tseggai", url: "https://github.com/0xethen" },
  license: "MIT",
  source: { repository: "github:0xethen/bogeyx", directory: "plugins/extra-judging" },
  // the database writes these as `extra-judging.<action>`
  actions: ["absent", "present"],
  windows: [{ key: "rating", label: "Peer rating" }],
  ranking: [
    {
      key: "pairwise",
      label: "Pairwise comparison",
      description:
        "Judges see two projects and pick the better one. Scores come from a Bradley-Terry fit of every pick, so judges don't need to see everything.",
    },
    {
      key: "peer",
      label: "Peer rating",
      description:
        "Participants rate other teams' projects on your criteria while the Peer rating window is open. Judges have nothing to score.",
    },
    {
      key: "ranked",
      label: "Ranked ballots",
      description:
        "Each judge puts the projects they saw in order. A Borda count of every ballot ranks the round.",
    },
    {
      key: "budget",
      label: "Points budget",
      description:
        "Each judge spreads a fixed budget of points over the projects they like, like investors. The most points wins.",
    },
  ],
  settings: {
    peerRating: {
      type: "boolean",
      label: "Participants rate projects",
      description: "Shows Rate projects to participants. Rank a round with Peer rating to use it.",
      default: false,
    },
    peerCriteria: {
      type: "string",
      label: "Peer rating criteria",
      description: "One per line, up to 8. Raters score each one.",
      multiline: true,
      default: "Overall",
      showWhen: peerOn,
    },
    peerMaxScore: {
      type: "number",
      label: "Top mark",
      description: "Raters give 1 up to this.",
      default: 5,
      min: 2,
      max: 10,
      showWhen: peerOn,
    },
    peerMinRatings: {
      type: "number",
      label: "Ratings a project needs to rank",
      default: 3,
      min: 1,
      max: 50,
      showWhen: peerOn,
    },
    peerMode: {
      type: "select",
      label: "Who rates what",
      default: "assigned",
      options: [
        { value: "assigned", label: "Bogey hands each person projects, fewest ratings first" },
        { value: "chosen", label: "People choose which projects to rate" },
      ],
      showWhen: peerOn,
    },
    peerPerPerson: {
      type: "number",
      label: "Projects each person rates",
      default: 5,
      min: 1,
      max: 50,
      showWhen: peerOn,
    },
    rankedMinBallots: {
      type: "number",
      label: "Ballots a project needs to rank",
      description: "For rounds ranked by ballots. A ballot with one project doesn't count.",
      default: 1,
      min: 1,
      max: 50,
    },
    budget: {
      type: "number",
      label: "Points each judge spends",
      description: "For rounds ranked by a points budget.",
      default: 100,
      min: 1,
      max: 100000,
    },
  },
  // beside the event's own judging settings, in Manage → Judging
  settingsSections: [
    {
      key: "peer-rating",
      title: "Peer rating",
      description: "Participants rate other teams' projects in rounds ranked by Peer rating.",
      page: "judging",
      settings: [
        "peerRating",
        "peerCriteria",
        "peerMaxScore",
        "peerMinRatings",
        "peerMode",
        "peerPerPerson",
      ],
    },
    {
      key: "ballots",
      title: "Ranked ballots and points budgets",
      page: "judging",
      settings: ["rankedMinBallots", "budget"],
    },
  ],
  routes: [
    { path: "/rate", label: "Rate projects", permission: "event.compete", showWhen: peerOn },
    { path: "", area: "manage", label: "Extra Judging" },
  ],
  uses: {
    tables: [
      "public.submissions",
      "public.judging_rounds",
      "public.judge_assignments",
      "public.judge_conflicts",
      "public.ranking_inputs",
    ],
  },
  translations: ["es"],
  // language extensions may translate its text into languages it doesn't ship
  shares: { messages: true },
});

export default manifest;

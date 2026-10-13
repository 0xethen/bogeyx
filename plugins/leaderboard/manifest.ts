import { definePlugin } from "@bogey/plugins/api";

export const manifest = definePlugin({
  key: "leaderboard",
  name: "Leaderboard",
  api: 1,
  version: "1.0.0",
  description:
    "Scored prediction files like Kaggle. Teams upload a CSV, Bogey scores it against hidden answers, and a leaderboard ranks the best.",
  author: { name: "Ethen Tseggai", url: "https://github.com/0xethen" },
  license: "MIT",
  source: { repository: "github:0xethen/bogeyx", directory: "plugins/leaderboard" },
  windows: [{ key: "board", label: "Leaderboard" }],
  // the database writes these as `leaderboard.<action>`
  actions: ["answers_set", "submitted"],
  itemTypes: [
    {
      kind: "predictions",
      label: "Scored predictions",
      description:
        "Teams send a CSV of predictions on the Leaderboard page; this item shows their best public score.",
      config: {
        metric: {
          type: "select",
          label: "Metric",
          default: "accuracy",
          options: [
            { value: "accuracy", label: "Accuracy (higher is better)" },
            { value: "macro_f1", label: "Macro F1 (higher is better)" },
            { value: "rmse", label: "RMSE (lower is better)" },
            { value: "mae", label: "MAE (lower is better)" },
            { value: "log_loss", label: "Log loss, 0/1 answers (lower is better)" },
          ],
        },
        idColumn: { type: "string", label: "Id column", default: "id" },
        answerColumn: { type: "string", label: "Answer column in your file", default: "answer" },
        valueColumn: {
          type: "string",
          label: "Prediction column in teams' files",
          default: "prediction",
        },
        publicPercent: {
          type: "number",
          label: "Rows in the public split (%)",
          default: 30,
          min: 5,
          max: 95,
        },
        dailyLimit: {
          type: "number",
          label: "Tries per team per day",
          default: 5,
          min: 1,
          max: 100,
        },
      },
    },
  ],
  ranking: [
    {
      key: "score",
      label: "Leaderboard score",
      description:
        "Each team's private score from the attempt with its best public score, so teams that overfit the public rows lose out.",
    },
  ],
  routes: [{ path: "", label: "Leaderboard" }],
  uses: { tables: ["public.submission_items", "public.submissions", "public.ranking_inputs"] },
});

export default manifest;

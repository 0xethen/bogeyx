# Leaderboard

Scored prediction files, Kaggle style. Use it for machine-learning and data-science events where teams submit a CSV and
a program scores it.

## Set up a task

1. Turn the plugin on (Manage → Extensions).
2. In a submission form, add an item of type **Scored predictions**. Set the metric, the column names and how many
   tries each team gets per day.
3. Open **Leaderboard** and, as an organizer, upload the hidden answers CSV. It needs the id column and the answer
   column. Each row goes to the public or private split by a seeded hash of its id (the item's "public split" percent),
   so the split is the same every time. Answers can't change once a team has sent predictions. Nobody can read them
   back, not even organizers.
4. Add the **Leaderboard** window to the agenda to show the public board. Organizers always see it.
5. To rank results by it, set a round's ranking method to **Leaderboard score** (Manage → Judging).

## What teams do

Save the submission once, then open **Leaderboard** and send a CSV with the id column and the prediction column. It must
have a row for every id in the answers; extra rows are ignored. The reply shows the public score and the tries left.
The item on the submission shows the best public score.

## Metrics

| Metric   | Predictions are         | Better  |
| -------- | ----------------------- | ------- |
| accuracy | a label                 | higher  |
| macro_f1 | a label (mean over classes in the split) | higher  |
| rmse     | a number                | lower   |
| mae      | a number                | lower   |
| log_loss | probability of class 1; answers are 0 or 1 | lower |

Fields can be quoted (`"a, b"`, `""` for a quote). Files are limited to 5 MB and 200,000 rows.

## Public and private

The public board ranks teams by their best public score. When results are published (or for organizers) it also shows
each team's private score, from the attempt with its best public score, and ranks by that. This is the only thing that
counts for a round ranked by **Leaderboard score**; it stops teams from tuning to the public rows.

Press **Refresh the ranking** after entries are submitted, since a team's attempt only counts for ranking once its
submission is submitted. Use one scored item per form: the ranking reads the first.

## Tests

`node --test tests/scores.test.ts`; `tests/leaderboard.test.sql` runs with `supabase test db`.

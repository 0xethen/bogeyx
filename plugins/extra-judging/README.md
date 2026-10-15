# Extra judging

More ways to rank a judged round than Bogey's rubric. Turn the extension on for an event (Manage → Extensions), then
pick a round's method in Manage → Judging. Each method is a ranking provider: results, advancing the top N, awards and
exports use its scores like any other round.

| Method              | Who judges   | What they do                                     | The score                                 |
| ------------------- | ------------ | ------------------------------------------------ | ----------------------------------------- |
| Pairwise comparison | Judges       | Pick the better of this project and the next one | Bradley-Terry fit of every pick           |
| Peer rating         | Participants | Rate other teams' projects on your criteria      | Average rating, as a percent              |
| Ranked ballots      | Judges       | Put the projects they saw in order               | Borda count of every ballot, as a percent |
| Points budget       | Judges       | Spread a fixed budget of points over projects    | Points received                           |

Every method respects judge conflicts (Manage → Judging) and the round's window. **Extra judging** in Manage's sidebar
shows how each method is going.

## Pairwise comparison

Expo judging by comparison. A judge opens a project, sees the next one, and picks the better of the two. No judge has to
see everything, and nobody has to agree on what a "7" means. The idea and the interaction come from
[Gavel](https://github.com/anishathalye/gavel) (AGPL); this is a reimplementation with its own code and a simpler model
(Bradley-Terry, not Crowd-BT). Nothing was copied.

- Each project has a strength; the chance A beats B is `A / (A + B)`. Strengths are fitted to every pick after each pick
  (`private.xj_pairwise_rerank`), and the log of a project's strength is its score. Every project also plays one
  half-won game against an average project, so one that has only won (or only lost) still gets a finite score.
- The next project is one this judge hasn't compared with the current one, from a team they have no conflict with, the
  least compared first. Picking a pair again replaces the earlier pick.
- **The next team isn't here** marks a project absent for the round: it leaves the comparisons and the ranking (audited
  as `extra-judging.absent`).
- Judge agreement shows how often each judge's picks match the combined ranking: a prompt for a conversation, not a
  verdict.

## Peer rating

Game-jam style: the people in the room are the judges. Turn on **Participants rate projects**, set the criteria, top mark
and how many ratings a project needs, rank a round with **Peer rating**, and open the **Peer rating** window on the
agenda. Participants go to **Rate projects**.

- People never rate their own team's project, and can change a rating until the window closes.
- **Bogey hands each person projects** gives out the least-rated first, so ratings spread evenly. **People choose** lets
  them pick, up to the same cap.
- A project's score is the mean of every mark it got, as a percent of the top mark. Projects below the minimum are left
  out of the ranking. Judges see a note instead of a score sheet.
- Raters can't see who rated what; organizers can. Nothing stops a friend group from rating each other highly, so keep
  the minimum high enough that one clique can't decide the ranking.

## Ranked ballots

For a final round, or a panel that would rather compare than score. On each project, the judge sees their ballot: the
projects they're assigned in the round (plus the one they have open), and moves them up and down, best first. **Save
ranking** replaces their ballot.

- On a ballot of `n` projects, place `p` earns `(n - p) / (n - 1)`: 1 for first, 0 for last. A project's score is its
  average over the ballots it's on, as a percent. A ballot with one project says nothing and is skipped.
- **Ballots a project needs to rank** leaves out projects too few judges placed.

## Points budget

"Shark tank" judging. Each judge has a budget (100 points unless you change it) to spread over the projects they would
back, and can give a project anything from 0 to what they have left. A project's score is the points it received.
Judges who saw more projects don't have more points to spend, so assign judges evenly.

## Tests

`node --test tests/sheet.test.ts`; `tests/extra_judging.test.sql` runs with `supabase test db`.

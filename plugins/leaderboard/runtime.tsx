import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ok, toFailure, unwrap } from "@bogey/db/errors";
import { can, useEventAccess } from "@bogey/db/permissions";
import {
  definePluginRuntime,
  type PluginContext,
  type PluginItemFieldProps,
  type PluginItemViewProps,
} from "@bogey/plugins/runtime";
import { Button } from "@bogey/ui/components/button";
import { ErrorAlert } from "@bogey/ui/components/error-alert";
import { Input } from "@bogey/ui/components/input";
import { Panel } from "@bogey/ui/components/panel";
import { RelativeTime } from "@bogey/ui/components/relative-time";
import { Screen } from "@bogey/ui/components/screen";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@bogey/ui/components/table";
import {
  attemptsQueryOptions,
  boardQueryOptions,
  client,
  tasksQueryOptions,
  type Task,
} from "./database.ts";
import { manifest } from "./manifest.ts";
import { fileProblem, formatScore, lowerIsBetter } from "./scores.ts";

/** Query errors are typed `unknown`; ErrorAlert wants a message. */
function messageOf(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** Reads the chosen file and hands its text to `send`; one place for the file checks. */
function FileSend({
  label,
  busy,
  error,
  onText,
}: {
  label: string;
  busy: boolean;
  error: unknown;
  onText: (text: string) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium" htmlFor={`file-${label}`}>
        {label}
      </label>
      <Input
        id={`file-${label}`}
        type="file"
        accept=".csv,text/csv"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          const why = fileProblem(file);
          setProblem(why);
          if (!why) void file.text().then(onText);
        }}
      />
      <ErrorAlert error={problem ?? messageOf(error)} />
    </div>
  );
}

function Board({ task }: { task: Task }) {
  const board = useQuery(boardQueryOptions(task.item_id));
  const rows = board.data ?? [];
  const reveals = rows.some((row) => row.private_score !== null);
  return (
    <>
      <ErrorAlert error={messageOf(board.error)} title="No leaderboard to show" />
      {board.data && rows.length === 0 && <p className="text-sm text-muted-fg">No scores yet.</p>}
      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Team</TableHead>
              <TableHead className="text-right">Public</TableHead>
              {reveals && <TableHead className="text-right">Private</TableHead>}
              <TableHead className="text-right">Tries</TableHead>
              <TableHead>Last try</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.rank}:${row.team_name}`}>
                <TableCell>{row.rank}</TableCell>
                <TableCell>{row.team_name}</TableCell>
                <TableCell className="text-right">{formatScore(row.public_score)}</TableCell>
                {reveals && (
                  <TableCell className="text-right">
                    {row.private_score === null ? "" : formatScore(row.private_score)}
                  </TableCell>
                )}
                <TableCell className="text-right">{row.attempts}</TableCell>
                <TableCell>
                  <RelativeTime value={row.last_at} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function TeamUpload({ task }: { task: Task }) {
  const queryClient = useQueryClient();
  const attempts = useQuery(attemptsQueryOptions(task.item_id));
  const submit = useMutation({
    mutationFn: async (csv: string) => {
      const { data, error } = await client().rpc("leaderboard_submit", {
        p_item: task.item_id,
        p_csv: csv,
      });
      return unwrap(error ? toFailure(error, "scoring your file") : ok(data?.[0] ?? null));
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: attemptsQueryOptions(task.item_id).queryKey }),
        queryClient.invalidateQueries({ queryKey: boardQueryOptions(task.item_id).queryKey }),
      ]),
  });
  return (
    <div className="flex flex-col gap-3">
      <FileSend
        label={`Send predictions (up to ${task.daily_limit} a day)`}
        busy={submit.isPending}
        error={submit.error ?? attempts.error}
        onText={(csv) => submit.mutate(csv)}
      />
      {submit.data && (
        <p className="text-sm">
          Scored {formatScore(submit.data.public_score)} on the public rows.{" "}
          {submit.data.tries_left} {submit.data.tries_left === 1 ? "try" : "tries"} left today.
        </p>
      )}
      {attempts.data && attempts.data.length > 0 && (
        <ul className="text-sm text-muted-fg">
          {attempts.data.map((attempt) => (
            <li key={attempt.attempt_id}>
              {formatScore(attempt.public_score)} <RelativeTime value={attempt.created_at} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OrganizerTools({ task }: { task: Task }) {
  const queryClient = useQueryClient();
  const setAnswers = useMutation({
    mutationFn: async (csv: string) => {
      const { data, error } = await client().rpc("leaderboard_set_answers", {
        p_item: task.item_id,
        p_csv: csv,
      });
      return unwrap(error ? toFailure(error, "saving the answers") : ok(data));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
  });
  return (
    <div className="flex flex-col gap-2">
      <FileSend
        label={
          task.has_answers
            ? `Replace the hidden answers (${task.answer_rows} rows now)`
            : "Upload the hidden answers"
        }
        busy={setAnswers.isPending}
        error={setAnswers.error}
        onText={(csv) => setAnswers.mutate(csv)}
      />
      {setAnswers.data !== undefined && <p className="text-sm">Saved {setAnswers.data} rows.</p>}
    </div>
  );
}

function LeaderboardPage({ eventId }: PluginContext) {
  const queryClient = useQueryClient();
  const access = useEventAccess();
  const manager = can(access, "event.manage");
  const tasks = useQuery(tasksQueryOptions(eventId));
  const refresh = useMutation({
    mutationFn: async () => {
      const { error } = await client().rpc("leaderboard_refresh", { p_event: eventId });
      return unwrap(error ? toFailure(error, "refreshing the ranking") : ok(undefined));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
  });
  return (
    <Screen
      title="Leaderboard"
      description={`${manifest.name}: scores come from comparing each file with answers only organizers hold.`}
    >
      <ErrorAlert error={messageOf(tasks.error ?? refresh.error)} />
      {tasks.data?.length === 0 && (
        <p className="text-sm text-muted-fg">
          No task yet. Add a "Scored predictions" item to a submission form.
        </p>
      )}
      {tasks.data?.map((task) => (
        <Panel
          key={task.item_id}
          title={task.label}
          description={`${task.form_title}. Metric: ${task.metric}, ${lowerIsBetter(task.metric) ? "lower" : "higher"} is better.`}
        >
          {manager ? <OrganizerTools task={task} /> : <TeamUpload task={task} />}
          <Board task={task} />
        </Panel>
      ))}
      {manager && tasks.data && tasks.data.length > 0 && (
        <div>
          <Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            Refresh the ranking
          </Button>
        </div>
      )}
    </Screen>
  );
}

/** The answer is written by the Leaderboard page, so teams only see it here. */
function PredictionsField({ value }: PluginItemFieldProps) {
  return (
    <p className="text-sm text-muted-fg">
      {value
        ? `Best public score: ${value}. `
        : "Send predictions on the Leaderboard page once this submission is saved."}
    </p>
  );
}

function PredictionsView({ value }: PluginItemViewProps) {
  return <span>Best public score {value}</span>;
}

export default definePluginRuntime(manifest, {
  itemTypes: {
    predictions: { Field: PredictionsField, View: PredictionsView, validate: () => null },
  },
  routes: { "": LeaderboardPage },
});

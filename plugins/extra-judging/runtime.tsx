import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";
import { ok, toFailure, unwrap } from "@bogey/db/errors";
import { createPluginMessages } from "@bogey/plugins/messages";
import {
  definePluginRuntime,
  type PluginContext,
  type PluginJudgingPanelContext,
} from "@bogey/plugins/runtime";
import type { SettingsOf } from "@bogey/plugins/types";
import { Badge } from "@bogey/ui/components/badge";
import { Button } from "@bogey/ui/components/button";
import { ErrorAlert } from "@bogey/ui/components/error-alert";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@bogey/ui/components/number-field";
import { Panel } from "@bogey/ui/components/panel";
import { Screen } from "@bogey/ui/components/screen";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@bogey/ui/components/table";
import { useUnsavedEntry } from "@bogey/ui/lib/unsaved";
import {
  agreementQueryOptions,
  candidatesQueryOptions,
  client,
  myEntriesQueryOptions,
  nextEntryQueryOptions,
  progressQueryOptions,
  ROOT,
  sheetQueryOptions,
  summaryQueryOptions,
  type MyEntry,
  type NextEntry,
  type SheetRow,
} from "./database.ts";
import { manifest } from "./manifest.ts";
import { en } from "./messages.ts";
import { isComplete, move, parseCriteria, pointsLeft } from "./sheet.ts";

type Settings = SettingsOf<typeof manifest>;
type PanelProps = PluginJudgingPanelContext<Settings>;

const { useT } = createPluginMessages(manifest, en);
type T = ReturnType<typeof useT>;

/** Query errors are typed `unknown`; ErrorAlert wants a message. */
function messageOf(error: unknown, t: T): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : t("error.generic");
}

function entryName(t: T, entry: { title: string; table_label: string | null }): string {
  return entry.table_label
    ? t("table.label", { label: entry.table_label, title: entry.title })
    : entry.title;
}

/** Refreshes everything the plugin shows after a write. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [ROOT] });
}

// ─── pairwise ───────────────────────────────────────────────────────────────────────────────

function PairwisePanel({ submissionId }: PanelProps) {
  const t = useT();
  const refresh = useRefresh();
  const next = useQuery(nextEntryQueryOptions(submissionId));

  const choose = useMutation({
    mutationFn: async ({ winner, loser }: { winner: string; loser: string }) => {
      const { error } = await client().rpc("xj_pairwise_choose", {
        p_winner: winner,
        p_loser: loser,
      });
      return unwrap(error ? toFailure(error, "saving your pick") : ok(undefined));
    },
    onSuccess: refresh,
  });
  const absent = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await client().rpc("xj_set_absent", { p_submission: id, p_absent: true });
      return unwrap(error ? toFailure(error, "marking the team absent") : ok(undefined));
    },
    onSuccess: refresh,
  });

  const entry: NextEntry | null | undefined = next.data;
  return (
    <Panel title={t("pairwise.title")} description={t("pairwise.help")}>
      {next.isPending && <p className="text-sm text-muted-fg">{t("pairwise.finding")}</p>}
      <ErrorAlert error={messageOf(next.error ?? choose.error ?? absent.error, t)} />
      {entry === null && <p className="text-sm text-muted-fg">{t("pairwise.done")}</p>}
      {entry && (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">
            {t("pairwise.next", { title: entryName(t, entry) })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={choose.isPending}
              onClick={() => choose.mutate({ winner: submissionId, loser: entry.id })}
            >
              {t("pairwise.thisBetter")}
            </Button>
            <Button
              variant="outline"
              disabled={choose.isPending}
              onClick={() => choose.mutate({ winner: entry.id, loser: submissionId })}
            >
              {t("pairwise.nextBetter")}
            </Button>
            <Button
              variant="ghost"
              disabled={absent.isPending}
              onClick={() => absent.mutate(entry.id)}
            >
              {t("pairwise.absent")}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

// ─── ranked ballots ─────────────────────────────────────────────────────────────────────────

/** The saved ballot first, then the projects not placed yet. */
function initialOrder(rows: readonly SheetRow[]): string[] {
  return rows.map((row) => row.submission_id);
}

function BallotPanel({ roundId, submissionId }: PanelProps) {
  if (!roundId) return null;
  return <Ballot roundId={roundId} submissionId={submissionId} />;
}

function Ballot({ roundId, submissionId }: { roundId: string; submissionId: string }) {
  const t = useT();
  const sheet = useQuery(sheetQueryOptions(roundId, submissionId));
  if (!sheet.data) return <ErrorAlert error={messageOf(sheet.error, t)} />;
  return (
    <BallotEditor
      // remount with the saved order once a save lands
      key={sheet.data.map((row) => `${row.submission_id}:${row.place ?? ""}`).join()}
      roundId={roundId}
      submissionId={submissionId}
      rows={sheet.data}
    />
  );
}

function BallotEditor({
  roundId,
  submissionId,
  rows,
}: {
  roundId: string;
  submissionId: string;
  rows: readonly SheetRow[];
}) {
  const t = useT();
  const refresh = useRefresh();
  const start = initialOrder(rows);
  const [order, setOrder] = useState(start);
  const saved = rows.length > 1 && rows.every((row) => row.place !== null);
  const dirty = order.join() !== start.join();
  const byId = new Map(rows.map((row) => [row.submission_id, row]));

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await client().rpc("xj_save_ballot", { p_round: roundId, p_order: order });
      return unwrap(error ? toFailure(error, "saving your ranking") : ok(undefined));
    },
    onSuccess: refresh,
  });
  // a scoring sheet keeps its own button; the bar only guards leaving with changes
  useUnsavedEntry({ dirty, reset: () => setOrder(start) });

  return (
    <Panel
      title={t("ranked.title")}
      description={t("ranked.help")}
      action={
        <Badge variant="outline">{saved && !dirty ? t("ranked.saved") : t("ranked.unsaved")}</Badge>
      }
    >
      {rows.length === 0 && <p className="text-sm text-muted-fg">{t("ranked.empty")}</p>}
      <ol className="flex flex-col gap-1">
        {order.map((id, index) => {
          const row = byId.get(id);
          if (!row) return null;
          const title = entryName(t, row);
          return (
            <li
              key={id}
              className={`flex items-center gap-2 rounded-xl px-2 py-1 text-sm ${id === submissionId ? "bg-accent font-medium" : ""}`}
            >
              <span className="w-6 text-right tabular-nums text-muted-fg">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("ranked.up", { title })}
                disabled={index === 0}
                onClick={() => setOrder(move(order, index, -1))}
              >
                <IconArrowUp />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("ranked.down", { title })}
                disabled={index === order.length - 1}
                onClick={() => setOrder(move(order, index, 1))}
              >
                <IconArrowDown />
              </Button>
            </li>
          );
        })}
      </ol>
      <ErrorAlert error={messageOf(save.error, t)} />
      {order.length > 1 && (
        <div>
          <Button disabled={save.isPending || (saved && !dirty)} onClick={() => save.mutate()}>
            {save.isPending ? t("ranked.saving") : t("ranked.save")}
          </Button>
        </div>
      )}
    </Panel>
  );
}

// ─── points budget ──────────────────────────────────────────────────────────────────────────

function BudgetPanel({ roundId, submissionId, settings }: PanelProps) {
  const t = useT();
  const sheet = useQuery({ ...sheetQueryOptions(roundId ?? "", submissionId), enabled: !!roundId });
  if (!roundId) return null;
  if (!sheet.data) return <ErrorAlert error={messageOf(sheet.error, t)} />;
  const mine = sheet.data.find((row) => row.submission_id === submissionId);
  return (
    <BudgetEditor
      key={`${submissionId}:${mine?.points ?? 0}`}
      submissionId={submissionId}
      budget={settings.budget}
      rows={sheet.data}
      saved={mine?.points ?? 0}
    />
  );
}

function BudgetEditor({
  submissionId,
  budget,
  rows,
  saved,
}: {
  submissionId: string;
  budget: number;
  rows: readonly SheetRow[];
  saved: number;
}) {
  const t = useT();
  const refresh = useRefresh();
  const [points, setPoints] = useState(saved);
  const left = pointsLeft(budget, rows, submissionId, points);
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await client().rpc("xj_allocate", {
        p_submission: submissionId,
        p_points: points,
      });
      return unwrap(error ? toFailure(error, "saving your points") : ok(undefined));
    },
    onSuccess: refresh,
  });
  useUnsavedEntry({ dirty: points !== saved, reset: () => setPoints(saved) });
  const elsewhere = rows.filter(
    (row) => row.submission_id !== submissionId && (row.points ?? 0) > 0,
  );

  return (
    <Panel
      title={t("budget.title")}
      description={t("budget.help", { budget })}
      action={
        <Badge variant={left < 0 ? "destructive" : "outline"}>
          {t("budget.left", { left: Math.max(left, 0), budget })}
        </Badge>
      }
    >
      <NumberField
        value={points}
        min={0}
        max={budget}
        step={1}
        onValueChange={(value) => setPoints(value ?? 0)}
        aria-label={t("budget.points")}
        className="max-w-48"
      >
        <NumberFieldGroup>
          <NumberFieldDecrement />
          <NumberFieldInput />
          <NumberFieldIncrement />
        </NumberFieldGroup>
      </NumberField>
      {left < 0 && <p className="text-sm text-destructive">{t("budget.over", { over: -left })}</p>}
      <ErrorAlert error={messageOf(save.error, t)} />
      <div>
        <Button
          disabled={save.isPending || left < 0 || points === saved}
          onClick={() => save.mutate()}
        >
          {t("budget.save")}
        </Button>
      </div>
      {elsewhere.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t("budget.elsewhere")}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {elsewhere.map((row) => (
              <li key={row.submission_id} className="flex justify-between gap-2">
                <span className="truncate">{entryName(t, row)}</span>
                <span className="tabular-nums">{row.points}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

// ─── peer rating ────────────────────────────────────────────────────────────────────────────

/** Judges have nothing to score in a round ranked by participants. */
function PeerPanel(_context: PanelProps) {
  const t = useT();
  return (
    <p className="rounded-2xl border border-border p-4 text-sm text-muted-fg">
      {t("peer.noJudging")}
    </p>
  );
}

function EntryCard({
  entry,
  criteria,
  max,
}: {
  entry: MyEntry;
  criteria: readonly string[];
  max: number;
}) {
  const t = useT();
  const refresh = useRefresh();
  const [scores, setScores] = useState<Record<string, number>>(entry.scores ?? {});
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await client().rpc("xj_peer_rate", {
        p_submission: entry.submission_id,
        p_scores: scores,
      });
      return unwrap(error ? toFailure(error, "saving your rating") : ok(undefined));
    },
    onSuccess: refresh,
  });
  const marks = Array.from({ length: max }, (_, index) => index + 1);
  return (
    <Panel
      size="sm"
      title={entryName(t, entry)}
      description={entry.scores ? t("rate.rated") : undefined}
    >
      {criteria.map((criterion) => (
        <div key={criterion} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">{criterion}</span>
          <div className="flex gap-1" role="group" aria-label={criterion}>
            {marks.map((mark) => (
              <Button
                key={mark}
                type="button"
                size="sm"
                variant={scores[criterion] === mark ? "default" : "outline"}
                aria-pressed={scores[criterion] === mark}
                onClick={() => setScores((current) => ({ ...current, [criterion]: mark }))}
              >
                {mark}
              </Button>
            ))}
          </div>
        </div>
      ))}
      <ErrorAlert error={messageOf(save.error, t)} />
      <div>
        <Button
          disabled={!isComplete(scores, criteria, max) || save.isPending}
          onClick={() => save.mutate()}
        >
          {t("rate.save")}
        </Button>
      </div>
    </Panel>
  );
}

function RatePage({ eventId, settings }: PluginContext<Settings>) {
  const t = useT();
  const refresh = useRefresh();
  const mine = useQuery(myEntriesQueryOptions(eventId));
  const chosen = settings.peerMode === "chosen";
  const candidates = useQuery({ ...candidatesQueryOptions(eventId), enabled: chosen });
  const claim = useMutation({
    mutationFn: async (submissionId?: string) => {
      const { error } = await client().rpc("xj_peer_claim", {
        p_event: eventId,
        p_submission: submissionId,
      });
      return unwrap(error ? toFailure(error, "getting projects to rate") : ok(undefined));
    },
    onSuccess: refresh,
  });
  const criteria = parseCriteria(settings.peerCriteria);
  const held = mine.data?.length ?? 0;
  const room = mine.data !== undefined && held < settings.peerPerPerson;
  return (
    <Screen title={t("rate.title")} description={t("rate.help", { max: settings.peerMaxScore })}>
      <ErrorAlert error={messageOf(mine.error ?? candidates.error ?? claim.error, t)} />
      {room && !chosen && (
        <div>
          <Button disabled={claim.isPending} onClick={() => claim.mutate(undefined)}>
            {held === 0 ? t("rate.get") : t("rate.getMore")}
          </Button>
        </div>
      )}
      {room && chosen && (
        <Panel
          size="sm"
          title={t("rate.pick")}
          description={t("rate.pickLeft", { count: settings.peerPerPerson - held })}
        >
          {candidates.data?.length === 0 && (
            <p className="text-sm text-muted-fg">{t("rate.noneReady")}</p>
          )}
          <div className="flex flex-col gap-1">
            {candidates.data?.map((candidate) => (
              <Button
                key={candidate.submission_id}
                variant="outline"
                className="justify-start"
                disabled={claim.isPending}
                onClick={() => claim.mutate(candidate.submission_id)}
              >
                {entryName(t, candidate)}
              </Button>
            ))}
          </div>
        </Panel>
      )}
      {mine.data?.map((entry) => (
        <EntryCard
          key={entry.submission_id}
          entry={entry}
          criteria={criteria}
          max={settings.peerMaxScore}
        />
      ))}
    </Screen>
  );
}

// ─── organizers ─────────────────────────────────────────────────────────────────────────────

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function ManagePage({ eventId, settings }: PluginContext<Settings>) {
  const t = useT();
  const agreement = useQuery(agreementQueryOptions(eventId));
  const summary = useQuery(summaryQueryOptions(eventId));
  const progress = useQuery(progressQueryOptions(eventId));
  const loaded = agreement.data && summary.data && progress.data;
  const empty =
    loaded &&
    agreement.data.length === 0 &&
    summary.data.length === 0 &&
    progress.data.length === 0;
  return (
    <Screen title={t("manage.title")} description={t("manage.help")}>
      <ErrorAlert error={messageOf(agreement.error ?? summary.error ?? progress.error, t)} />
      {empty && <p className="text-sm text-muted-fg">{t("manage.nothing")}</p>}
      {agreement.data && agreement.data.length > 0 && (
        <Panel title={t("manage.pairwise")} description={t("manage.pairwiseHelp")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("manage.round")}</TableHead>
                <TableHead>{t("manage.judge")}</TableHead>
                <TableHead className="text-right">{t("manage.picks")}</TableHead>
                <TableHead className="text-right">{t("manage.agree")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agreement.data.map((row) => (
                <TableRow key={`${row.round_id}:${row.judge_id}`}>
                  <TableCell>{row.round_name}</TableCell>
                  <TableCell>{row.judge_name}</TableCell>
                  <TableCell className="text-right">{row.comparisons}</TableCell>
                  <TableCell className="text-right">{percent(row.agreement)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
      {summary.data && summary.data.length > 0 && (
        <Panel
          title={t("manage.peer")}
          description={t("manage.peerHelp", { min: settings.peerMinRatings })}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("manage.round")}</TableHead>
                <TableHead>{t("manage.project")}</TableHead>
                <TableHead className="text-right">{t("manage.ratings")}</TableHead>
                <TableHead className="text-right">{t("manage.average")}</TableHead>
                <TableHead>{t("manage.ranked")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.data.map((row) => (
                <TableRow key={row.submission_id}>
                  <TableCell>{row.round_name}</TableCell>
                  <TableCell>{row.title}</TableCell>
                  <TableCell className="text-right">{row.ratings}</TableCell>
                  <TableCell className="text-right">{row.average ?? "-"}</TableCell>
                  <TableCell>{row.ranked ? t("manage.yes") : t("manage.notYet")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
      {progress.data && progress.data.length > 0 && (
        <Panel title={t("manage.judges")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("manage.round")}</TableHead>
                <TableHead>{t("manage.method")}</TableHead>
                <TableHead>{t("manage.judge")}</TableHead>
                <TableHead className="text-right">{t("manage.entries")}</TableHead>
                <TableHead className="text-right">{t("manage.points")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {progress.data.map((row) => (
                <TableRow key={`${row.round_id}:${row.judge_id}`}>
                  <TableCell>{row.round_name}</TableCell>
                  <TableCell>
                    {row.method === "extra-judging.budget"
                      ? t("method.budget")
                      : t("method.ranked")}
                  </TableCell>
                  <TableCell>{row.judge_name}</TableCell>
                  <TableCell className="text-right">{row.entries}</TableCell>
                  <TableCell className="text-right">
                    {row.method === "extra-judging.budget" ? row.points : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </Screen>
  );
}

/** The panel for the round's method, in place of the rubric. */
function JudgingPanel(context: PanelProps) {
  switch (context.method) {
    case "extra-judging.pairwise":
      return <PairwisePanel {...context} />;
    case "extra-judging.peer":
      return <PeerPanel {...context} />;
    case "extra-judging.ranked":
      return <BallotPanel {...context} />;
    case "extra-judging.budget":
      return <BudgetPanel {...context} />;
    default:
      return null;
  }
}

export default definePluginRuntime(manifest, {
  routes: { "/rate": RatePage, "": ManagePage },
  slots: { judgingPanel: JudgingPanel },
  messages: { es: () => import("./es.ts").then((module) => module.es) },
});

import { queryOptions } from "@tanstack/react-query";
import { browserClientFor } from "@bogey/db/browser";
import { ok, retryPolicy, toFailure, unwrap } from "@bogey/db/errors";

// ── the plugin's functions, as `supabase gen types` writes them for migrations/ ──

export type NextEntry = { id: string; title: string; table_label: string | null };

export type AgreementRow = {
  round_id: string;
  round_name: string;
  judge_id: string;
  judge_name: string;
  comparisons: number;
  agreement: number;
};

export type MyEntry = {
  submission_id: string;
  title: string;
  table_label: string | null;
  scores: Record<string, number> | null;
};

export type Candidate = Pick<MyEntry, "submission_id" | "title" | "table_label">;

export type SummaryRow = {
  round_name: string;
  submission_id: string;
  title: string;
  ratings: number;
  average: number | null;
  ranked: boolean;
};

export type SheetRow = {
  submission_id: string;
  title: string;
  table_label: string | null;
  place: number | null;
  points: number | null;
};

export type ProgressRow = {
  round_id: string;
  round_name: string;
  method: string;
  judge_id: string;
  judge_name: string;
  entries: number;
  points: number;
};

export type ExtraJudgingDatabase = {
  public: {
    Tables: { [_ in never]: never };
    Views: { [_ in never]: never };
    Functions: {
      xj_pairwise_next: { Args: { p_submission: string }; Returns: NextEntry[] };
      xj_pairwise_choose: { Args: { p_winner: string; p_loser: string }; Returns: undefined };
      xj_set_absent: { Args: { p_submission: string; p_absent: boolean }; Returns: undefined };
      xj_pairwise_agreement: { Args: { p_event: string }; Returns: AgreementRow[] };
      xj_peer_claim: { Args: { p_event: string; p_submission?: string }; Returns: number };
      xj_peer_rate: {
        Args: { p_submission: string; p_scores: Record<string, number> };
        Returns: undefined;
      };
      xj_peer_mine: { Args: { p_event: string }; Returns: MyEntry[] };
      xj_peer_candidates: { Args: { p_event: string }; Returns: Candidate[] };
      xj_peer_summary: { Args: { p_event: string }; Returns: SummaryRow[] };
      xj_sheet: { Args: { p_round: string; p_include?: string }; Returns: SheetRow[] };
      xj_save_ballot: { Args: { p_round: string; p_order: string[] }; Returns: undefined };
      xj_allocate: { Args: { p_submission: string; p_points: number }; Returns: undefined };
      xj_judge_progress: { Args: { p_event: string }; Returns: ProgressRow[] };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export const client = () => browserClientFor<ExtraJudgingDatabase>();

/** Every query the plugin makes starts with this, so one invalidation refreshes them all. */
export const ROOT = "extra-judging";

/** The entry to compare with `submissionId`, null when this judge has seen every pairing. */
export const nextEntryQueryOptions = (submissionId: string) =>
  queryOptions({
    queryKey: [ROOT, "next", submissionId] as const,
    queryFn: async (): Promise<NextEntry | null> => {
      const { data, error } = await client().rpc("xj_pairwise_next", {
        p_submission: submissionId,
      });
      return unwrap(error ? toFailure(error, "finding the next project") : ok(data?.[0] ?? null));
    },
    // a fresh pick every visit, not a cached one
    gcTime: 0,
    retry: retryPolicy,
  });

export const agreementQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: [ROOT, "agreement", eventId] as const,
    queryFn: async (): Promise<AgreementRow[]> => {
      const { data, error } = await client().rpc("xj_pairwise_agreement", { p_event: eventId });
      return unwrap(error ? toFailure(error, "loading judge agreement") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

export const myEntriesQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: [ROOT, "mine", eventId] as const,
    queryFn: async (): Promise<MyEntry[]> => {
      const { data, error } = await client().rpc("xj_peer_mine", { p_event: eventId });
      return unwrap(error ? toFailure(error, "loading your projects") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

export const candidatesQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: [ROOT, "candidates", eventId] as const,
    queryFn: async (): Promise<Candidate[]> => {
      const { data, error } = await client().rpc("xj_peer_candidates", { p_event: eventId });
      return unwrap(error ? toFailure(error, "loading projects") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

export const summaryQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: [ROOT, "summary", eventId] as const,
    queryFn: async (): Promise<SummaryRow[]> => {
      const { data, error } = await client().rpc("xj_peer_summary", { p_event: eventId });
      return unwrap(error ? toFailure(error, "loading ratings") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

/** The caller's ballot or budget sheet for a round, with `include` on it even if unassigned. */
export const sheetQueryOptions = (roundId: string, include: string) =>
  queryOptions({
    queryKey: [ROOT, "sheet", roundId, include] as const,
    queryFn: async (): Promise<SheetRow[]> => {
      const { data, error } = await client().rpc("xj_sheet", {
        p_round: roundId,
        p_include: include,
      });
      return unwrap(error ? toFailure(error, "loading your projects") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

export const progressQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: [ROOT, "progress", eventId] as const,
    queryFn: async (): Promise<ProgressRow[]> => {
      const { data, error } = await client().rpc("xj_judge_progress", { p_event: eventId });
      return unwrap(error ? toFailure(error, "loading judges' progress") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

import { queryOptions } from "@tanstack/react-query";
import { browserClientFor } from "@bogey/db/browser";
import { ok, retryPolicy, toFailure, unwrap } from "@bogey/db/errors";

// ── the plugin's functions, as `supabase gen types` writes them for migrations/ ──

export type Task = {
  item_id: string;
  form_title: string;
  label: string;
  metric: string;
  daily_limit: number;
  has_answers: boolean;
  answer_rows: number;
};

export type Attempt = { attempt_id: string; public_score: number; created_at: string };

export type SubmitResult = { attempt_id: string; public_score: number; tries_left: number };

export type BoardRow = {
  rank: number;
  team_name: string;
  public_score: number;
  private_score: number | null;
  attempts: number;
  last_at: string;
};

export type LeaderboardDatabase = {
  public: {
    Tables: { [_ in never]: never };
    Views: { [_ in never]: never };
    Functions: {
      leaderboard_tasks: { Args: { p_event: string }; Returns: Task[] };
      leaderboard_my_attempts: { Args: { p_item: string }; Returns: Attempt[] };
      leaderboard_submit: { Args: { p_item: string; p_csv: string }; Returns: SubmitResult[] };
      leaderboard_set_answers: { Args: { p_item: string; p_csv: string }; Returns: number };
      leaderboard_board: { Args: { p_item: string }; Returns: BoardRow[] };
      leaderboard_refresh: { Args: { p_event: string }; Returns: undefined };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export const client = () => browserClientFor<LeaderboardDatabase>();

export const tasksQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: ["leaderboard", "tasks", eventId] as const,
    queryFn: async (): Promise<Task[]> => {
      const { data, error } = await client().rpc("leaderboard_tasks", { p_event: eventId });
      return unwrap(error ? toFailure(error, "loading tasks") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

export const attemptsQueryOptions = (itemId: string) =>
  queryOptions({
    queryKey: ["leaderboard", "attempts", itemId] as const,
    queryFn: async (): Promise<Attempt[]> => {
      const { data, error } = await client().rpc("leaderboard_my_attempts", { p_item: itemId });
      return unwrap(error ? toFailure(error, "loading your tries") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

export const boardQueryOptions = (itemId: string) =>
  queryOptions({
    queryKey: ["leaderboard", "board", itemId] as const,
    queryFn: async (): Promise<BoardRow[]> => {
      const { data, error } = await client().rpc("leaderboard_board", { p_item: itemId });
      return unwrap(error ? toFailure(error, "loading the leaderboard") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

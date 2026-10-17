import { queryOptions } from "@tanstack/react-query";
import { browserClientFor } from "@bogey/db/browser";
import { ok, retryPolicy, toFailure, unwrap } from "@bogey/db/errors";

// ── the plugin's schema, as `supabase gen types` writes it for migrations/ ──

export type Attestation = "extension" | "seb";
export type SebKeyKind = "config" | "browser_exam";

export type SessionRow = {
  event_id: string;
  user_id: string;
  started_at: string;
  heartbeat_at: string;
  extension_version: string | null;
  attested_at: string | null;
  attested_by: Attestation | null;
  violations: number;
  locked_at: string | null;
  fullscreen_at: string | null;
};

export type SebKeyRow = {
  id: string;
  event_id: string;
  kind: SebKeyKind;
  value: string;
  label: string;
  created_at: string;
};

type Table<Row> = { Row: Row; Insert: Row; Update: Partial<Row>; Relationships: [] };

export type LockdownDatabase = {
  public: {
    Tables: {
      lockdown_sessions: Table<SessionRow>;
      lockdown_seb_keys: Table<SebKeyRow>;
    };
    Views: { [_ in never]: never };
    Functions: {
      lockdown_heartbeat: {
        Args: {
          p_event: string;
          p_extension_version?: string;
          p_attested?: boolean;
          p_fullscreen?: boolean;
        };
        Returns: SessionRow;
      };
      lockdown_violation: {
        Args: { p_event: string; p_kind: string; p_meta?: { [key: string]: string | number } };
        Returns: SessionRow;
      };
      lockdown_unlock: { Args: { p_event: string; p_user: string }; Returns: undefined };
      lockdown_set_seb_keys: {
        Args: { p_event: string; p_keys: { kind: SebKeyKind; value: string; label: string }[] };
        Returns: number;
      };
      lockdown_check_seb: {
        Args: { p_event: string; p_url: string; p_request_hash: string; p_config_hash: string };
        Returns: boolean;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export const client = () => browserClientFor<LockdownDatabase>();

export const sessionsQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: ["lockdown", "sessions", eventId] as const,
    queryFn: async (): Promise<SessionRow[]> => {
      const { data, error } = await client()
        .from("lockdown_sessions")
        .select("*")
        .eq("event_id", eventId)
        .order("violations", { ascending: false });
      return unwrap(error ? toFailure(error, "loading lockdown sessions") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

// the signed-in participant's own row; RLS shows them no one else's
export const ownSessionQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: ["lockdown", "own", eventId] as const,
    queryFn: async (): Promise<SessionRow | null> => {
      const { data, error } = await client()
        .from("lockdown_sessions")
        .select("*")
        .eq("event_id", eventId)
        .maybeSingle();
      return unwrap(error ? toFailure(error, "loading your lockdown record") : ok(data));
    },
    retry: retryPolicy,
  });

/** The event's Safe Exam Browser keys; RLS shows them to proctors only. */
export const sebKeysQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: ["lockdown", "seb-keys", eventId] as const,
    queryFn: async (): Promise<SebKeyRow[]> => {
      const { data, error } = await client()
        .from("lockdown_seb_keys")
        .select("*")
        .eq("event_id", eventId)
        .order("created_at");
      return unwrap(error ? toFailure(error, "loading the keys") : ok(data ?? []));
    },
    retry: retryPolicy,
  });

export async function saveSebKeys(
  eventId: string,
  keys: { kind: SebKeyKind; value: string; label: string }[],
): Promise<number> {
  const { data, error } = await client().rpc("lockdown_set_seb_keys", {
    p_event: eventId,
    p_keys: keys,
  });
  return unwrap(error ? toFailure(error, "saving the keys") : ok(data));
}

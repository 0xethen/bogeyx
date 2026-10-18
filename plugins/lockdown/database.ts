import { queryOptions } from "@tanstack/react-query";
import { browserClientFor } from "@bogey/db/browser";
import { ok, retryPolicy, toFailure, unwrap } from "@bogey/db/errors";
import type { SebConfig } from "./seb-config.ts";

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

export type SebConfigRow = {
  event_id: string;
  config: { [key: string]: unknown };
  plist: string;
  config_key: string;
  token: string;
  updated_at: string;
};

type Table<Row> = { Row: Row; Insert: Row; Update: Partial<Row>; Relationships: [] };

export type LockdownDatabase = {
  public: {
    Tables: {
      lockdown_sessions: Table<SessionRow>;
      lockdown_seb_keys: Table<SebKeyRow>;
      lockdown_seb_configs: Table<SebConfigRow>;
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
      lockdown_save_seb_config: {
        Args: { p_event: string; p_config: SebConfig; p_plist: string; p_config_key: string };
        Returns: SebConfigRow;
      };
      lockdown_seb_link: { Args: { p_event: string }; Returns: string | null };
      lockdown_seb_file: { Args: { p_token: string }; Returns: string | null };
      lockdown_seb_ready: { Args: { p_event: string }; Returns: boolean };
      lockdown_seb_nonce: { Args: { p_event: string }; Returns: string };
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

/** The event's generated Safe Exam Browser configuration, for its organizers; null before the first save. */
export const sebConfigQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: ["lockdown", "seb-config", eventId] as const,
    queryFn: async (): Promise<SebConfigRow | null> => {
      const { data, error } = await client()
        .from("lockdown_seb_configs")
        .select("*")
        .eq("event_id", eventId)
        .maybeSingle();
      return unwrap(error ? toFailure(error, "loading the configuration") : ok(data));
    },
    retry: retryPolicy,
  });

export async function saveSebConfig(
  eventId: string,
  file: { config: SebConfig; plist: string; configKey: string },
): Promise<SebConfigRow> {
  const { data, error } = await client().rpc("lockdown_save_seb_config", {
    p_event: eventId,
    p_config: file.config,
    p_plist: file.plist,
    p_config_key: file.configKey,
  });
  return unwrap(error ? toFailure(error, "saving the configuration") : ok(data));
}

/** The token in the link that opens Safe Exam Browser; null while it isn't required or set up. */
export const sebLinkQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: ["lockdown", "seb-link", eventId] as const,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await client().rpc("lockdown_seb_link", { p_event: eventId });
      return unwrap(error ? toFailure(error, "loading the link") : ok(data));
    },
    retry: retryPolicy,
  });

/** A one-time nonce for the next Safe Exam Browser check, so a captured header can't be replayed. */
export async function sebNonce(eventId: string): Promise<string> {
  const { data, error } = await client().rpc("lockdown_seb_nonce", { p_event: eventId });
  return unwrap(error ? toFailure(error, "starting the check") : ok(data));
}

/** Whether Safe Exam Browser can pass the check at all: a generated file or a key exists. */
export const sebReadyQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: ["lockdown", "seb-ready", eventId] as const,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await client().rpc("lockdown_seb_ready", { p_event: eventId });
      return unwrap(error ? toFailure(error, "checking Safe Exam Browser's setup") : ok(data));
    },
    retry: retryPolicy,
  });

/** Where the `.seb` file for a token is served, under this site's address. */
export const sebFileUrl = (origin: string, token: string) =>
  `${origin}/api/x/lockdown/seb-config/${token}`;

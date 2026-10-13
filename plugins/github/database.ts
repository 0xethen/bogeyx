import { browserClientFor } from "@bogey/db/browser";

// the one core function the page calls, as `supabase gen types` writes it
export type GithubDatabase = {
  public: {
    Tables: { [_ in never]: never };
    Views: { [_ in never]: never };
    Functions: {
      log_event: {
        Args: { p_event: string; p_action: string; p_meta?: { [key: string]: string | number } };
        Returns: undefined;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export const client = () => browserClientFor<GithubDatabase>();

import { z } from "zod";

// How the lockdown page and the companion browser extension talk. Both sit in the same window, so
// they use `postMessage`. The page makes a nonce for the session and says hello with it; the extension
// answers with the nonce and its version, then keeps saying it is alive and reports what it sees.
// Anything on the page can send these messages, so this is a deterrent and a record, not proof.

export const PAGE_SOURCE = "bogey-lockdown";
export const COMPANION_SOURCE = "bogey-lockdown-companion";

/** Kinds the extension reports. The database accepts them as lockdown violation kinds. */
export const SIGNAL_KINDS = ["window_blur", "devtools", "new_window", "clipboard"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** Signals that count towards the limit; the rest are only written to the audit log. */
export const COUNTED: ReadonlySet<SignalKind> = new Set(["window_blur", "devtools", "new_window"]);

/** How long after its last message the extension still counts as there. */
export const ALIVE_MS = 45_000;

const CompanionMessage = z.discriminatedUnion("type", [
  z.object({
    source: z.literal(COMPANION_SOURCE),
    type: z.literal("attest"),
    nonce: z.string(),
    version: z.string().max(40),
  }),
  z.object({
    source: z.literal(COMPANION_SOURCE),
    type: z.literal("alive"),
    nonce: z.string(),
    version: z.string().max(40),
  }),
  z.object({
    source: z.literal(COMPANION_SOURCE),
    type: z.literal("signal"),
    nonce: z.string(),
    kind: z.enum(SIGNAL_KINDS),
  }),
]);

export type CompanionMessage = z.infer<typeof CompanionMessage>;

/** A message from the extension for this session, or null for anything else. */
export function parseCompanionMessage(data: unknown, nonce: string): CompanionMessage | null {
  const parsed = CompanionMessage.safeParse(data);
  return parsed.success && parsed.data.nonce === nonce ? parsed.data : null;
}

/** What the page sends to find the extension. */
export const hello = (nonce: string) => ({ source: PAGE_SOURCE, type: "hello", nonce }) as const;

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

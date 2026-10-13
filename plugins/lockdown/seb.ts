import type { PluginServerContext } from "@bogey/plugins/runtime";
import type { LockdownDatabase } from "./database.ts";

// `POST /seb-check?event=`: Safe Exam Browser adds a hash of the address it requested to every
// request. Only the server sees those headers, so this route hands them to the database, which
// compares them with the event's keys (the participant never gets to read the keys).

const REQUEST_HASH = "x-safeexambrowser-requesthash";
const CONFIG_HASH = "x-safeexambrowser-configkeyhash";

/**
 * The address the browser asked for. Behind a proxy `request.url` is the inside address, and SEB
 * hashed the outside one, so the forwarded scheme and host win.
 */
export function requestedUrl(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? request.headers.get("host");
  const origin = host
    ? `${proto === "http" || proto === "https" ? proto : url.protocol.replace(":", "")}://${host}`
    : url.origin;
  return `${origin}${url.pathname}${url.search}`;
}

export async function sebCheck(request: Request, ctx: PluginServerContext): Promise<Response> {
  if (!ctx.user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!ctx.eventId)
    return Response.json({ error: "Name the event with ?event=." }, { status: 400 });
  const { data, error } = await ctx.supabaseFor<LockdownDatabase>().rpc("lockdown_check_seb", {
    p_event: ctx.eventId,
    p_url: requestedUrl(request),
    p_request_hash: request.headers.get(REQUEST_HASH) ?? "",
    p_config_hash: request.headers.get(CONFIG_HASH) ?? "",
  });
  if (error) return Response.json({ error: "Couldn't check." }, { status: 403 });
  return Response.json({ attested: data });
}

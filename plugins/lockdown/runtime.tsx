import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconDeviceDesktop,
  IconLock,
  IconMaximize,
  IconPlugConnected,
  IconSettings,
} from "@tabler/icons-react";
import { browserClient } from "@bogey/db/browser";
import { ok, toFailure, unwrap } from "@bogey/db/errors";
import { can, useEventAccess } from "@bogey/db/permissions";
import { useLiveInvalidate } from "@bogey/db/realtime";
import { eventPeopleQueryOptions } from "@bogey/db/queries/manage";
import { eventWindowsQueryOptions, isWindowOpen, windowByKey } from "@bogey/db/queries/windows";
import { pluginWindow } from "@bogey/plugins/api";
import { definePluginRuntime, type PluginContext } from "@bogey/plugins/runtime";
import type { SettingsOf } from "@bogey/plugins/types";
import { Alert, AlertDescription, AlertTitle } from "@bogey/ui/components/alert";
import { Badge } from "@bogey/ui/components/badge";
import { Button } from "@bogey/ui/components/button";
import { ErrorAlert } from "@bogey/ui/components/error-alert";
import { RelativeTime } from "@bogey/ui/components/relative-time";
import { Screen } from "@bogey/ui/components/screen";
import { useExternalValue } from "@bogey/ui/hooks/external";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@bogey/ui/components/table";
import {
  ALIVE_MS,
  COUNTED,
  hello,
  newNonce,
  parseCompanionMessage,
  type SignalKind,
} from "./companion.ts";
import {
  client,
  ownSessionQueryOptions,
  sessionsQueryOptions,
  type SessionRow,
} from "./database.ts";
import { manifest } from "./manifest.ts";
import { SebKeys } from "./seb-keys.tsx";
import { Link as RouterLink, useParams } from "@tanstack/react-router";

type Settings = SettingsOf<typeof manifest>;

const ARMED = pluginWindow(manifest, "armed");

/** Fills `{times}`, `{count}` and `{max}` in a message an organizer wrote. */
function fill(template: string, values: { count: number; max: number | null }): string {
  const times = values.count === 1 ? "once" : `${values.count} times`;
  return template
    .replaceAll("{times}", times)
    .replaceAll("{count}", String(values.count))
    .replaceAll("{max}", values.max === null ? "" : String(values.max));
}

// ── the wrapper ─────────────────────────────────────────────────────────────

/** Coarse pointer and touch is as close as a browser gets to "phone or tablet". */
const isMobile = () =>
  window.matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 1;
const never = () => () => undefined;

const inFullscreen = () => Boolean(document.fullscreenElement);
function onFullscreenChange(change: () => void) {
  document.addEventListener("fullscreenchange", change);
  return () => document.removeEventListener("fullscreenchange", change);
}

/** Around the event's pages for participants while the Lockdown window is open. */
function Lockdown({
  eventId,
  settings,
  children,
}: PluginContext<Settings> & { children: ReactNode }) {
  const access = useEventAccess();
  const windows = useQuery(eventWindowsQueryOptions(eventId));
  const armed =
    settings.mode !== "off" &&
    access?.role === "participant" &&
    (settings.during === "always" || isWindowOpen(windowByKey(windows.data ?? [], ARMED)));
  return armed ? (
    <Armed eventId={eventId} settings={settings}>
      {children}
    </Armed>
  ) : (
    children
  );
}

/** Talks to the companion extension, when the browser has one: whether it is there, and what it sees. */
function useCompanion(onSignal: (kind: SignalKind) => void) {
  const nonce = useRef(newNonce());
  const handler = useRef(onSignal);
  const [seen, setSeen] = useState<{ at: number; version: string | null }>({
    at: 0,
    version: null,
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    handler.current = onSignal;
  });

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.source !== window) return;
      const message = parseCompanionMessage(event.data, nonce.current);
      if (!message) return;
      if (message.type === "signal") handler.current(message.kind);
      else setSeen({ at: Date.now(), version: message.version });
    };
    const knock = () => window.postMessage(hello(nonce.current), window.location.origin);
    window.addEventListener("message", listen);
    knock();
    // the extension may load after the page, and a stale answer should fade
    const timer = window.setInterval(() => {
      knock();
      setNow(Date.now());
    }, 10_000);
    return () => {
      window.removeEventListener("message", listen);
      window.clearInterval(timer);
    };
  }, []);

  return { present: seen.at > 0 && now - seen.at < ALIVE_MS, version: seen.version };
}

/** Asks the server whether Safe Exam Browser's headers match a key, every minute. */
function useSeb(eventId: string, on: boolean) {
  const [attested, setAttested] = useState<boolean | null>(null);
  useEffect(() => {
    if (!on) return;
    const check = () =>
      void fetch(`/api/x/lockdown/seb-check?event=${eventId}`, { method: "POST" })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: unknown) => {
          const attestedNow =
            typeof body === "object" &&
            body !== null &&
            "attested" in body &&
            body.attested === true;
          setAttested(attestedNow);
        })
        .catch(() => setAttested(false));
    check();
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [eventId, on]);
  return attested;
}

function Armed({
  eventId,
  settings,
  children,
}: {
  eventId: string;
  settings: Settings;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  // the server renders the page covered and the browser then says, so the event never shows
  // for a moment before the cover goes up
  const mobile = useExternalValue(never, isMobile, true);
  const fullscreen = useExternalValue(onFullscreenChange, inFullscreen, false);
  const own = useQuery(ownSessionQueryOptions(eventId));
  // organizers stopping, or letting someone back in, reach their page at once
  useLiveInvalidate("lockdown_sessions", ownSessionQueryOptions(eventId).queryKey, {
    filter: `event_id=eq.${eventId}`,
  });
  const session = own.data ?? null;

  const keep = (row: SessionRow | null) =>
    queryClient.setQueryData(ownSessionQueryOptions(eventId).queryKey, row);
  const record = (kind: string) =>
    void client()
      .rpc("lockdown_violation", { p_event: eventId, p_kind: kind })
      .then(({ data }) => data && keep(data));
  const companion = useCompanion((kind) => {
    if (COUNTED.has(kind)) record(kind);
    // copying from the page is normal, so it is written down and not counted
    else void browserClient().rpc("log_event", { p_event: eventId, p_action: `lockdown.${kind}` });
  });
  const requires = settings.mode === "enforce" ? settings.require : "none";
  const seb = useSeb(eventId, requires === "seb");

  const attestation = useRef({ present: companion.present, version: companion.version });
  useEffect(() => {
    attestation.current = { present: companion.present, version: companion.version };
  });
  const beat = () =>
    void client()
      .rpc("lockdown_heartbeat", {
        p_event: eventId,
        p_extension_version: attestation.current.version ?? undefined,
        p_attested: attestation.current.present,
      })
      .then(({ data }) => data && keep(data));

  useEffect(() => {
    beat();
    const heartbeat = window.setInterval(beat, 60_000);

    const onVisibility = () => {
      if (document.visibilityState === "hidden") record("tab_switch");
    };
    const onFullscreen = () => {
      if (!document.fullscreenElement) record("fullscreen_exit");
    };
    const onContextMenu = () => record("inspect_menu");
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("fullscreenchange", onFullscreen);
      document.removeEventListener("contextmenu", onContextMenu);
    };
    // the handlers read only stable things; re-subscribing on each render would repeat the heartbeat
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // the extension turning up, or going quiet, reaches the database without waiting for the minute
  useEffect(() => {
    beat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companion.present]);

  const max = settings.mode === "enforce" ? settings.maxViolations : null;
  const violations = session?.violations ?? 0;
  const stopped = Boolean(session?.locked_at);
  const text = { count: violations, max };

  if (settings.desktopOnly && mobile) {
    return (
      <Screen.Fallback
        icon={<IconDeviceDesktop />}
        title="Use a laptop or desktop"
        description="This part of the event runs in lockdown, which a phone or tablet browser can't enter."
      />
    );
  }

  // Until we know whether they're stopped, a cover that hides the event can't show it to
  // someone who is.
  if (settings.mode === "enforce" && settings.whenStopped === "cover") {
    if (own.isPending) {
      return <Screen.Fallback icon={<IconLock />} title="Checking..." description="One moment." />;
    }
    if (stopped) {
      return (
        <Screen.Fallback
          icon={<IconLock />}
          title={fill(settings.blockedTitle, text)}
          description={fill(settings.blockedBody, text)}
        />
      );
    }
  }

  if (requires === "seb" && seb !== true) {
    return (
      <Screen.Fallback
        icon={<IconLock />}
        title={seb === null ? "Checking..." : "Open this event in Safe Exam Browser"}
        description={
          seb === null
            ? "One moment."
            : "Organizers require Safe Exam Browser for this part of the event. Open the event from it with the exam configuration they gave you."
        }
      />
    );
  }

  if (requires === "extension" && !companion.present) {
    return (
      <Screen.Fallback
        icon={<IconPlugConnected />}
        title="Install the lockdown extension"
        description="Organizers require the Bogey lockdown companion extension for this part of the event. Install it in Chrome or another Chromium browser, then reload this page."
      />
    );
  }

  if (settings.requireFullscreen && !fullscreen) {
    return (
      <Screen.Fallback
        icon={<IconMaximize />}
        title="Full screen, please"
        description="Organizers have locked this part of the event. Entering full screen opens it; leaving full screen or switching tabs is recorded."
      >
        <Button
          onClick={() => {
            // a refusal leaves this screen up rather than pretending it worked
            void document.documentElement.requestFullscreen().catch(() => undefined);
          }}
        >
          Enter full screen
        </Button>
      </Screen.Fallback>
    );
  }

  return (
    <>
      {stopped ? (
        <Alert variant="destructive" className="rounded-none">
          <AlertTitle>{fill(settings.blockedTitle, text)}</AlertTitle>
          <AlertDescription>{fill(settings.blockedBody, text)}</AlertDescription>
        </Alert>
      ) : (
        violations > 0 && (
          // a new violation shows it again
          <Alert key={violations} dismissable className="rounded-none">
            <AlertTitle>{fill(settings.leaveTitle, text)}</AlertTitle>
            <AlertDescription>{fill(settings.leaveBody, text)}</AlertDescription>
          </Alert>
        )
      )}
      {children}
    </>
  );
}

// ── proctor ─────────────────────────────────────────────────────────────────

function Proctor({ eventId, settings }: PluginContext<Settings>) {
  const queryClient = useQueryClient();
  const sessions = useQuery(sessionsQueryOptions(eventId));
  // someone leaving the page shows up as it happens
  useLiveInvalidate("lockdown_sessions", sessionsQueryOptions(eventId).queryKey, {
    filter: `event_id=eq.${eventId}`,
  });
  const people = useQuery(eventPeopleQueryOptions(eventId));
  const names = new Map((people.data?.members ?? []).map((member) => [member.userId, member.name]));
  const unlock = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await client().rpc("lockdown_unlock", { p_event: eventId, p_user: userId });
      return unwrap(error ? toFailure(error, "letting them back in") : ok(null));
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: sessionsQueryOptions(eventId).queryKey }),
  });
  const rows = sessions.data ?? [];
  const { slug = "" } = useParams({ strict: false });
  const access = useEventAccess();

  return (
    <Screen
      title="Lockdown"
      actions={
        can(access, "event.manage") && (
          <>
            <Button
              size="sm"
              variant="ghost"
              render={<RouterLink to="/events/$slug/manage/plugins" params={{ slug }} />}
              nativeButton={false}
            >
              <IconSettings /> Manage
            </Button>
          </>
        )
      }
      description={
        settings.mode === "off"
          ? "Lockdown is off for this event. Turn it on in Manage → Extensions."
          : "View who has the event open under lockdown."
      }
    >
      <ErrorAlert error={unlock.error} title="Couldn't let them back in" />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-fg">No one has opened the event in lockdown yet.</p>
      ) : (
        <>
          <p className="text-sm text-muted-fg">
            Clicked notifications and dropped connections count towards the violation limit. If
            someone is stopped, you can let them back in.
          </p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Participant</TableHead>
                  <TableHead className="text-right">Times left</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.user_id}>
                    <TableCell className="font-medium">
                      {names.get(row.user_id) ?? "Someone"}
                      {row.locked_at && (
                        <Badge variant="destructive" className="ml-2">
                          Stopped
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.violations}
                    </TableCell>
                    <TableCell className="text-muted-fg">
                      <RelativeTime value={row.heartbeat_at} />
                    </TableCell>
                    <TableCell className="text-right">
                      {(row.locked_at || row.violations > 0) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={unlock.isPending}
                          confirm={{
                            title: `Reset ${names.get(row.user_id) ? `${names.get(row.user_id)}'s` : "their"} lockdown record?`,
                            description:
                              "Submissions will unlock and their count will go back to zero.",
                            label: "Reset",
                          }}
                          onClick={() => unlock.mutate(row.user_id)}
                        >
                          {row.locked_at ? "Unlock" : "Reset"}...
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      {settings.require === "seb" && <SebKeys eventId={eventId} />}
    </Screen>
  );
}

export default definePluginRuntime(manifest, {
  routes: { "/proctor": Proctor },
  serverRoutes: {
    "POST /seb-check": async (request, ctx) => (await import("./seb.ts")).sebCheck(request, ctx),
  },
  slots: { eventWrapper: Lockdown },
});

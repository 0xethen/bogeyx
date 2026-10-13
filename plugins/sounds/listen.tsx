import { useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { browserClient } from "@bogey/db/browser";
import {
  eventWindowsQueryOptions,
  isWindowOpen,
  type EventWindow,
} from "@bogey/db/queries/windows";
import type { PluginContext } from "@bogey/plugins/runtime";
import { onSignal } from "@bogey/plugins/signals";
import {
  eventTimesQueryOptions,
  setupQueryOptions,
  type EffectChoice,
  type Setup,
} from "./database.ts";
import { engine } from "./engine.ts";
import { effectFor, planCues, type Effect, type Timeline } from "./schedule.ts";
import { ApplyLevels, backgroundOf, signals, type Settings } from "./shared.tsx";

const NO_EFFECTS: Tuple<EffectChoice> = [];

function effectMap(effects: Tuple<EffectChoice>): ReadonlyMap<string, Effect> {
  return new Map(effects.map((effect) => [effect.signal, effect]));
}

/** Plays each signal's effect while the event is open. Signals from other events are ignored. */
function useEffects(eventId: string, enabled: boolean, chosen: ReadonlyMap<string, Effect>) {
  useEffect(() => {
    if (!enabled) return;
    return onSignal((signal) => {
      if (signal.eventId !== null && signal.eventId !== eventId) return;
      engine.effect(effectFor(signal.key, chosen));
    });
  }, [eventId, enabled, chosen]);
}

/** Signals each new message someone else writes in a conversation the person can read. */
function useMessageSignals(eventId: string, enabled: boolean, userId: string) {
  const id = useId();
  useEffect(() => {
    if (!enabled) return;
    const supabase = browserClient();
    // RLS decides which messages reach this person, as it does for the page
    const channel = supabase
      .channel(`sounds:messages:${eventId}:${id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "clarification_messages",
          filter: `event_id=eq.${eventId}`,
        },
        (change) => {
          const author: unknown = change.new["author_id"];
          if (author !== userId) signals.emit("message-received", eventId);
        },
      )
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [eventId, enabled, userId, id]);
}

/** Signals windows opening and closing, by the clock or by an organizer. */
function useWindowSignals(
  eventId: string,
  windows: Tuple<EventWindow> | undefined,
  enabled: boolean,
) {
  const states = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    if (!windows || !enabled) return;
    const check = () => {
      const now = new Date();
      const next = new Map(windows.map((window) => [window.key, isWindowOpen(window, now)]));
      const before = states.current;
      states.current = next;
      if (!before) return;
      for (const [key, open] of next) {
        const was = before.get(key);
        if (was !== undefined && was !== open) {
          signals.emit(open ? "window-opened" : "window-closed", eventId);
        }
      }
    };
    check();
    // windows open on a clock, not only when the row changes
    const timer = window.setInterval(check, 5_000);
    return () => window.clearInterval(timer);
  }, [eventId, windows, enabled]);
}

/** Hands the engine the library and the cues, timed from the event's schedule. */
function useLibraryAndCues(setup: Setup | undefined, timeline: Timeline | null, cuesOn: boolean) {
  useEffect(() => {
    if (!setup) return;
    engine.setLibrary(setup.files);
    engine.setCues(cuesOn && timeline ? planCues(setup.cues, timeline, engine.lengthOf) : []);
  }, [setup, timeline, cuesOn]);
}

/** Listens while the event is open, keeps cues in time, and plays the background music. */
export function SoundsWrapper({
  eventId,
  settings,
  session,
  children,
}: PluginContext<Settings> & { children: ReactNode }) {
  const userId = session.user.id;
  const setup = useQuery(setupQueryOptions(eventId));
  const times = useQuery({ ...eventTimesQueryOptions(eventId), enabled: settings.cues });
  const chosen = useMemo(() => effectMap(setup.data?.effects ?? NO_EFFECTS), [setup.data]);

  // watch for what Sounds notices itself only when it would make a sound
  const audible = (signal: string) => settings.effects && effectFor(signal, chosen).sound !== null;
  const watchWindows = audible("sounds.window-opened") || audible("sounds.window-closed");
  const windows = useQuery({
    ...eventWindowsQueryOptions(eventId),
    enabled: settings.cues || watchWindows,
  });

  useEffects(eventId, settings.effects, chosen);
  useMessageSignals(eventId, audible("sounds.message-received"), userId);
  useWindowSignals(eventId, windows.data, watchWindows);

  const timeline = useMemo<Timeline | null>(
    () =>
      times.data && windows.data
        ? { eventStart: times.data.startsAt, eventEnd: times.data.endsAt, windows: windows.data }
        : null,
    [times.data, windows.data],
  );
  useLibraryAndCues(setup.data, timeline, settings.cues);

  const background = useMemo(
    () => backgroundOf(settings, setup.data?.files ?? []),
    [settings, setup.data],
  );
  // organizers chose it, so it starts by itself; the browser holds it until the first click or key
  useEffect(() => {
    engine.setBackground(background);
    if (background && !engine.state.playing) engine.startBackground();
  }, [background]);

  // nothing keeps playing once the person leaves the event
  useEffect(
    () => () => {
      engine.setCues([]);
      engine.stopBackground();
    },
    [],
  );

  return (
    <>
      <ApplyLevels settings={settings} />
      {children}
    </>
  );
}

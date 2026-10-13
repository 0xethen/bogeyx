// What plays when: which sound each signal gets, and when each cue starts, worked out from the
// event's schedule. No browser APIs, so it's tested on its own.

/** The sounds Sounds synthesizes itself, so it works with nothing uploaded. */
export const BUILTINS = [
  "chime",
  "alert",
  "pop",
  "rise",
  "fall",
  "tick",
  "success",
  "error",
  "fanfare",
] as const;
export type Builtin = (typeof BUILTINS)[number];

/** How long each built-in rings, for cues that end at a time. */
export const BUILTIN_MS: Record<Builtin, number> = {
  chime: 1400,
  alert: 1300,
  pop: 450,
  rise: 1050,
  fall: 1050,
  tick: 1900,
  success: 1100,
  error: 800,
  fanfare: 2400,
};

export const BUILTIN_LABELS: Record<Builtin, string> = {
  chime: "Chime",
  alert: "Alert",
  pop: "Pop",
  rise: "Rising fifth",
  fall: "Falling fifth",
  tick: "Ticking clock",
  success: "Success",
  error: "Buzz",
  fanfare: "Fanfare",
};

export function isBuiltin(value: string): value is Builtin {
  return (BUILTINS as Tuple<string>).includes(value);
}

/** A sound to play: one of the built-ins, or an upload by its id. */
export type SoundRef = { kind: "builtin"; name: Builtin } | { kind: "file"; id: string };

// ── effects ──────────────────────────────────────────────────────────────

/** What a signal plays when no organizer changed it. Signals not listed are silent. */
export const DEFAULT_EFFECTS: Record<string, Builtin> = {
  "announcement.posted": "chime",
  "announcement.urgent": "alert",
  "notification.received": "pop",
  "sounds.message-received": "pop",
  // "sounds.window-opened": "rise",
  // "sounds.window-closed": "fall",
  "challenges.accepted": "success",
  "challenges.rejected": "error",
  "challenges.flag-correct": "success",
  "challenges.flag-wrong": "error",
};

/** An organizer's choice for one signal: a sound, or `null` for silence. */
export interface Effect {
  sound: SoundRef | null;
  /** 0 to 100, on top of the person's own level. */
  volume: number;
}

/** What `signal` plays: the organizer's choice, else the default, else nothing. */
export function effectFor(signal: string, chosen: ReadonlyMap<string, Effect>): Effect {
  const own = chosen.get(signal);
  if (own) return own;
  const builtin = DEFAULT_EFFECTS[signal];
  return { sound: builtin ? { kind: "builtin", name: builtin } : null, volume: 100 };
}

// ── cues ─────────────────────────────────────────────────────────────────

export const ANCHORS = ["event.start", "event.end", "window.open", "window.close", "time"] as const;
export type Anchor = (typeof ANCHORS)[number];

export interface Cue {
  id: string;
  label: string;
  sound: SoundRef;
  anchor: Anchor;
  /** For the window anchors. */
  windowKey: string | null;
  /** For `time`: an ISO timestamp. */
  at: string | null;
  /** Later when positive, earlier when negative. */
  offsetSeconds: number;
  /** `start`: the sound starts at the time. `end`: it finishes then, starting its length earlier. */
  align: "start" | "end";
  /** `music` pauses background music and follows the music level; `effect` plays over it. */
  channel: "music" | "effect";
  /** Whether people who arrive partway through still hear the rest, in step with everyone else. */
  joinLate: boolean;
  volume: number;
}

/** The times cues are worked out from. Windows only count with a time; one opened by hand has none. */
export interface Timeline {
  eventStart: string | null;
  eventEnd: string | null;
  windows: Tuple<{ key: string; opens_at: string | null; closes_at: string | null }>;
}

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

/** The moment a cue is pinned to, before its offset, or null when the schedule doesn't say. */
export function anchorTime(cue: Pick<Cue, "anchor" | "windowKey" | "at">, timeline: Timeline) {
  switch (cue.anchor) {
    case "event.start":
      return time(timeline.eventStart);
    case "event.end":
      return time(timeline.eventEnd);
    case "time":
      return time(cue.at);
    case "window.open":
    case "window.close": {
      const window = timeline.windows.find((each) => each.key === cue.windowKey);
      return time(cue.anchor === "window.open" ? window?.opens_at : window?.closes_at);
    }
  }
}

export interface PlannedCue {
  cue: Cue;
  startsAt: number;
  endsAt: number;
}

/** When a cue starts and ends, in epoch ms. Null without a time, or for a sound whose length isn't known. */
export function planCue(
  cue: Cue,
  timeline: Timeline,
  lengthOf: (sound: SoundRef) => number | null,
): PlannedCue | null {
  const anchor = anchorTime(cue, timeline);
  const length = lengthOf(cue.sound);
  if (anchor === null || length === null) return null;
  const target = anchor + cue.offsetSeconds * 1000;
  const startsAt = cue.align === "end" ? target - length : target;
  return { cue, startsAt, endsAt: startsAt + length };
}

/** Every cue that has a time, soonest first. */
export function planCues(
  cues: Tuple<Cue>,
  timeline: Timeline,
  lengthOf: (sound: SoundRef) => number | null,
): PlannedCue[] {
  return cues
    .map((cue) => planCue(cue, timeline, lengthOf))
    .filter((plan): plan is PlannedCue => plan !== null)
    .sort((a, b) => a.startsAt - b.startsAt);
}

/** How late a cue can start and still play from the top, for one that doesn't join late. */
export const LATE_GRACE_MS = 2000;

export type CueAction =
  | { kind: "wait"; inMs: number }
  | { kind: "play"; fromMs: number }
  | { kind: "done" };

/** What to do about a cue at `now`: wait for it, play it from a point, or let it go. */
export function cueAction(plan: PlannedCue, now: number): CueAction {
  if (now < plan.startsAt) return { kind: "wait", inMs: plan.startsAt - now };
  if (now >= plan.endsAt) return { kind: "done" };
  const into = now - plan.startsAt;
  if (into <= LATE_GRACE_MS) return { kind: "play", fromMs: 0 };
  return plan.cue.joinLate ? { kind: "play", fromMs: into } : { kind: "done" };
}

/** "5 minutes before", "at", "30 seconds after": the offset in words. */
export function describeOffset(seconds: number): string {
  if (seconds === 0) return "at";
  const size = Math.abs(seconds);
  const amount =
    size % 3600 === 0
      ? plural(size / 3600, "hour")
      : size % 60 === 0
        ? plural(size / 60, "minute")
        : plural(size, "second");
  return `${amount} ${seconds < 0 ? "before" : "after"}`;
}

function plural(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

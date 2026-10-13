import { queryOptions } from "@tanstack/react-query";
import { browserClient, browserClientFor } from "@bogey/db/browser";
import { fail, ok, retryPolicy, toFailure, unwrap, type DbResult } from "@bogey/db/errors";
import {
  ANCHORS,
  isBuiltin,
  type Anchor,
  type Builtin,
  type Cue,
  type Effect,
  type SoundRef,
} from "./schedule.ts";

// Everything here reads and writes as the signed-in person, so RLS and the extension's RPCs
// decide what each one gets.

// ── the extension's schema, as `supabase gen types` writes it for migrations/ ──

type FileRow = {
  id: string;
  event_id: string;
  name: string;
  /** Set for an upload; a linked sound has `link` instead. */
  storage_path: string | null;
  link: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  duration_ms: number;
  preload: boolean;
  playlist_position: number | null;
  created_by: string | null;
  created_at: string;
};

type EffectRow = {
  event_id: string;
  signal: string;
  file_id: string | null;
  builtin: string | null;
  volume: number;
};

type CueRow = {
  id: string;
  event_id: string;
  label: string;
  file_id: string | null;
  builtin: string | null;
  anchor: string;
  window_key: string | null;
  at: string | null;
  offset_seconds: number;
  align: string;
  channel: string;
  join_late: boolean;
  volume: number;
  sort: number;
};

type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] };

type FileChange = Pick<FileRow, "id" | "name" | "preload" | "playlist_position">;
type EffectChange = Pick<EffectRow, "signal" | "file_id" | "builtin" | "volume">;
type CueChange = Omit<CueRow, "event_id" | "sort">;

export type SoundsDatabase = {
  public: {
    Tables: {
      sounds_files: Table<FileRow>;
      sounds_effects: Table<EffectRow>;
      sounds_cues: Table<CueRow>;
    };
    Views: { [_ in never]: never };
    Functions: {
      sounds_add_file: {
        Args: {
          p_event: string;
          p_name: string;
          p_path: string;
          p_mime: string;
          p_size: number;
          p_duration_ms: number;
        };
        Returns: string;
      };
      sounds_link_file: {
        Args: { p_event: string; p_name: string; p_link: string; p_duration_ms: number };
        Returns: string;
      };
      /** The upload's path, or null for a linked sound. */
      sounds_remove_file: { Args: { p_file: string }; Returns: string | null };
      sounds_save_setup: {
        Args: {
          p_event: string;
          p_files: FileChange[];
          p_effects: EffectChange[];
          p_cues: CueChange[];
        };
        Returns: undefined;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

const client = () => browserClientFor<SoundsDatabase>();

const BUCKET = "sounds";

// ── what the app works with ─────────────────────────────────────────────

export interface SoundFile {
  id: string;
  name: string;
  url: string;
  /** Plays from a web address someone added, instead of an upload. */
  linked: boolean;
  /** Null for a linked sound. */
  sizeBytes: number | null;
  durationMs: number;
  preload: boolean;
  /** Its place in the background playlist, or null when it isn't in it. */
  playlistPosition: number | null;
}

export interface EffectChoice extends Effect {
  signal: string;
}

export interface Setup {
  files: SoundFile[];
  effects: EffectChoice[];
  cues: Cue[];
}

function soundOf(fileId: string | null, builtin: string | null): SoundRef | null {
  if (fileId) return { kind: "file", id: fileId };
  if (builtin && isBuiltin(builtin)) return { kind: "builtin", name: builtin };
  return null;
}

const isAnchor = (value: string): value is Anchor => (ANCHORS as Tuple<string>).includes(value);

function cueOf(row: CueRow): Cue | null {
  const sound = soundOf(row.file_id, row.builtin);
  if (!sound || !isAnchor(row.anchor)) return null;
  return {
    id: row.id,
    label: row.label,
    sound,
    anchor: row.anchor,
    windowKey: row.window_key,
    at: row.at,
    offsetSeconds: row.offset_seconds,
    align: row.align === "end" ? "end" : "start",
    channel: row.channel === "effect" ? "effect" : "music",
    joinLate: row.join_late,
    volume: row.volume,
  };
}

async function loadSetup(eventId: string): Promise<DbResult<Setup>> {
  const db = client();
  const [files, effects, cues] = await Promise.all([
    db.from("sounds_files").select("*").eq("event_id", eventId).order("created_at"),
    db.from("sounds_effects").select("*").eq("event_id", eventId),
    db.from("sounds_cues").select("*").eq("event_id", eventId).order("sort"),
  ]);
  const error = files.error ?? effects.error ?? cues.error;
  if (error) return toFailure(error, "loading the event's sounds");
  const storage = browserClient().storage.from(BUCKET);
  return ok({
    files: (files.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      url: row.link ?? storage.getPublicUrl(row.storage_path ?? "").data.publicUrl,
      linked: row.link !== null,
      sizeBytes: row.size_bytes,
      durationMs: row.duration_ms,
      preload: row.preload,
      playlistPosition: row.playlist_position,
    })),
    effects: (effects.data ?? []).map((row) => ({
      signal: row.signal,
      // a row whose built-in this version doesn't know is silent rather than wrong
      sound: row.builtin === "none" ? null : soundOf(row.file_id, row.builtin),
      volume: row.volume,
    })),
    cues: (cues.data ?? []).map(cueOf).filter((cue): cue is Cue => cue !== null),
  });
}

export const setupQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: ["sounds", "setup", eventId] as const,
    queryFn: async () => unwrap(await loadSetup(eventId)),
    retry: retryPolicy,
  });

export interface EventTimes {
  startsAt: string | null;
  endsAt: string | null;
  timeZone: string;
}

export const eventTimesQueryOptions = (eventId: string) =>
  queryOptions({
    queryKey: ["sounds", "event-times", eventId] as const,
    queryFn: async (): Promise<EventTimes> => {
      const { data, error } = await browserClient()
        .from("events")
        .select("starts_at, ends_at, timezone")
        .eq("id", eventId)
        .maybeSingle();
      const result = error
        ? toFailure(error, "loading the event's times")
        : ok({
            startsAt: data?.starts_at ?? null,
            endsAt: data?.ends_at ?? null,
            timeZone: data?.timezone ?? "UTC",
          });
      return unwrap(result);
    },
    retry: retryPolicy,
  });

// ── changes ─────────────────────────────────────────────────────────────

/**
 * How long an audio file or address plays, read by the browser; null when it can't play it, or
 * when it never ends (a live stream).
 */
export function measureDuration(source: Blob | string): Promise<number | null> {
  return new Promise((resolve) => {
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    const audio = new Audio();
    // a host that never answers is as good as no sound
    const timer = setTimeout(() => done(null), 15_000);
    const done = (value: number | null) => {
      clearTimeout(timer);
      if (typeof source !== "string") URL.revokeObjectURL(url);
      audio.removeAttribute("src");
      resolve(value);
    };
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () =>
      done(
        Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.round(audio.duration * 1000)
          : null,
      ),
    );
    audio.addEventListener("error", () => done(null));
    audio.src = url;
  });
}

const EXTENSION = /\.([a-z0-9]{1,5})$/i;

/** Uploads a file and adds it to the event's library. */
export async function uploadSound(eventId: string, file: File): Promise<DbResult<string>> {
  if (!file.type.startsWith("audio/"))
    return fail("invalid", `"${file.name}" isn't an audio file.`);
  const durationMs = await measureDuration(file);
  if (durationMs === null) {
    return fail("invalid", `This browser can't play "${file.name}", so nobody else's may either.`);
  }
  const extension = EXTENSION.exec(file.name)?.[1]?.toLowerCase() ?? "audio";
  const path = `${eventId}/${crypto.randomUUID()}.${extension}`;
  const storage = browserClient().storage.from(BUCKET);
  const uploaded = await storage.upload(path, file, {
    contentType: file.type,
    // the path is new for every upload, so browsers and CDNs can keep it for good
    cacheControl: "31536000",
  });
  if (uploaded.error) return toFailure(uploaded.error, `uploading "${file.name}"`);
  const name = file.name.replace(EXTENSION, "").slice(0, 120) || "Sound";
  const { data, error } = await client().rpc("sounds_add_file", {
    p_event: eventId,
    p_name: name,
    p_path: path,
    p_mime: file.type,
    p_size: file.size,
    p_duration_ms: durationMs,
  });
  if (error) {
    await storage.remove([path]);
    return toFailure(error, `adding "${file.name}"`);
  }
  return ok(data);
}

/** Why an address can't be a linked sound, or null. */
export function linkProblem(link: string): string | null {
  try {
    const url = new URL(link.trim());
    if (url.protocol !== "https:") return "Use an address that starts with https://";
  } catch {
    return "That isn't a web address";
  }
  return link.trim().length > 2000 ? "That address is too long" : null;
}

/** Adds a sound that plays from a web address, after checking the browser can play it. */
export async function linkSound(
  eventId: string,
  link: string,
  name: string,
): Promise<DbResult<string>> {
  const problem = linkProblem(link);
  if (problem) return fail("invalid", problem);
  const address = new URL(link.trim()).href;
  const durationMs = await measureDuration(address);
  if (durationMs === null) {
    return fail(
      "invalid",
      "This browser can't play that address. It needs to be an audio file (not a page that plays one), and a live stream belongs under Background music instead.",
    );
  }
  const fallback = decodeURIComponent(new URL(address).pathname.split("/").pop() ?? "");
  const { data, error } = await client().rpc("sounds_link_file", {
    p_event: eventId,
    p_name: (name.trim() || fallback.replace(EXTENSION, "") || "Sound").slice(0, 120),
    p_link: address,
    p_duration_ms: durationMs,
  });
  if (error) return toFailure(error, "adding the sound");
  return ok(data);
}

/** Removes a sound, and the effects and cues that used it. */
export async function removeSound(id: string): Promise<DbResult<null>> {
  const { data: path, error } = await client().rpc("sounds_remove_file", { p_file: id });
  if (error) return toFailure(error, "removing the sound");
  // the row is gone, so a file left behind is only wasted space; a link left nothing behind
  if (path) await browserClient().storage.from(BUCKET).remove([path]);
  return ok(null);
}

function columnsOf(sound: SoundRef | null): {
  file_id: string | null;
  builtin: Builtin | "none" | null;
} {
  if (!sound) return { file_id: null, builtin: "none" };
  return sound.kind === "file"
    ? { file_id: sound.id, builtin: null }
    : { file_id: null, builtin: sound.name };
}

/** Saves the library's details, every effect and every cue, as one change. */
export async function saveSetup(eventId: string, setup: Setup): Promise<DbResult<null>> {
  const { error } = await client().rpc("sounds_save_setup", {
    p_event: eventId,
    p_files: setup.files.map((file) => ({
      id: file.id,
      name: file.name,
      preload: file.preload,
      playlist_position: file.playlistPosition,
    })),
    p_effects: setup.effects.map((effect) => ({
      signal: effect.signal,
      volume: effect.volume,
      ...columnsOf(effect.sound),
    })),
    p_cues: setup.cues.map((cue) => {
      const sound = columnsOf(cue.sound);
      return {
        id: cue.id,
        label: cue.label,
        file_id: sound.file_id,
        builtin: sound.builtin,
        anchor: cue.anchor,
        window_key:
          cue.anchor === "window.open" || cue.anchor === "window.close" ? cue.windowKey : null,
        at: cue.anchor === "time" ? cue.at : null,
        offset_seconds: cue.offsetSeconds,
        align: cue.align,
        channel: cue.channel,
        join_late: cue.joinLate,
        volume: cue.volume,
      };
    }),
  });
  if (error) return toFailure(error, "saving sounds");
  return ok(null);
}

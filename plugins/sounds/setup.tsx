import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  IconLink,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconPlus,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { eventWindowsQueryOptions, type EventWindow } from "@bogey/db/queries/windows";
import type { PluginContext } from "@bogey/plugins/runtime";
import { Button } from "@bogey/ui/components/button";
import { DateTimeField } from "@bogey/ui/components/date-time-field";
import { EditableList, EditableListItem } from "@bogey/ui/components/editable-list";
import { ErrorAlert } from "@bogey/ui/components/error-alert";
import { Field, FieldDescription, FieldLabel } from "@bogey/ui/components/field";
import { Input } from "@bogey/ui/components/input";
import { Label } from "@bogey/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@bogey/ui/components/native-select";
import { NumberInput } from "@bogey/ui/components/number-field";
import { PanelSurface } from "@bogey/ui/components/panel";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@bogey/ui/components/popover";
import { Screen } from "@bogey/ui/components/screen";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@bogey/ui/components/select";
import { Skeleton } from "@bogey/ui/components/skeleton";
import { Switch } from "@bogey/ui/components/switch";
import {
  appFormOptions,
  errorVisibility,
  rewardEarlyPunishLate,
  useAppForm,
} from "@bogey/ui/lib/form";
import { useUnsavedEntry } from "@bogey/ui/lib/unsaved";
import { isoToWallTime, wallTimeToIso } from "@bogey/utils/time";
import {
  eventTimesQueryOptions,
  linkProblem,
  linkSound,
  removeSound,
  saveSetup,
  setupQueryOptions,
  uploadSound,
  type EffectChoice,
  type EventTimes,
  type Setup,
  type SoundFile,
} from "./database.ts";
import { engine } from "./engine.ts";
import {
  ANCHORS,
  BUILTIN_LABELS,
  BUILTINS,
  DEFAULT_EFFECTS,
  describeOffset,
  isBuiltin,
  planCue,
  type Anchor,
  type Cue,
  type SoundRef,
} from "./schedule.ts";
import {
  formatDuration,
  formatMoment,
  formatSize,
  signalList,
  soundName,
  windowLabel,
  type Settings,
} from "./shared.tsx";

function messageOf(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : "Something went wrong.";
}

// ── choosing a sound ────────────────────────────────────────────────────

/** A sound as a select's value: `builtin:<name>`, `file:<id>`, `none`, or "" for the default. */
function encode(sound: SoundRef | null): string {
  if (!sound) return "none";
  return sound.kind === "builtin" ? `builtin:${sound.name}` : `file:${sound.id}`;
}

function decode(value: string): SoundRef | null {
  const [kind, rest = ""] = value.split(/:(.*)/);
  if (kind === "builtin" && isBuiltin(rest)) return { kind: "builtin", name: rest };
  if (kind === "file" && rest) return { kind: "file", id: rest };
  return null;
}

function SoundOptions({ files }: { files: Tuple<SoundFile> }) {
  return (
    <>
      {files.length > 0 && (
        <optgroup label="Library">
          {files.map((file) => (
            <NativeSelectOption key={file.id} value={`file:${file.id}`}>
              {file.name} ({formatDuration(file.durationMs)})
            </NativeSelectOption>
          ))}
        </optgroup>
      )}
      <optgroup label="Built in">
        {BUILTINS.map((name) => (
          <NativeSelectOption key={name} value={`builtin:${name}`}>
            {BUILTIN_LABELS[name]}
          </NativeSelectOption>
        ))}
      </optgroup>
    </>
  );
}

/** Which play button's sound is playing now, by the key it passed to `engine.preview`. */
function usePreviewing(): string | null {
  return useSyncExternalStore(
    engine.subscribe,
    () => engine.state.previewing,
    () => null,
  );
}

/** Plays a sound to try it out; while it plays, the button stops it. */
function PreviewButton({
  sound,
  channel = "effect",
  name,
}: {
  sound: SoundRef | null;
  channel?: "music" | "effect";
  /** What's playing, for screen readers. */
  name?: string;
}) {
  const key = useId();
  const playing = usePreviewing() === key;
  const label = playing ? `Stop${name ? ` ${name}` : ""}` : `Play${name ? ` ${name}` : " it"}`;
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      disabled={!sound && !playing}
      aria-label={label}
      title={label}
      onClick={() => {
        if (playing) engine.stopPreview();
        else if (sound) engine.preview(sound, channel, key);
      }}
    >
      {playing ? <IconPlayerStopFilled /> : <IconPlayerPlayFilled />}
    </Button>
  );
}

// ── the draft ───────────────────────────────────────────────────────────

/** Takes a fresh library into the draft: new uploads join, removed ones leave, edits stay. */
function withLibrary(draft: Setup, fresh: Setup): Setup {
  const edited = new Map(draft.files.map((file) => [file.id, file]));
  const ids = new Set(fresh.files.map((file) => file.id));
  const kept = (sound: SoundRef | null) => !sound || sound.kind === "builtin" || ids.has(sound.id);
  return {
    files: fresh.files.map((file) => {
      const edit = edited.get(file.id);
      return edit
        ? {
            ...file,
            name: edit.name,
            preload: edit.preload,
            playlistPosition: edit.playlistPosition,
          }
        : file;
    }),
    // removing an upload puts its effects back to their defaults, and drops its cues
    effects: draft.effects.filter((effect) => kept(effect.sound)),
    cues: draft.cues.filter((cue) => kept(cue.sound)),
  };
}

async function freshSetup(queryClient: QueryClient, eventId: string): Promise<Setup> {
  return queryClient.fetchQuery({ ...setupQueryOptions(eventId), staleTime: 0 });
}

// ── the page ────────────────────────────────────────────────────────────

/** Manage → Sounds: the library, which sound plays for what, and cues on the schedule. */
export function SetupPage({ eventId, settings, settingsSections }: PluginContext<Settings>) {
  const setup = useQuery(setupQueryOptions(eventId));
  const times = useQuery(eventTimesQueryOptions(eventId));
  const windows = useQuery(eventWindowsQueryOptions(eventId));
  return (
    <Screen
      title="Sounds"
      description="Upload your own sounds, choose what plays when something happens, and time sounds to the schedule."
    >
      <ErrorAlert
        error={messageOf(setup.error ?? times.error ?? windows.error)}
        title="Can't show sounds"
      />
      {settingsSections}
      {setup.data && times.data && windows.data ? (
        <Editor
          eventId={eventId}
          settings={settings}
          saved={setup.data}
          times={times.data}
          windows={windows.data}
        />
      ) : (
        !setup.error && <Skeleton className="h-64 w-full" />
      )}
    </Screen>
  );
}

function Editor({
  eventId,
  settings,
  saved,
  times,
  windows,
}: {
  eventId: string;
  settings: Settings;
  saved: Setup;
  times: EventTimes;
  windows: Tuple<EventWindow>;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Setup>(saved);
  const [error, setError] = useState<string | null>(null);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);

  useUnsavedEntry({
    dirty,
    reset: () => setDraft(saved),
    save: async () => {
      const result = await saveSetup(eventId, draft);
      if (!result.ok) {
        setError(result.error.message);
        return false;
      }
      setError(null);
      setDraft(await freshSetup(queryClient, eventId));
      return true;
    },
  });

  // nothing tried out here keeps playing after leaving the page
  useEffect(() => () => engine.stopPreview(), []);

  const refreshLibrary = async () => {
    const fresh = await freshSetup(queryClient, eventId);
    setDraft((current) => withLibrary(current, fresh));
  };

  return (
    <>
      <ErrorAlert error={error} title="Couldn't save sounds" />
      <Library
        eventId={eventId}
        files={draft.files}
        playlist={settings.music === "playlist"}
        onChange={(files) => setDraft((current) => ({ ...current, files }))}
        onLibraryChanged={refreshLibrary}
      />
      <Cues
        files={draft.files}
        cues={draft.cues}
        times={times}
        windows={windows}
        on={settings.cues}
        onChange={(cues) => setDraft((current) => ({ ...current, cues }))}
      />
      <Effects
        files={draft.files}
        effects={draft.effects}
        on={settings.effects}
        onChange={(effects) => setDraft((current) => ({ ...current, effects }))}
      />
    </>
  );
}

// ── the library ─────────────────────────────────────────────────────────

function Library({
  eventId,
  files,
  playlist,
  onChange,
  onLibraryChanged,
}: {
  eventId: string;
  files: Tuple<SoundFile>;
  playlist: boolean;
  onChange: (files: SoundFile[]) => void;
  onLibraryChanged: () => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const previewing = usePreviewing();
  const keyOf = (file: SoundFile) => `library:${file.id}`;

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!picked.length) return;
    const failed: string[] = [];
    setProblems([]);
    for (const [index, file] of picked.entries()) {
      setProgress({ done: index, total: picked.length });
      const result = await uploadSound(eventId, file);
      if (!result.ok) failed.push(result.error.message);
    }
    setProgress(null);
    setProblems(failed);
    await onLibraryChanged();
  };

  const remove = async (file: SoundFile) => {
    const result = await removeSound(file.id);
    if (!result.ok) setProblems([result.error.message]);
    await onLibraryChanged();
  };

  const update = (id: string, change: Partial<SoundFile>) =>
    onChange(files.map((file) => (file.id === id ? { ...file, ...change } : file)));
  const nextPosition = Math.max(-1, ...files.map((file) => file.playlistPosition ?? -1)) + 1;

  const toggle = (file: SoundFile) => {
    if (previewing === keyOf(file)) engine.stopPreview();
    else engine.preview({ kind: "file", id: file.id }, "music", keyOf(file));
  };

  return (
    <Screen.Section
      title="Library"
      description="Sounds you upload (up to 25 MB each) or link from elsewhere. Short uploads load in full so they play instantly; songs and links stream. Preloaded ones load as soon as someone opens the event, others shortly before they're needed."
      actions={
        <>
          <Button size="sm" disabled={progress !== null} onClick={() => input.current?.click()}>
            <IconUpload />
            {progress
              ? `Uploading ${progress.done + 1} of ${progress.total}...`
              : "Upload sounds..."}
          </Button>
          <input
            ref={input}
            type="file"
            accept="audio/*"
            multiple
            hidden
            onChange={(event) => void upload(event)}
          />
          <LinkSound eventId={eventId} onAdded={onLibraryChanged} />
        </>
      }
    >
      {problems.map((problem) => (
        <ErrorAlert key={problem} error={problem} title="Couldn't upload" />
      ))}
      {files.length === 0 ? (
        <p className="text-sm text-muted-fg">
          Nothing here yet. The built-in sounds work without anything here.
        </p>
      ) : (
        <PanelSurface>
          <ul className="flex flex-col divide-y divide-border">
            {files.map((file) => (
              <li
                key={file.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 p-(--panel-spacing)"
              >
                <Button
                  size="icon-sm"
                  variant={previewing === keyOf(file) ? "default" : "outline"}
                  className="rounded-pill"
                  aria-label={
                    previewing === keyOf(file) ? `Stop ${file.name}` : `Play ${file.name}`
                  }
                  onClick={() => toggle(file)}
                >
                  {previewing === keyOf(file) ? <IconPlayerStopFilled /> : <IconPlayerPlayFilled />}
                </Button>
                <div className="flex min-w-48 flex-1 flex-col gap-1">
                  <Input
                    aria-label="Name"
                    value={file.name}
                    maxLength={120}
                    onChange={(event) => update(file.id, { name: event.target.value })}
                  />
                  <span className="flex min-w-0 items-center gap-1 text-xs text-muted-fg">
                    {formatDuration(file.durationMs)} ·{" "}
                    {file.sizeBytes === null ? (
                      <>
                        <IconLink className="size-3 shrink-0" aria-hidden />
                        <span className="truncate" title={file.url}>
                          {new URL(file.url).host}
                        </span>
                      </>
                    ) : (
                      formatSize(file.sizeBytes)
                    )}
                  </span>
                </div>
                <Toggle
                  label="Preload"
                  checked={file.preload}
                  onChange={(preload) => update(file.id, { preload })}
                />
                {playlist && (
                  <Toggle
                    label="In Playlist"
                    checked={file.playlistPosition !== null}
                    onChange={(on) =>
                      update(file.id, { playlistPosition: on ? nextPosition : null })
                    }
                  />
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${file.name}...`}
                  title="Remove..."
                  confirm={{
                    title: `Remove "${file.name}"?`,
                    description:
                      "Effects that play it go back to their defaults, and cues that play it are removed. This can't be undone.",
                    label: "Remove",
                  }}
                  onClick={() => void remove(file)}
                >
                  <IconTrash />
                </Button>
              </li>
            ))}
          </ul>
        </PanelSurface>
      )}
    </Screen.Section>
  );
}

const linkSchema = z.object({
  link: z
    .string()
    .trim()
    .min(1, "Paste the address")
    .superRefine((value, ctx) => {
      const problem = linkProblem(value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    })
    .meta({ label: "Address", placeholder: "https://example.com/song.mp3" }),
  name: z.string().max(120, "Keep it under 120 characters").meta({ label: "Name" }),
});

/** Adds a sound that plays from a web address, beside Upload. */
function LinkSound({ eventId, onAdded }: { eventId: string; onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const form = useAppForm({
    ...appFormOptions.strictSchema({
      defaultValues: { link: "", name: "" },
      errorVisibility,
      validators: [rewardEarlyPunishLate(linkSchema)],
    }),
    onSubmit: async ({ value, formApi, createValidationError }) => {
      const result = await linkSound(eventId, value.link.trim(), value.name);
      if (!result.ok) return createValidationError(result.error.message);
      formApi.reset();
      setOpen(false);
      await onAdded();
      return undefined;
    },
  });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) form.reset();
      }}
    >
      <PopoverTrigger
        render={
          <Button size="sm" variant="outline">
            <IconLink />
            Link a sound...
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Link a sound</PopoverTitle>
          <PopoverDescription>
            The address of an audio file (MP3, M4A, OGG...) on another site. It plays from there, so
            it takes no room here, and stops working if that site takes it down.
          </PopoverDescription>
        </PopoverHeader>
        <form.AppForm>
          <form.Form className="flex flex-col gap-3">
            <form.Field name="link">
              {(field) => <field.TextField type="url" required autoComplete="off" />}
            </form.Field>
            <form.Field name="name">{(field) => <field.TextField />}</form.Field>
            <form.FormAlert title="Couldn't add it" />
            <form.Submit size="sm" pending="Checking it plays...">
              Add to library
            </form.Submit>
          </form.Form>
        </form.AppForm>
      </PopoverContent>
    </Popover>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
    </div>
  );
}

// ── effects ─────────────────────────────────────────────────────────────

function Effects({
  files,
  effects,
  on,
  onChange,
}: {
  files: Tuple<SoundFile>;
  effects: Tuple<EffectChoice>;
  on: boolean;
  onChange: (effects: EffectChoice[]) => void;
}) {
  const groups = useMemo(() => {
    const bySource = new Map<string, ReturnType<typeof signalList>>();
    for (const signal of signalList()) {
      bySource.set(signal.sourceName, [...(bySource.get(signal.sourceName) ?? []), signal]);
    }
    return [...bySource];
  }, []);
  const chosen = new Map(effects.map((effect) => [effect.signal, effect]));

  const choose = (signal: string, value: string) => {
    const others = effects.filter((effect) => effect.signal !== signal);
    // the default is no row at all, so a better default in a later version reaches this event
    if (value === "") onChange(others);
    else onChange([...others, { signal, sound: decode(value), volume: 100 }]);
  };

  return (
    <Screen.Section
      title="Effects"
      description={
        on
          ? "What plays when something happens. Each person hears only what happens to them or in front of them. Extensions that aren't on for this event never make theirs happen."
          : "Effects are switched off for this event (Manage → Extensions). You can still choose them here."
      }
    >
      <div className="flex flex-col gap-6">
        {groups.map(([source, list]) => (
          <div key={source} className="flex flex-col gap-1">
            <h3 className="text-xs font-medium tracking-wide text-muted-fg uppercase">{source}</h3>
            {list.map((signal) => {
              const own = chosen.get(signal.key);
              const builtin = DEFAULT_EFFECTS[signal.key];
              const fallback: SoundRef | null = builtin ? { kind: "builtin", name: builtin } : null;
              const sound = own ? own.sound : fallback;
              return (
                <div
                  key={signal.key}
                  className="flex flex-wrap items-center justify-between gap-2 py-1"
                >
                  <span className="min-w-48 flex-1 text-sm">{signal.label}</span>
                  <div className="flex items-center gap-1">
                    <NativeSelect
                      size="sm"
                      aria-label={`Sound for: ${signal.label}`}
                      value={own ? encode(own.sound) : ""}
                      onChange={(event) => choose(signal.key, event.target.value)}
                    >
                      <NativeSelectOption value="">
                        {builtin ? `Default (${BUILTIN_LABELS[builtin]})` : "Default (none)"}
                      </NativeSelectOption>
                      <NativeSelectOption value="none">None</NativeSelectOption>
                      <SoundOptions files={files} />
                    </NativeSelect>
                    <PreviewButton sound={sound} name={signal.label} />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Screen.Section>
  );
}

// ── cues ────────────────────────────────────────────────────────────────

const ANCHOR_LABELS: Record<Anchor, string> = {
  "event.start": "the event starts",
  "event.end": "the event ends",
  "window.open": "a window opens",
  "window.close": "a window closes",
  time: "custom time...",
};

const UNITS = [
  { value: 3600, label: "hours" },
  { value: 60, label: "minutes" },
  { value: 1, label: "seconds" },
] as const;

function unitOf(seconds: number): number {
  return UNITS.find((unit) => seconds % unit.value === 0)?.value ?? 1;
}

function newCue(change: Partial<Cue>): Cue {
  return {
    id: crypto.randomUUID(),
    label: "New cue",
    sound: { kind: "builtin", name: "chime" },
    anchor: "event.start",
    windowKey: null,
    at: null,
    offsetSeconds: 0,
    align: "start",
    channel: "effect",
    joinLate: true,
    volume: 100,
    ...change,
  };
}

/** Where the schedule leaves a cue without a time, in words; null when it has one. */
function missingTime(cue: Cue, times: EventTimes, windows: Tuple<EventWindow>): string | null {
  switch (cue.anchor) {
    case "event.start":
      return times.startsAt ? null : "The event has no start time yet (Manage → Details).";
    case "event.end":
      return times.endsAt ? null : "The event has no end time yet (Manage → Details).";
    case "time":
      return cue.at ? null : "Pick a time.";
    case "window.open":
    case "window.close": {
      if (!cue.windowKey) return "Pick a window.";
      const window = windows.find((each) => each.key === cue.windowKey);
      const at = cue.anchor === "window.open" ? window?.opens_at : window?.closes_at;
      return at
        ? null
        : `${windowLabel(cue.windowKey)} has no ${cue.anchor === "window.open" ? "opening" : "closing"} time on the agenda. Opening it by hand doesn't play cues.`;
    }
  }
}

function Cues({
  files,
  cues,
  times,
  windows,
  on,
  onChange,
}: {
  files: Tuple<SoundFile>;
  cues: Tuple<Cue>;
  times: EventTimes;
  windows: Tuple<EventWindow>;
  on: boolean;
  onChange: (cues: Cue[]) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const timeline = useMemo(
    () => ({ eventStart: times.startsAt, eventEnd: times.endsAt, windows }),
    [times, windows],
  );
  const lengthOf = (sound: SoundRef) =>
    sound.kind === "builtin"
      ? engine.lengthOf(sound)
      : (files.find((file) => file.id === sound.id)?.durationMs ?? null);
  const longest = [...files].sort((a, b) => b.durationMs - a.durationMs)[0];

  const add = (cue: Cue) => {
    onChange([...cues, cue]);
    setEditing(cue.id);
  };
  const update = (id: string, change: Partial<Cue>) =>
    onChange(cues.map((cue) => (cue.id === id ? { ...cue, ...change } : cue)));
  const presets: Tuple<{ label: string; cue: () => Cue }> = [
    {
      label: "A song that ends as the event ends",
      cue: () =>
        newCue({
          label: "Final countdown",
          sound: longest ? { kind: "file", id: longest.id } : { kind: "builtin", name: "fanfare" },
          anchor: "event.end",
          align: "end",
          channel: "music",
        }),
    },
    {
      label: "A warning before submissions close",
      cue: () =>
        newCue({
          label: "Submissions closing soon",
          sound: { kind: "builtin", name: "tick" },
          anchor: "window.close",
          windowKey: "submissions",
          offsetSeconds: -300,
        }),
    },
    {
      label: "A fanfare as the event starts",
      cue: () => newCue({ label: "Kickoff", sound: { kind: "builtin", name: "fanfare" } }),
    },
  ];
  const custom = "custom";

  return (
    <Screen.Section
      title="Cues"
      description={
        on
          ? "Sounds that play for everyone at a time worked out from the schedule. A cue can end at that time, so a song finishes exactly when hacking does; people who arrive partway through still hear the rest in step."
          : "Cues are switched off for this event (Manage → Extensions). You can still set them up here."
      }
      actions={
        // controlled to nothing, so it reads "Add a cue..." again after each pick
        <Select
          value={null}
          onValueChange={(next) => {
            if (next === null) return;
            add(next === custom ? newCue({}) : (presets[Number(next)]?.cue() ?? newCue({})));
          }}
        >
          <SelectTrigger size="sm" className="w-fit">
            <IconPlus />
            <SelectValue placeholder="Add a cue..." />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectGroup>
              <SelectItem value={custom}>Custom</SelectItem>
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Presets</SelectLabel>
              {presets.map((preset, index) => (
                <SelectItem key={preset.label} value={String(index)}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      }
    >
      <EditableList
        empty="No cues yet."
        onMove={(from, to) => {
          const next = [...cues];
          const [moved] = next.splice(from, 1);
          if (moved) next.splice(to, 0, moved);
          onChange(next);
        }}
      >
        {cues.map((cue, index) => {
          const plan = planCue(cue, timeline, lengthOf);
          const missing = missingTime(cue, times, windows);
          const when = plan
            ? `${formatMoment(plan.startsAt, times.timeZone)} to ${formatMoment(plan.endsAt, times.timeZone)}`
            : (missing ?? "The sound is missing.");
          return (
            <EditableListItem
              key={cue.id}
              id={cue.id}
              index={index}
              noun="cue"
              numbered={false}
              editing={editing === cue.id}
              onEdit={() => setEditing(cue.id)}
              onDone={() => setEditing(null)}
              onDuplicate={() =>
                add({ ...cue, id: crypto.randomUUID(), label: `${cue.label} (copy)` })
              }
              onRemove={() => onChange(cues.filter((each) => each.id !== cue.id))}
              preview={
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{cue.label}</span>
                  <span className="text-sm text-muted-fg">
                    {soundName(cue.sound, files)}, {cue.align === "end" ? "ending" : "starting"}{" "}
                    {describeOffset(cue.offsetSeconds)} {anchorText(cue)}
                  </span>
                  <span className={plan ? "text-xs text-muted-fg" : "text-xs text-destructive"}>
                    {when}
                  </span>
                </div>
              }
            >
              <CueEditor
                cue={cue}
                files={files}
                windows={windows}
                timeZone={times.timeZone}
                when={when}
                onChange={(change) => update(cue.id, change)}
              />
            </EditableListItem>
          );
        })}
      </EditableList>
    </Screen.Section>
  );
}

function anchorText(cue: Cue): string {
  if (cue.anchor === "window.open" || cue.anchor === "window.close") {
    const name = cue.windowKey ? windowLabel(cue.windowKey) : "a window";
    return `${name} ${cue.anchor === "window.open" ? "opens" : "closes"}`;
  }
  if (cue.anchor === "time") return "the time picked";
  return ANCHOR_LABELS[cue.anchor];
}

function CueEditor({
  cue,
  files,
  windows,
  timeZone,
  when,
  onChange,
}: {
  cue: Cue;
  files: Tuple<SoundFile>;
  windows: Tuple<EventWindow>;
  timeZone: string;
  when: string;
  onChange: (change: Partial<Cue>) => void;
}) {
  const id = useId();
  const size = Math.abs(cue.offsetSeconds);
  const unit = unitOf(size);
  const direction = cue.offsetSeconds < 0 ? -1 : 1;
  const windowKeys = [
    ...new Set([...windows.map((window) => window.key), ...(cue.windowKey ? [cue.windowKey] : [])]),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-label`}>Name</FieldLabel>
          <Input
            id={`${id}-label`}
            value={cue.label}
            maxLength={120}
            onChange={(event) => onChange({ label: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-sound`}>Sound</FieldLabel>
          <div className="flex items-center gap-1">
            <NativeSelect
              id={`${id}-sound`}
              className="flex-1"
              value={encode(cue.sound)}
              onChange={(event) => {
                const sound = decode(event.target.value);
                if (sound) onChange({ sound });
              }}
            >
              <SoundOptions files={files} />
            </NativeSelect>
            <PreviewButton sound={cue.sound} channel={cue.channel} name={cue.label} />
          </div>
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor={`${id}-offset`}>When</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label="Start or end"
            value={cue.align}
            onChange={(event) =>
              onChange({ align: event.target.value === "end" ? "end" : "start" })
            }
          >
            <NativeSelectOption value="start">Start it</NativeSelectOption>
            <NativeSelectOption value="end">Finish it</NativeSelectOption>
          </NativeSelect>
          <NumberInput
            id={`${id}-offset`}
            aria-label="How long before or after"
            className="w-32"
            min={0}
            value={size / unit}
            onValueChange={(value) =>
              onChange({ offsetSeconds: Math.round(value ?? 0) * unit * direction })
            }
          />
          <NativeSelect
            aria-label="Unit"
            value={String(unit)}
            onChange={(event) =>
              onChange({ offsetSeconds: (size / unit) * Number(event.target.value) * direction })
            }
          >
            {UNITS.map((each) => (
              <NativeSelectOption key={each.value} value={String(each.value)}>
                {each.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Before or after"
            value={String(direction)}
            onChange={(event) => onChange({ offsetSeconds: size * Number(event.target.value) })}
          >
            <NativeSelectOption value="-1">before</NativeSelectOption>
            <NativeSelectOption value="1">after</NativeSelectOption>
          </NativeSelect>
          <NativeSelect
            aria-label="What it's timed from"
            value={cue.anchor}
            onChange={(event) => {
              const next = ANCHORS.find((anchor) => anchor === event.target.value);
              if (next) {
                onChange({
                  anchor: next,
                  windowKey: next.startsWith("window.")
                    ? (cue.windowKey ?? windowKeys[0] ?? "submissions")
                    : null,
                  at:
                    next === "time"
                      ? (cue.at ?? new Date(Date.now() + 3600_000).toISOString())
                      : null,
                });
              }
            }}
          >
            {ANCHORS.map((anchor) => (
              <NativeSelectOption key={anchor} value={anchor}>
                {ANCHOR_LABELS[anchor]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {cue.anchor.startsWith("window.") && (
            <NativeSelect
              aria-label="Window"
              value={cue.windowKey ?? ""}
              onChange={(event) => onChange({ windowKey: event.target.value })}
            >
              {windowKeys.map((key) => (
                <NativeSelectOption key={key} value={key}>
                  {windowLabel(key)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </div>
        <FieldDescription>{when}</FieldDescription>
      </Field>

      {cue.anchor === "time" && (
        <DateTimeField
          id={`${id}-at`}
          label={`Time (${timeZone})`}
          value={isoToWallTime(cue.at, timeZone)}
          onChange={(value) => onChange({ at: wallTimeToIso(value, timeZone) })}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-channel`}>Plays</FieldLabel>
          <NativeSelect
            id={`${id}-channel`}
            value={cue.channel}
            onChange={(event) =>
              onChange({ channel: event.target.value === "music" ? "music" : "effect" })
            }
          >
            <NativeSelectOption value="music">
              As music, pausing background music
            </NativeSelectOption>
            <NativeSelectOption value="effect">Over everything, like an effect</NativeSelectOption>
          </NativeSelect>
        </Field>
        <div className="flex items-end pb-1">
          <Toggle
            label="People who arrive partway through still hear the rest"
            checked={cue.joinLate}
            onChange={(joinLate) => onChange({ joinLate })}
          />
        </div>
      </div>
    </div>
  );
}

import { useEffect } from "react";
import { CORE_WINDOW_INFO } from "@bogey/config/windows";
import { pluginWindows } from "@bogey/plugins/api";
import { createPluginNav } from "@bogey/plugins/nav";
import { createPluginPreferences } from "@bogey/plugins/preferences";
import { installedPlugins } from "@bogey/plugins/registry";
import { allSignals, createPluginSignals } from "@bogey/plugins/signals";
import type { SettingsOf } from "@bogey/plugins/types";
import type { SoundFile } from "./database.ts";
import { engine, type Background } from "./engine.ts";
import { manifest } from "./manifest.ts";
import { BUILTIN_LABELS, type SoundRef } from "./schedule.ts";

export type Settings = SettingsOf<typeof manifest>;

export const signals = createPluginSignals(manifest);
export const { SettingsLink } = createPluginNav(manifest);

const { usePreference } = createPluginPreferences(manifest);

/** Whether the person turned event sounds off, kept on their account so it follows them. */
export function useMuted() {
  return usePreference<boolean>("muted", false);
}

// what ⌘K's "Toggle event sounds" calls, from outside React: the newest mounted
// ApplyLevels answers, so the choice is saved to the account like the menu's
const muteTogglers: Array<() => void> = [];

export function toggleMute() {
  muteTogglers.at(-1)?.();
}

/** Keeps the engine at the organizers' volumes, and silent for someone who turned sounds off. */
export function ApplyLevels({ settings }: { settings: Settings }) {
  const muted = useMuted();
  const { value: isMuted, set: setMuted } = muted;
  useEffect(() => {
    engine.setLevels({
      effects: settings.effectsVolume / 100,
      music: settings.musicVolume / 100,
      muted: isMuted,
      duckMusic: settings.duckMusic,
    });
  }, [settings.effectsVolume, settings.musicVolume, settings.duckMusic, isMuted]);
  useEffect(() => {
    const toggle = () => setMuted(!isMuted);
    muteTogglers.push(toggle);
    return () => void muteTogglers.splice(muteTogglers.indexOf(toggle), 1);
  }, [isMuted, setMuted]);
  return null;
}

/** What background music the event plays: its choice, when that can play. */
export function backgroundOf(settings: Settings, files: Tuple<SoundFile>): Background | null {
  switch (settings.music) {
    case "off":
      return null;
    case "playlist": {
      const tracks = files
        .filter((file) => file.playlistPosition !== null)
        .sort((a, b) => (a.playlistPosition ?? 0) - (b.playlistPosition ?? 0))
        .map((file) => file.id);
      return tracks.length ? { kind: "playlist", tracks } : null;
    }
    case "stream":
      try {
        const url = new URL(settings.streamUrl);
        if (url.protocol !== "https:") return null;
        return { kind: "stream", url: url.href, name: settings.streamName || "Event radio" };
      } catch {
        return null;
      }
    case "lofi":
    case "ambient":
      return { kind: "generated", style: settings.music, tempo: settings.tempo };
  }
}

export function soundName(sound: SoundRef | null, files: Tuple<SoundFile>): string {
  if (!sound) return "Nothing";
  if (sound.kind === "builtin") return BUILTIN_LABELS[sound.name];
  return files.find((file) => file.id === sound.id)?.name ?? "A removed sound";
}

/** Every signal there is, with what the extension that declares it is called. */
export function signalList() {
  const installed = installedPlugins();
  const names = new Map(installed.map((plugin) => [plugin.key, plugin.name]));
  return allSignals(installed).map((signal) => ({
    ...signal,
    sourceName: signal.source === "core" ? "Bogey" : (names.get(signal.source) ?? signal.source),
  }));
}

/** What a window is called, for core's and installed extensions'. */
export function windowLabel(key: string): string {
  return (
    CORE_WINDOW_INFO.find((window) => window.key === key)?.label ??
    pluginWindows(installedPlugins()).find((window) => window.key === key)?.label ??
    key
  );
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A moment in the event's time zone, to the second, since cues are timed that finely. */
export function formatMoment(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);
}

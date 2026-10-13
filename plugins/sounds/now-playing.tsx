import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";
import type { PluginContext } from "@bogey/plugins/runtime";
import { Button } from "@bogey/ui/components/button";
import { Panel } from "@bogey/ui/components/panel";
import { setupQueryOptions } from "./database.ts";
import { engine, type Background } from "./engine.ts";
import { useMuted, type Settings } from "./shared.tsx";

function useEngineState() {
  return useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);
}

const GENERATED_NAMES = { lofi: "Generated lo-fi beats", ambient: "Generated ambient pads" } as const;

function backgroundName(
  background: Background,
  track: string | null,
  files: ReadonlyMap<string, string>,
): string {
  switch (background.kind) {
    case "generated":
      return GENERATED_NAMES[background.style];
    case "stream":
      return background.name;
    case "playlist":
      return (track ? files.get(track) : undefined) ?? "Playlist";
  }
}

/** The event home's "now playing": the cue that's on, or else the background music. */
export function NowPlaying({ eventId, settings }: PluginContext<Settings>) {
  const state = useEngineState();
  const muted = useMuted();
  const setup = useQuery(setupQueryOptions(eventId));
  if (!state.background) return null;

  const names = new Map((setup.data?.files ?? []).map((file) => [file.id, file.name]));
  const music = backgroundName(state.background, state.track, names);
  const title = state.cue ? state.cue.label : music;
  const detail = muted.value
    ? "Event sounds are off for you"
    : state.cue
      ? `Cue, then back to ${music}`
      : state.playing
        ? state.blocked
          ? "Starts when you click or type"
          : "Background music"
        : "Paused";
  // a cue is the same for everyone at the same moment, so only the background music can be stopped
  const canControl = settings.listenerControls && !state.cue;
  return (
    <Panel
      size="sm"
      title="Now playing"
      description={detail}
      action={
        canControl ? (
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => (state.playing ? engine.stopBackground() : engine.startBackground())}
          >
            {state.playing ? <IconPlayerPause /> : <IconPlayerPlay />}
            <span className="sr-only">{state.playing ? "Pause the music" : "Play the music"}</span>
          </Button>
        ) : undefined
      }
    >
      <p className="truncate text-sm font-medium">{title}</p>
    </Panel>
  );
}

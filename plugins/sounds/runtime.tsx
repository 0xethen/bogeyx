import { definePluginRuntime } from "@bogey/plugins/runtime";
import { SoundsWrapper } from "./listen.tsx";
import { manifest } from "./manifest.ts";
import { MuteButton } from "./menu.tsx";
import { NowPlaying } from "./now-playing.tsx";
import { SetupPage } from "./setup.tsx";
import { toggleMute } from "./shared.tsx";

export default definePluginRuntime(manifest, {
  routes: { "": SetupPage },
  homePanels: { "now-playing": NowPlaying },
  slots: {
    eventWrapper: SoundsWrapper,
    menubar: MuteButton,
  },
  actions: {
    toggle_mute: () => toggleMute(),
  },
});

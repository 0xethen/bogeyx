import { createReactComponent, IconLock } from "@tabler/icons-react";
import type { PluginEventListIconContext } from "@bogey/plugins/runtime";
import type { SettingsOf } from "@bogey/plugins/types";
import type { manifest } from "./manifest.ts";

type Settings = SettingsOf<typeof manifest>;

const IconBrowserLock = createReactComponent("outline", "browser-lock", "IconBrowserLock", [
  [
    "path",
    {
      d: "M4 5a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1l0 -14",
      key: "svg-0",
    },
  ],
  ["path", { d: "M4 8h16", key: "svg-1" }],
  ["path", { d: "M8 4v4", key: "svg-2" }],
  [
    "path",
    {
      d: "M9.5 14.5a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1z",
      key: "svg-3",
    },
  ],
  ["path", { d: "M10.5 13.5v-1.5a1.5 1.5 0 0 1 3 0v1.5", key: "svg-4" }],
]);

export function EventListIcon({ settings }: PluginEventListIconContext<Settings>) {
  if (settings.mode === "off") return null;
  const label = `Lockdown Mode${settings.require === "seb" ? " (requires Safe Exam Browser)" : ""}`;
  const Icon = settings.require === "seb" ? IconBrowserLock : IconLock;
  return (
    <Icon title={label} aria-label={label} role="img" className="size-4 shrink-0 text-muted-fg" />
  );
}

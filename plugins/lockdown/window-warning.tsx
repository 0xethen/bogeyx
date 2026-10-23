import { useQuery } from "@tanstack/react-query";
import { eventWindowsQueryOptions, isWindowOpen, windowByKey } from "@bogey/db/queries/windows";
import type { SettingsOf } from "@bogey/plugins/types";
import { Alert, AlertDescription, AlertTitle } from "@bogey/ui/components/alert";
import type { manifest } from "./manifest.ts";
import { windowWarning } from "./schedule.ts";

type Settings = SettingsOf<typeof manifest>;

/** Says so when lockdown is on but its window is closed or not scheduled, so nothing is locked down. */
export function WindowWarning({ eventId, settings }: { eventId: string; settings: Settings }) {
  const windows = useQuery(eventWindowsQueryOptions(eventId));
  if (!windows.data) return null;
  const armed = windowByKey(windows.data, "lockdown.armed");
  const warning = windowWarning(settings, { exists: !!armed, open: isWindowOpen(armed) });
  if (!warning) return null;
  return (
    <Alert>
      <AlertTitle>Lockdown is not active</AlertTitle>
      <AlertDescription>
        {warning === "unset"
          ? 'Lockdown only applies while the "Lockdown" window is open, and that window has no times set. Set it on the agenda, or change "When it applies".'
          : 'Lockdown only applies while the "Lockdown" window is open, and it is closed now. Open it on the agenda, or change "When it applies".'}
      </AlertDescription>
    </Alert>
  );
}

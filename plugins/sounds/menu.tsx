import { IconVolume, IconVolumeOff } from "@tabler/icons-react";
import { Button } from "@bogey/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bogey/ui/components/tooltip";
import { useMuted } from "./shared.tsx";

/** The one thing participants choose: whether they hear the event's sounds at all. Sits beside the bell. */
export function MuteButton() {
  const muted = useMuted();
  const label = muted.value ? "Turn event sounds on" : "Turn event sounds off";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-pressed={muted.value}
            onClick={() => muted.set(!muted.value)}
          >
            {muted.value ? <IconVolumeOff /> : <IconVolume />}
            <span className="sr-only">{label}</span>
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

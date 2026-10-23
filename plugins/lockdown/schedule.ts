/** Whether lockdown applies to participants right now. */
export function lockdownApplies(
  settings: { mode: string; during: string },
  windowOpen: boolean,
  problemsClosed: boolean,
): boolean {
  if (settings.mode === "off" || problemsClosed) return false;
  return settings.during === "always" || windowOpen;
}

/** Set when lockdown is on but waits for a Lockdown window that is not open. */
export function windowWarning(
  settings: { mode: string; during: string },
  armed: { exists: boolean; open: boolean },
): "unset" | "closed" | null {
  if (settings.mode === "off" || settings.during !== "window" || armed.open) return null;
  return armed.exists ? "closed" : "unset";
}

/** Metrics where a smaller number is better, as the database sorts them. */
const LOWER_IS_BETTER: ReadonlySet<string> = new Set(["rmse", "mae", "log_loss"]);

export function lowerIsBetter(metric: string): boolean {
  return LOWER_IS_BETTER.has(metric);
}

/** A score as people read it: four decimals, no exponent. */
export function formatScore(score: number): string {
  return score.toFixed(4);
}

/** Largest file the database takes. */
export const MAX_FILE_BYTES = 5_000_000;

/** Why a chosen file can't be sent, or null. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (!file.name.toLowerCase().endsWith(".csv")) return "Choose a .csv file";
  if (file.size === 0) return "That file is empty";
  if (file.size > MAX_FILE_BYTES) return "Keep the file under 5 MB";
  return null;
}

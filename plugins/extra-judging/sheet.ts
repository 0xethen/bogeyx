/** The criteria in a setting's text: one per non-empty line, at most 8, as the database reads them. */
export function parseCriteria(text: string | undefined): string[] {
  const lines = (text ?? "Overall")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 8)
    .map((line) => line.slice(0, 60));
  return lines.length > 0 ? lines : ["Overall"];
}

/** True when every criterion has a whole mark from 1 to `max`. */
export function isComplete(
  scores: Readonly<Record<string, number | undefined>>,
  criteria: readonly string[],
  max: number,
): boolean {
  return criteria.every((criterion) => {
    const mark = scores[criterion];
    return mark !== undefined && Number.isInteger(mark) && mark >= 1 && mark <= max;
  });
}

/** `order` with the item at `index` moved by `delta` places, clamped to the ends. */
export function move<T>(order: readonly T[], index: number, delta: number): T[] {
  const next = [...order];
  const target = Math.min(Math.max(index + delta, 0), next.length - 1);
  if (index < 0 || index >= next.length || target === index) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** The share of a ballot's points a place earns (Borda): 1 for first, 0 for last. */
export function bordaShare(position: number, size: number): number | null {
  if (size < 2 || position < 1 || position > size) return null;
  return (size - position) / (size - 1);
}

/** Points left to spend when `entry` would get `points`, given every allocation of the judge. */
export function pointsLeft(
  budget: number,
  allocations: readonly { submission_id: string; points: number | null }[],
  entry: string,
  points: number,
): number {
  const elsewhere = allocations
    .filter((row) => row.submission_id !== entry)
    .reduce((sum, row) => sum + (row.points ?? 0), 0);
  return budget - elsewhere - points;
}

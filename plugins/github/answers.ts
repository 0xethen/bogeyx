import type { Json } from "@bogey/db/types";

/** A submission's stored answers as the form handles them: text and yes/no only. */
export function answersOf(value: Json): { [key: string]: string | boolean } {
  const out: { [key: string]: string | boolean } = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "boolean") out[key] = entry;
  }
  return out;
}

/** Text cut to what an item takes, so a long README doesn't fail the save. */
export function fit(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

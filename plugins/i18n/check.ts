import { messageParams, type Messages } from "@bogey/utils/messages";

export interface CatalogProblem {
  key: string;
  problem: string;
}

/**
 * What is wrong with a translation: a key English doesn't have, or a message whose slots differ from the
 * English one's (a missing or extra {name} would break the sentence). Missing keys aren't a problem: they show in English.
 */
export function checkCatalog(source: Messages, catalog: Messages): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  for (const [key, text] of Object.entries(catalog)) {
    const original = source[key];
    if (original === undefined) {
      problems.push({ key, problem: "English has no message with this key" });
      continue;
    }
    const wanted = messageParams(original).join(", ");
    const given = messageParams(text).join(", ");
    if (wanted !== given) {
      problems.push({ key, problem: `uses {${given}} where English uses {${wanted}}` });
    }
  }
  return problems;
}

/** The keys a catalog hasn't translated yet. */
export function untranslated(source: Messages, catalog: Messages): string[] {
  return Object.keys(source).filter((key) => catalog[key] === undefined);
}

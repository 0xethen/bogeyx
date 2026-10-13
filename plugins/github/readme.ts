export const START_MARK = "<!-- bogey:start -->";
export const END_MARK = "<!-- bogey:end -->";

export interface Project {
  title: string;
  tagline: string | null;
  url: string | null;
}

/** Owner and name from `https://github.com/owner/repo`, with or without `.git`, a trailing slash or a path. */
export function parseRepo(address: string): { owner: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "github.com" && url.hostname !== "www.github.com")
  ) {
    return null;
  }
  const [owner, name] = url.pathname.split("/").filter((part) => part !== "");
  const repo = name?.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    return null;
  }
  return { owner, repo };
}

/** The Markdown section Bogey keeps up to date between its two markers. */
export function projectsSection(
  projects: readonly Project[],
  heading: string,
  builtAt: string,
): string {
  const lines = projects.map((project) => {
    const title = project.title.replace(/[[\]]/g, "");
    const name = project.url ? `[${title}](${project.url})` : title;
    return `- ${name}${project.tagline ? ` - ${project.tagline}` : ""}`;
  });
  return [
    START_MARK,
    `## ${heading}`,
    "",
    ...lines,
    "",
    `<sub>Built at ${builtAt}.</sub>`,
    END_MARK,
  ].join("\n");
}

/**
 * Puts `section` into a README: in place of the old one if both markers are there, otherwise at the end.
 * Everything outside the markers is left as it was.
 */
export function replaceSection(readme: string, section: string): string {
  const start = readme.indexOf(START_MARK);
  const end = readme.indexOf(END_MARK);
  if (start !== -1 && end > start) {
    return readme.slice(0, start) + section + readme.slice(end + END_MARK.length);
  }
  const body = readme.trimEnd();
  return body === "" ? `${section}\n` : `${body}\n\n${section}\n`;
}

/** Text as GitHub's contents API wants it: UTF-8 bytes in base64. */
export function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(encoded: string): string {
  const binary = atob(encoded.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/**
 * A short description from a README: the first paragraph that isn't a heading, badge, image or HTML,
 * with Markdown links reduced to their text.
 */
export function summarize(readme: string, maxLength = 280): string {
  for (const block of readme.split(/\n\s*\n/)) {
    const text = block.trim();
    if (text === "" || /^(#|<|!\[|\[!\[|```|---|===|\|)/.test(text)) continue;
    const plain = text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain === "") continue;
    return plain.length <= maxLength ? plain : `${plain.slice(0, maxLength - 1).trimEnd()}…`;
  }
  return "";
}

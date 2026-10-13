import { z } from "zod";
import { fromBase64 } from "./readme.ts";

const API = "https://api.github.com";

function headers(token: string | null, accept = "application/vnd.github+json"): HeadersInit {
  return {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** A sentence for a failed GitHub call. */
async function failure(response: Response, doing: string): Promise<Error> {
  if (response.status === 401)
    return new Error(`GitHub didn't accept the sign-in while ${doing}. Connect again.`);
  if (response.status === 403 || response.status === 429) {
    return new Error(
      `GitHub refused while ${doing}. You may have hit its rate limit; try again later.`,
    );
  }
  return new Error(`GitHub answered ${response.status} while ${doing}.`);
}

const userSchema = z.object({ login: z.string() });

/** Who the token belongs to. */
export async function githubLogin(token: string): Promise<string> {
  const response = await fetch(`${API}/user`, { headers: headers(token) });
  if (!response.ok) throw await failure(response, "checking your account");
  return userSchema.parse(await response.json()).login;
}

const contentSchema = z.object({
  sha: z.string(),
  path: z.string(),
  content: z.string(),
});

export interface ProfileReadme {
  sha: string;
  path: string;
  text: string;
}

/** The README of the repository named after the user, or null if they have none. */
export async function profileReadme(token: string, login: string): Promise<ProfileReadme | null> {
  const response = await fetch(`${API}/repos/${login}/${login}/readme`, {
    headers: headers(token),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response, "reading your profile README");
  const parsed = contentSchema.parse(await response.json());
  return { sha: parsed.sha, path: parsed.path, text: fromBase64(parsed.content) };
}

/** Writes the profile README as a commit; `sha` is the file as it was read, so a change since fails. */
export async function saveProfileReadme(
  token: string,
  login: string,
  readme: ProfileReadme,
  text: string,
  message: string,
  encode: (text: string) => string,
): Promise<void> {
  const response = await fetch(`${API}/repos/${login}/${login}/contents/${readme.path}`, {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: encode(text), sha: readme.sha }),
  });
  if (response.status === 409 || response.status === 422) {
    throw new Error("Your README changed while you were looking. Reload and try again.");
  }
  if (response.status === 404) {
    throw new Error(
      "GitHub wouldn't let Bogey write there. Connect again and allow access to public repositories.",
    );
  }
  if (!response.ok) throw await failure(response, "saving your profile README");
}

/** A public repository's README as text, or null if it has none. */
export async function repoReadme(owner: string, repo: string): Promise<string | null> {
  const response = await fetch(`${API}/repos/${owner}/${repo}/readme`, {
    headers: headers(null, "application/vnd.github.raw+json"),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response, "reading that repository");
  return await response.text();
}

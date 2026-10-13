# GitHub

Two things for people who keep their work on GitHub.

## Fill in from a repository

Paste a public repository's address. Bogey reads its README from GitHub's public API (no sign-in needed; GitHub limits
unsigned requests to 60 an hour per address), shows a summary, and fills the submission fields you pick: a description
(a Markdown field gets the whole README, a text field a short summary cut to its length) and a link field with the
repository address. Nothing is saved until you press **Fill in**, you must already have a draft submission, and everything
stays editable afterwards.

## Publish to your profile README

Adds a section listing your submitted projects to the README of your profile repository (the public repository named after
you). It is opt-in per use: connect GitHub, read the preview, tick the switch, press **Publish**. Only the part between
`<!-- bogey:start -->` and `<!-- bogey:end -->` is touched, and the section is added at the end the first time. The commit
message says where it came from.

How it connects:

- **Connect GitHub...** signs you in with GitHub again, asking for the `public_repo` scope (write access to public
  repositories, which is what a profile README is). GitHub has no narrower scope for OAuth Apps. If the account isn't linked
  yet, it links it (the instance has to allow linking, and GitHub sign-in has to be set up: see Self-hosting → Auth).
- The token comes back in your browser session only and **is never sent to or stored by Bogey's server**. Supabase drops
  it when it refreshes your session, about an hour later; connect again then.
- Bogey calls GitHub from your browser. Revoke the access any time at GitHub → Settings → Applications.

The section heading is a setting. Turn off **Offer to publish to GitHub profile READMEs** to hide this part.

## Tests

`node --test tests/readme.test.ts tests/answers.test.ts`.

# Lockdown companion extension

A small Chromium (Manifest V3) extension for events that set Lockdown → Require to submit to
**The Bogey lockdown companion extension**. It does two things on your instance's pages:

- answers the lockdown page's hello, with the page's own one-time nonce and the extension's version, and keeps
  saying it is there every 15 seconds. That is what "requires the extension" checks;
- reports window blur, new tabs and windows, developer tools that look open (a guess from the window's size), and
  clipboard use (written to the audit log, not counted towards the limit).

It asks for no permissions, so it can't read addresses, titles or page contents, and it only runs on the hosts
you give it.

## Build it for your instance

```sh
node build.mjs --host hacks.example.org
```

This writes `dist/` with a `manifest.json` that matches your host (`localhost` also gets `http://`). Then, in Chrome,
Edge or another Chromium browser: `chrome://extensions` → turn on Developer mode → Load unpacked → pick `dist/`.
To give it to participants, use Pack extension on the same page and hand out the `.crx` and key, or have your IT
policy install the folder. Nothing is published to a store.

## What it is not

Any script on the page can send the same messages, so a determined person can pretend to have it. It makes leaving
the page and using other tools visible to proctors; it doesn't prove anyone didn't. Say so to participants.

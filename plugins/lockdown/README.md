# Lockdown

Asks participants for full screen, records leaving the page, and can stop submissions after too many. It is a
deterrent and a record, never proof.

## Modes

- **Record what happens**: tab switches, leaving full screen, the inspect menu and what the companion reports are
  written to the audit log and shown on the Lockdown page. A tab switch counts only while the event is open in full
  screen and not covered, unless `Record tab switches when not in full screen or covered` is on (off by default).
- The message shown after someone leaves the page is empty by default, so nothing shows until an organizer writes one.
- **Record, and stop submissions after too many**: past the limit, challenges refuses submissions until a proctor lets
  the person back in.

## Requiring more (`Require to submit`)

| Setting                                | What it checks                                                                 | Where it is checked          |
| -------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------- |
| Nothing more                           |                                                                                |                              |
| The Bogey lockdown companion extension | The page heard the extension answer its nonce in the last three minutes        | `lockdown_assert_can_submit` |
| Safe Exam Browser                      | A request from the browser carried a hash that matches one of the event's keys | `lockdown_check_seb`         |

Build the extension for your instance from [`companion/`](companion/README.md).

The browser is chosen on its own page, Manage → Lockdown Browser.

### Safe Exam Browser (1.2)

With Safe Exam Browser chosen, **Set up Safe Exam Browser** on Manage → Lockdown Browser makes the configuration, and
its tabs edit it: Exam (the link, quit password and quit link, keys), Browser, Sites (only listed sites, which always
include this site and its Supabase API), Apps (allowed apps, and apps to close) and Security. Saving writes a `.seb`
file (`seb-config.ts`: an unencrypted plist, keyed as SEB's own tool writes them) and works out its Config Key the way
SEB does: SHA-256 of the settings as SEB-JSON, keys sorted, `originatorVersion` left out. Lists left empty stay out of
the file, so SEB keeps its own defaults. Allowed apps are written only while switching to apps is on.

The file's quit link is always the event's `/x/lockdown/done` page. Once problems can't be submitted (the
`challenges.contest` window has closed, or the core `submissions` window without one), lockdown lifts: a page in SEB
(its user agent says `SEB/`) opens that link and SEB quits, and a browser that had the event open while problems were
open goes there too, and on to the contest scoreboard (or the event's home without a contest).

`GET /api/x/lockdown/seb-config/<token>` serves the file to anyone with the token, since SEB downloads it before
anyone signs in (`lockdown_seb_file`). Participants who open the event in another browser get an **Open in Safe Exam
Browser** button with `sebs://<host>/api/x/lockdown/seb-config/<token>`. They sign in again inside SEB, with a code: an
email link opens their usual browser. A file whose start address no longer matches the event (a new slug, or a new site
address) is flagged on the page with a button to write it again.

Anyone with the link can read the file and work out its Config Key, so a matching key keeps casual attempts out, not
determined ones. Keys from an exam configuration you made yourself can still be added under Exam → Safe Exam Browser
keys: its **Browser Exam Key** or **Config Key**.

SEB sends `X-SafeExamBrowser-RequestHash` (made with the Browser Exam Key) and `X-SafeExamBrowser-ConfigKeyHash` (made
with the Config Key) on every request; both are SHA-256 of the address plus the key. The page asks
`POST /api/x/lockdown/seb-check` every minute, the server passes the headers and the address SEB requested (behind a
proxy, from `X-Forwarded-Proto` and `X-Forwarded-Host`) to the database, and the database compares them with the keys
and the generated file's Config Key. Make sure your proxy forwards those headers. Bogey's file switches on _Send browser
exam key header_; a configuration of your own needs it on too.

### Safe Exam Browser fails closed (1.3)

- A check counts only for the sign-in that made it (the JWT's `session_id`), so another browser signed in as the same person stays covered while SEB is open. Participants sign in again inside SEB, so its session is its own.
- Each check asks `lockdown_seb_nonce` first and puts the nonce in the address SEB hashes. The database spends it, so a header captured once can't be replayed.
- When SEB's own session fails a check (its configuration changed, or the key header was switched off), the event closes at once, not three minutes later.
- With no generated file and no keys, nobody passes (`lockdown_seb_ready`). Participants see that it isn't set up yet, and Manage → Lockdown Browser says so. An SEB whose configuration doesn't match is told that, not asked to open SEB.

## The cover holds on the server (1.1)

While a participant's cover is up, Bogey gives them no permission in the event (`private.lockdown_gate`, see
[ADR 0031](https://github.com/0xethen/bogey/blob/main/docs/adr/0031-plugin-gates.md)). Every page sends them to
the event's home, where the cover is; the tabs are hidden; and the event's data is refused by the database, even
to someone calling the API by hand. Organizers are never covered, so Manage stays reachable. Once problems can't be
submitted the gate lifts along with the cover (`private.lockdown_problems_closed`).

| The page shows                 | The server closes the event when                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| Full screen, please            | the page hasn't said it is in full screen, or hasn't beaten in the last three minutes |
| Open it in Safe Exam Browser   | no request carried a matching hash in the last three minutes                          |
| Install the lockdown extension | the page hasn't heard the extension in the last three minutes                         |
| Stopped (Hide the event)       | submissions are stopped                                                               |
| Use a laptop or desktop        | never: a browser can claim to be a desktop                                            |

Full screen and the extension are what the page reports. A person who calls `lockdown_heartbeat` by hand can claim
either, and open the event for themselves; each full screen claim is in the audit log as `lockdown.fullscreen_entered`.
Safe Exam Browser is checked by the server against keys participants can't read. The checks keep honest mistakes
and casual attempts out, and the record shows who did what.

## Tests

`vp test run lockdown` from the plugins repo; the `tests/*.test.sql` suites run with `supabase test db`.

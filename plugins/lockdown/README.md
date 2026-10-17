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

For Safe Exam Browser, make an exam configuration, copy its **Browser Exam Key** or **Config Key**, and add it under
Lockdown → Safe Exam Browser keys (proctors only). SEB sends `X-SafeExamBrowser-RequestHash` (made with the Browser
Exam Key) and `X-SafeExamBrowser-ConfigKeyHash` (made with the Config Key) on every request; both are
SHA-256 of the address plus the key. The page asks `POST /api/x/lockdown/seb-check` every minute, the server passes the
headers and the address SEB requested (behind a proxy, from `X-Forwarded-Proto` and `X-Forwarded-Host`) to the database,
and the database compares them with the keys, which participants can't read. Make sure your proxy forwards those headers
and that SEB's configuration has _Send browser exam key header_ or _Send config key header_ switched on.

## The cover holds on the server (1.1)

While a participant's cover is up, Bogey gives them no permission in the event (`private.lockdown_gate`, see
[ADR 0031](https://github.com/0xethen/bogey/blob/main/docs/adr/0031-plugin-gates.md)). Every page sends them to
the event's home, where the cover is; the tabs are hidden; and the event's data is refused by the database, even
to someone calling the API by hand. Organizers are never covered, so Manage stays reachable.

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

`node --test tests/lockdown.test.ts`; `tests/lockdown_companion.test.sql` runs with `supabase test db`.

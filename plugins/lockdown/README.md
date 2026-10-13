# Lockdown

Asks participants for full screen, records leaving the page, and can stop submissions after too many. It is a
deterrent and a record, never proof.

## Modes

- **Record what happens**: tab switches, leaving full screen, the inspect menu and what the companion reports are
  written to the audit log and shown on the Lockdown page.
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

A person who talks to the database directly can still mark their own session as attested; the checks keep honest
mistakes and casual attempts out, and the record shows who did what.

## Tests

`node --test tests/lockdown.test.ts`; `tests/lockdown_companion.test.sql` runs with `supabase test db`.

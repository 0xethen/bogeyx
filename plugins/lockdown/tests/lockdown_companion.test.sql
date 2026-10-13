-- Attesting by the companion extension or Safe Exam Browser, and requiring one to submit.
begin;
select plan(14);

insert into public.orgs (id, slug, name) values (tests.u('org'), 'alpha', 'Alpha');
insert into public.events (id, org_id, slug, name, kind, visibility, team_size_max) values
  (tests.u('cup'), tests.u('org'), 'cup', 'Cup', 'contest', 'public', 1);
insert into public.settings (scope, event_id, namespace, value) values
  ('event', tests.u('cup'), 'plugins', '{"enabled":["lockdown"]}'),
  ('event', tests.u('cup'), 'plugin.lockdown', '{"mode":"enforce","require":"seb"}');
select tests.create_user(tests.u(n), n || '@t.test', jsonb_build_object('full_name', n)) from unnest(array['amy','proctor']) n;
insert into public.event_members (event_id, user_id, role) values
  (tests.u('cup'), tests.u('amy'), 'participant'), (tests.u('cup'), tests.u('proctor'), 'judge');
insert into public.event_role_grants (event_id, user_id, role_key) values (tests.u('cup'), tests.u('proctor'), 'lockdown.proctor');
-- challenges_submit calls this as its owner; the test calls it as the participant, so for this transaction only
grant execute on function private.lockdown_assert_can_submit(uuid) to authenticated;

-- keys are the proctors'
select tests.as_user(tests.u('amy'));
select throws_ok($$select public.lockdown_set_seb_keys(tests.u('cup'), '[]')$$, '42501', null, 'a participant can''t set keys');
reset role;
select tests.as_user(tests.u('proctor'));
select is(public.lockdown_set_seb_keys(tests.u('cup'), jsonb_build_array(
  jsonb_build_object('kind', 'browser_exam', 'value', repeat('a', 64), 'label', 'lab'),
  jsonb_build_object('kind', 'config', 'value', upper(repeat('b', 64)), 'label', ''))), 2, 'a proctor saves two keys');
select is((select count(*)::integer from public.lockdown_seb_keys), 2, 'and reads them');
reset role;
select tests.as_user(tests.u('amy'));
select is_empty($$select 1 from public.lockdown_seb_keys$$, 'a participant reads none');

-- submitting without attesting is refused
select throws_ok($$select private.lockdown_assert_can_submit(tests.u('cup'))$$, 'P0001', null, 'submitting needs SEB when it is required');

-- a wrong hash doesn't attest
select is(public.lockdown_check_seb(tests.u('cup'), 'https://x.test/a', 'nope', 'nope'), false, 'a wrong hash is refused');

-- the right hash does: sha256(url + key)
select is(public.lockdown_check_seb(tests.u('cup'), 'https://x.test/a',
  encode(extensions.digest('https://x.test/a' || repeat('a', 64), 'sha256'), 'hex'), null), true, 'a Browser Exam Key hash attests');
select lives_ok($$select private.lockdown_assert_can_submit(tests.u('cup'))$$, 'and submitting is allowed');
select is((select attested_by from public.lockdown_sessions where user_id = tests.u('amy')), 'seb', 'recorded as SEB');

-- a config key hash works too, in either case
reset role;
update public.lockdown_sessions set attested_at = null, attested_by = null where user_id = tests.u('amy');
select tests.as_user(tests.u('amy'));
select is(public.lockdown_check_seb(tests.u('cup'), 'https://x.test/b', null,
  upper(encode(extensions.digest('https://x.test/b' || repeat('b', 64), 'sha256'), 'hex'))), true, 'a Config Key hash attests');

-- an old attestation lapses
reset role;
update public.lockdown_sessions set attested_at = now() - interval '5 minutes' where user_id = tests.u('amy');
select tests.as_user(tests.u('amy'));
select throws_ok($$select private.lockdown_assert_can_submit(tests.u('cup'))$$, 'P0001', null, 'after three minutes it lapses');

-- the extension can't stand in for SEB
select public.lockdown_heartbeat(tests.u('cup'), '1.0.0', true);
select throws_ok($$select private.lockdown_assert_can_submit(tests.u('cup'))$$, 'P0001', null, 'the extension doesn''t satisfy "seb"');
reset role;
update public.settings set value = '{"mode":"enforce","require":"extension"}' where namespace = 'plugin.lockdown';
select tests.as_user(tests.u('amy'));
select lives_ok($$select private.lockdown_assert_can_submit(tests.u('cup'))$$, 'but does satisfy "extension"');
reset role;
select is((select attested_by from public.lockdown_sessions where user_id = tests.u('amy')), 'extension', 'recorded as the extension');

select * from finish();
rollback;

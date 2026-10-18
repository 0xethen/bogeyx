-- Lockdown 1.2: Bogey's Safe Exam Browser configuration, its link, and its Config Key in the check.
begin;
select plan(14);

insert into public.orgs (id, slug, name) values (tests.u('org'), 'alpha', 'Alpha');
insert into public.events (id, org_id, slug, name, kind, visibility, team_size_max) values
  (tests.u('cup'), tests.u('org'), 'cup', 'Cup', 'contest', 'unlisted', 1);
insert into public.settings (scope, event_id, namespace, value) values
  ('event', tests.u('cup'), 'plugins', '{"enabled":["lockdown"]}'),
  ('event', tests.u('cup'), 'plugin.lockdown', '{"mode":"monitor","require":"seb","requireFullscreen":false}');
select tests.create_user(tests.u(n), n || '@t.test', jsonb_build_object('full_name', n)) from unnest(array['amy','org1']) n;
insert into public.event_members (event_id, user_id, role) values
  (tests.u('cup'), tests.u('amy'), 'participant'), (tests.u('cup'), tests.u('org1'), 'organizer');

select tests.as_user(tests.u('amy'));
select throws_ok(
  $$select public.lockdown_save_seb_config(tests.u('cup'), '{}', '<plist/>', repeat('a', 64))$$,
  '42501', null, 'participants can''t write the configuration');
select is(public.lockdown_seb_link(tests.u('cup')), null, 'there''s no link before there''s a file');
reset role;

select tests.as_user(tests.u('org1'));
select lives_ok(
  $$select public.lockdown_save_seb_config(tests.u('cup'), '{"allowQuit":false}', '<plist>one</plist>', repeat('A', 64))$$,
  'organizers write it');
select is((select config_key from public.lockdown_seb_configs where event_id = tests.u('cup')), repeat('a', 64),
  'the key is kept in lower case');
select lives_ok(
  $$select public.lockdown_save_seb_config(tests.u('cup'), '{}', '<plist>two</plist>', repeat('b', 64))$$,
  'and write it again');
select is((select count(*)::integer from public.lockdown_seb_configs), 1, 'over the same row');
reset role;
select is((select count(*)::integer from public.audit_log where event_id = tests.u('cup') and action = 'lockdown.seb_config_saved'),
  2, 'each save is written down');
-- the token, for the checks below that run as people who can't read the row
create temp table seb_token as select token from public.lockdown_seb_configs where event_id = tests.u('cup');
grant select on seb_token to anon, authenticated;

select tests.as_user(tests.u('amy'));
select is((select count(*)::integer from public.lockdown_seb_configs), 0, 'participants can''t read the row');
select is(public.lockdown_seb_link(tests.u('cup')),
  (select token from seb_token),
  'but get the link''s token, even while covered');
-- the check needs a sign-in session and a fresh nonce in the address (5_seb_session_nonce)
select set_config('request.jwt.claims', json_build_object('sub', tests.u('amy'), 'role', 'authenticated',
  'aal', 'aal2', 'session_id', 'seb')::text, true);
create temp table check_urls as
  select 'https://bogey.test/x?nonce=' || public.lockdown_seb_nonce(tests.u('cup')) as new_key,
    'https://bogey.test/x?nonce=' || public.lockdown_seb_nonce(tests.u('cup')) as old_key;
select ok(public.lockdown_check_seb(tests.u('cup'), (select new_key from check_urls),
  '', encode(extensions.digest((select new_key from check_urls) || repeat('b', 64), 'sha256'), 'hex')),
  'a hash made with the file''s Config Key passes the check');
select ok(not public.lockdown_check_seb(tests.u('cup'), (select old_key from check_urls),
  '', encode(extensions.digest((select old_key from check_urls) || repeat('a', 64), 'sha256'), 'hex')),
  'one made with an old key doesn''t');
reset role;

select tests.as_anon();
select is(public.lockdown_seb_file((select token from seb_token)),
  '<plist>two</plist>', 'SEB downloads the file signed out, with the token');
select is(public.lockdown_seb_file('nope'), null, 'and nothing without it');
reset role;

update public.settings set value = '{"mode":"monitor","require":"none"}'
where event_id = tests.u('cup') and namespace = 'plugin.lockdown';
select tests.as_anon();
select is(public.lockdown_seb_file((select token from seb_token)),
  null, 'the file is gone once SEB isn''t required');

select * from finish();
rollback;

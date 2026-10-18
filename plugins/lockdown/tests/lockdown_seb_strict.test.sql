-- Safe Exam Browser fails closed: nothing to match against opens to nobody, a check counts only for
-- the sign-in that made it, a header can't be replayed, and SEB failing later closes it at once.
begin;
select plan(13);

insert into public.orgs (id, slug, name) values (tests.u('org'), 'alpha', 'Alpha');
insert into public.events (id, org_id, slug, name, kind, visibility, team_size_max) values
  (tests.u('cup'), tests.u('org'), 'cup', 'Cup', 'contest', 'unlisted', 1);
insert into public.settings (scope, event_id, namespace, value) values
  ('event', tests.u('cup'), 'plugins', '{"enabled":["lockdown"]}'),
  ('event', tests.u('cup'), 'plugin.lockdown', '{"mode":"monitor","require":"seb","requireFullscreen":false}');
select tests.create_user(tests.u(n), n || '@t.test', jsonb_build_object('full_name', n)) from unnest(array['amy','org1']) n;
insert into public.event_members (event_id, user_id, role) values
  (tests.u('cup'), tests.u('amy'), 'participant'), (tests.u('cup'), tests.u('org1'), 'organizer');

-- amy signed in on a session of her own: 'seb' inside Safe Exam Browser, 'other' in another browser
create function pg_temp.as_amy(p_session text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', tests.u('amy'), 'role', 'authenticated',
    'aal', 'aal2', 'session_id', p_session)::text, true);
  select set_config('role', 'authenticated', true);
$$;
-- the address SEB hashes, with a fresh nonce in it
create function pg_temp.check_url() returns text language sql as $$
  select 'https://bogey.test/api/x/lockdown/seb-check?event=' || tests.u('cup') || '&nonce='
    || public.lockdown_seb_nonce(tests.u('cup'));
$$;
create function pg_temp.config_hash(p_url text) returns text language sql as $$
  select encode(extensions.digest(p_url || repeat('b', 64), 'sha256'), 'hex');
$$;
grant execute on function pg_temp.as_amy(text), pg_temp.check_url(), pg_temp.config_hash(text) to authenticated;
create temp table urls (name text primary key, url text);
grant all on urls to authenticated;

select pg_temp.as_amy('seb');
select ok(not public.lockdown_seb_ready(tests.u('cup')), 'with no file and no keys, SEB can''t pass');
insert into urls values ('empty', pg_temp.check_url());
select ok(not public.lockdown_check_seb(tests.u('cup'), (select url from urls where name = 'empty'), '', ''),
  'and no browser does');
select is(private.event_gate(tests.u('cup')), 'lockdown.seb', 'so the event stays closed');
reset role;

select tests.as_user(tests.u('org1'));
select public.lockdown_save_seb_config(tests.u('cup'), '{}', '<plist/>', repeat('b', 64));
reset role;

select pg_temp.as_amy('seb');
select ok(public.lockdown_seb_ready(tests.u('cup')), 'a saved file makes it ready');
select ok(not public.lockdown_check_seb(tests.u('cup'), 'https://bogey.test/x', '',
  pg_temp.config_hash('https://bogey.test/x')), 'a matching hash without a nonce fails');
insert into urls values ('seb', pg_temp.check_url());
select ok(public.lockdown_check_seb(tests.u('cup'), (select url from urls where name = 'seb'), '',
  pg_temp.config_hash((select url from urls where name = 'seb'))), 'SEB with the file and a nonce passes');
select is(private.event_gate(tests.u('cup')), null, 'and opens the event to SEB');
reset role;

select pg_temp.as_amy('other');
select is(private.event_gate(tests.u('cup')), 'lockdown.seb',
  'another browser signed in as amy stays closed without a check of its own');
insert into urls values ('other', pg_temp.check_url());
select ok(not public.lockdown_check_seb(tests.u('cup'), (select url from urls where name = 'other'), '', ''),
  'and fails its check');
reset role;

select pg_temp.as_amy('seb');
select is(private.event_gate(tests.u('cup')), null, 'which leaves SEB open');
select ok(not public.lockdown_check_seb(tests.u('cup'), (select url from urls where name = 'seb'), '',
  pg_temp.config_hash((select url from urls where name = 'seb'))), 'the same header again fails: no replays');
select is(private.event_gate(tests.u('cup')), 'lockdown.seb',
  'and a failed check closes SEB at once, not three minutes later');
insert into urls values ('broken', pg_temp.check_url());
select ok(not public.lockdown_check_seb(tests.u('cup'), (select url from urls where name = 'broken'), '', ''),
  'SEB whose configuration changed fails too');
reset role;

select * from finish();
rollback;

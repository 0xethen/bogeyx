-- Lockdown with the challenges extension (which ships with Bogey): enforce mode stops submissions.
begin;
select plan(4);

insert into public.orgs (id, slug, name) values (tests.u('org'), 'alpha', 'Alpha');
insert into public.events (id, org_id, slug, name, kind, visibility, team_size_max) values
  (tests.u('cup'), tests.u('org'), 'cup', 'Cup', 'contest', 'public', 1);
insert into public.settings (scope, event_id, namespace, value) values
  ('event', tests.u('cup'), 'plugins', '{"enabled":["challenges","lockdown"]}'),
  ('event', tests.u('cup'), 'plugin.challenges', '{"languages":"python"}'),
  ('event', tests.u('cup'), 'plugin.lockdown', '{"mode":"enforce","maxViolations":2}');
insert into public.event_windows (event_id, key, opens_at, closes_at) values
  (tests.u('cup'), 'challenges.contest', now() - interval '2 hours', now() + interval '1 hour');
insert into public.challenges_problems (id, event_id, label, slug, title) values
  (tests.u('pb'), tests.u('cup'), 'B', 'b', 'Bits');
select tests.create_user(tests.u('ben'), 'ben@t.test', '{"full_name":"ben"}');
insert into public.event_members (event_id, user_id, role) values (tests.u('cup'), tests.u('ben'), 'participant');

select tests.as_user(tests.u('ben'));
select lives_ok($$select public.challenges_submit(tests.u('pb'), 'python', 'x')$$, 'under the limit, submitting works');
select lives_ok($$select public.lockdown_violation(tests.u('cup'), 'tab_switch')$$, 'a first violation');
select lives_ok($$select public.lockdown_violation(tests.u('cup'), 'tab_switch')$$, 'a second violation');
reset role;
-- out of the cooldown between solutions
update public.challenges_solutions set submitted_at = submitted_at - interval '1 minute' where event_id = tests.u('cup');
select tests.as_user(tests.u('ben'));
select throws_ok($$select public.challenges_submit(tests.u('pb'), 'python', 'x')$$, 'P0001',
  'submissions are stopped after leaving the page too often; talk to an organizer', 'enforce stops submissions at the limit');
reset role;

select * from finish();
rollback;

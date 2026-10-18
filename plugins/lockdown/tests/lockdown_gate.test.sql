-- Lockdown 1.1: the cover holds on the server. A covered participant holds no permission in the event.
begin;
select plan(15);

insert into public.orgs (id, slug, name) values (tests.u('org'), 'alpha', 'Alpha');
insert into public.events (id, org_id, slug, name, kind, visibility, team_size_max) values
  (tests.u('cup'), tests.u('org'), 'cup', 'Cup', 'contest', 'unlisted', 1);
insert into public.settings (scope, event_id, namespace, value) values
  ('event', tests.u('cup'), 'plugins', '{"enabled":["lockdown"]}'),
  ('event', tests.u('cup'), 'plugin.lockdown', '{"mode":"enforce","maxViolations":5}');
select tests.create_user(tests.u(n), n || '@t.test', jsonb_build_object('full_name', n)) from unnest(array['amy','org1']) n;
insert into public.event_members (event_id, user_id, role) values
  (tests.u('cup'), tests.u('amy'), 'participant'), (tests.u('cup'), tests.u('org1'), 'organizer');

select tests.as_user(tests.u('amy'));
select is(public.event_gate(tests.u('cup')), 'lockdown.fullscreen', 'full screen is required until the page says otherwise');
select ok(not private.has_permission(tests.u('cup'), 'event.view'), 'so the event is shut to them');
select ok(public.settings_for(array['plugin.lockdown'], null, tests.u('cup')) ? 'plugin.lockdown',
  'though they still read lockdown''s settings');
select lives_ok($$select public.lockdown_heartbeat(tests.u('cup'), p_fullscreen => false)$$, 'and can still report');

select lives_ok($$select public.lockdown_heartbeat(tests.u('cup'), p_fullscreen => true)$$, 'the page enters full screen');
select is(public.event_gate(tests.u('cup')), null, 'which opens the event');
select ok(private.has_permission(tests.u('cup'), 'event.view'), 'and their permissions');
reset role;
select is((select count(*)::integer from public.audit_log where event_id = tests.u('cup') and action = 'lockdown.fullscreen_entered'),
  1, 'the claim is written down');

select tests.as_user(tests.u('amy'));
select public.lockdown_violation(tests.u('cup'), 'fullscreen_exit');
select is(public.event_gate(tests.u('cup')), 'lockdown.fullscreen', 'leaving full screen shuts it at once');
reset role;

update public.lockdown_sessions set fullscreen_at = now(), heartbeat_at = now() - interval '5 minutes'
where event_id = tests.u('cup') and user_id = tests.u('amy');
select tests.as_user(tests.u('amy'));
select is(public.event_gate(tests.u('cup')), 'lockdown.fullscreen', 'a page gone quiet doesn''t keep it open');
reset role;

update public.lockdown_sessions set heartbeat_at = now(), locked_at = now()
where event_id = tests.u('cup') and user_id = tests.u('amy');
select tests.as_user(tests.u('amy'));
select is(public.event_gate(tests.u('cup')), 'lockdown.stopped', 'someone stopped stays shut out');
reset role;

select tests.as_user(tests.u('org1'));
select is(public.event_gate(tests.u('cup')), null, 'organizers are never gated');
reset role;

insert into public.event_windows (event_id, key, opens_at, closes_at) values
  (tests.u('cup'), 'submissions', now() - interval '2 hours', now() - interval '1 hour');
select tests.as_user(tests.u('amy'));
select is(public.event_gate(tests.u('cup')), null, 'lockdown lifts once submissions close, as the page does');
reset role;
insert into public.event_windows (event_id, key, opens_at, closes_at) values
  (tests.u('cup'), 'challenges.contest', now() - interval '1 hour', now() + interval '1 hour');
select tests.as_user(tests.u('amy'));
select is(public.event_gate(tests.u('cup')), 'lockdown.stopped', 'though an open contest is what counts when there is one');
reset role;

update public.settings set value = '{"mode":"off"}' where event_id = tests.u('cup') and namespace = 'plugin.lockdown';
select tests.as_user(tests.u('amy'));
select is(public.event_gate(tests.u('cup')), null, 'lockdown off gates no one');

select * from finish();
rollback;

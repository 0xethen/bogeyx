-- Sounds: who reads and changes an event's sounds, saving a setup, removing an upload, linked sounds, the size limit.
begin;
select plan(21);

insert into public.orgs (id, slug, name) values (tests.u('org'), 'alpha', 'Alpha');
insert into public.events (id, org_id, slug, name, visibility, starts_at, ends_at)
values (tests.u('ev'), tests.u('org'), 'ev', 'Ev', 'public', '2026-10-10 16:00Z', '2026-10-11 16:00Z');
insert into public.settings (scope, event_id, namespace, value)
values ('event', tests.u('ev'), 'plugins', '{"enabled":["sounds"]}');
select tests.create_user(tests.u(n), n || '@t.test') from unnest(array['own','pa','out']) n;
insert into public.org_members (org_id, user_id, role) values (tests.u('org'), tests.u('own'), 'owner');
insert into public.event_members (event_id, user_id, role) values (tests.u('ev'), tests.u('pa'), 'participant');
-- files already in the bucket, as an upload leaves them
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('sounds', tests.u('ev') || '/song.mp3', tests.u('own'), '{"size": 3000000}'),
  ('sounds', tests.u('ev') || '/ding.mp3', tests.u('own'), '{"size": 20000}');

select tests.as_user(tests.u('pa'));
select throws_ok(
  format($$select public.sounds_add_file(%L, 'Song', %L, 'audio/mpeg', 3000000, 180000)$$,
    tests.u('ev'), tests.u('ev') || '/song.mp3'),
  '42501', null, 'participants can''t add sounds');
reset role;

select tests.as_user(tests.u('own'));
select throws_ok(
  format($$select public.sounds_add_file(%L, 'Ghost', %L, 'audio/mpeg', 10, 1000)$$,
    tests.u('ev'), tests.u('ev') || '/missing.mp3'),
  '22023', null, 'a file has to be uploaded first');
select lives_ok(
  format($$select public.sounds_add_file(%L, 'Song', %L, 'audio/mpeg', 3000000, 180000)$$,
    tests.u('ev'), tests.u('ev') || '/song.mp3'),
  'organizers add an upload');
select lives_ok(
  format($$select public.sounds_add_file(%L, ' Ding ', %L, 'audio/mpeg', 20000, 600)$$,
    tests.u('ev'), tests.u('ev') || '/ding.mp3'),
  'and another');
select is((select name from public.sounds_files where event_id = tests.u('ev') and size_bytes = 20000),
  'Ding', 'names are trimmed');

select lives_ok(
  format($$select public.sounds_save_setup(%L,
    jsonb_build_array(jsonb_build_object('id', %L::uuid, 'name', 'Final song', 'preload', true, 'playlist_position', 0)),
    jsonb_build_array(
      jsonb_build_object('signal', 'announcement.posted', 'file_id', %L::uuid, 'builtin', null, 'volume', 80),
      jsonb_build_object('signal', 'challenges.accepted', 'file_id', null, 'builtin', 'none', 'volume', 100)),
    jsonb_build_array(
      jsonb_build_object('id', %L::uuid, 'label', 'Countdown', 'file_id', %L::uuid, 'anchor', 'event.end', 'align', 'end'),
      jsonb_build_object('label', 'Closing', 'builtin', 'tick', 'anchor', 'window.close', 'window_key', 'submissions', 'offset_seconds', -300)))$$,
    tests.u('ev'),
    (select id from public.sounds_files where event_id = tests.u('ev') and size_bytes = 3000000),
    (select id from public.sounds_files where event_id = tests.u('ev') and size_bytes = 20000),
    tests.u('cue'),
    (select id from public.sounds_files where event_id = tests.u('ev') and size_bytes = 3000000)),
  'organizers save the library, effects and cues together');
select is((select preload from public.sounds_files where event_id = tests.u('ev') and size_bytes = 3000000),
  true, 'the library''s details are saved');
select is((select count(*)::int from public.sounds_effects where event_id = tests.u('ev')), 2, 'effects are saved');
select is((select sort from public.sounds_cues where id = tests.u('cue')), 1, 'cues keep their ids and order');
select throws_ok(
  format($$select public.sounds_save_setup(%L, '[]', '[]',
    jsonb_build_array(jsonb_build_object('label', 'Bad', 'builtin', 'chime', 'anchor', 'window.open')))$$,
    tests.u('ev')),
  '23514', null, 'a window cue needs a window');
reset role;

select tests.as_user(tests.u('pa'));
select is((select count(*)::int from public.sounds_cues where event_id = tests.u('ev')), 2,
  'participants read the cues, to play them');
reset role;

select tests.as_user(tests.u('out'));
select is((select count(*)::int from public.sounds_files where event_id = tests.u('ev')), 2,
  'anyone who can see the event reads its sounds, like its public files');
reset role;

select tests.as_user(tests.u('own'));
select is(
  public.sounds_remove_file((select id from public.sounds_files where event_id = tests.u('ev') and size_bytes = 20000)),
  tests.u('ev') || '/ding.mp3', 'removing an upload returns its path');
select is((select count(*)::int from public.sounds_effects where event_id = tests.u('ev') and file_id is not null), 0,
  'and its effects go back to their defaults');
reset role;

-- linked sounds
select tests.as_user(tests.u('pa'));
select throws_ok(
  format($$select public.sounds_link_file(%L, 'Theme', 'https://cdn.test/theme.mp3', 90000)$$, tests.u('ev')),
  '42501', null, 'participants can''t link sounds');
reset role;
select tests.as_user(tests.u('own'));
select throws_ok(
  format($$select public.sounds_link_file(%L, 'Theme', 'http://cdn.test/theme.mp3', 90000)$$, tests.u('ev')),
  '23514', null, 'a link is https');
select lives_ok(
  format($$select public.sounds_link_file(%L, 'Theme', 'https://cdn.test/theme.mp3', 90000)$$, tests.u('ev')),
  'organizers link a sound');
select is(
  (select action from public.audit_log where event_id = tests.u('ev') order by created_at desc, id desc limit 1),
  'sounds.linked', 'which is audited');
select is(
  public.sounds_remove_file((select id from public.sounds_files where link is not null)),
  null, 'removing a link has no file to clean up');
reset role;

insert into public.org_limit_overrides (org_id, limits) values (tests.u('org'), '{"sounds.maxLibraryMb": 1}');
insert into storage.objects (bucket_id, name, owner, metadata)
values ('sounds', tests.u('ev') || '/big.mp3', tests.u('own'), '{"size": 900000}');
select tests.as_user(tests.u('own'));
select throws_ok(
  format($$select public.sounds_add_file(%L, 'Big', %L, 'audio/mpeg', 900000, 60000)$$,
    tests.u('ev'), tests.u('ev') || '/big.mp3'),
  '23514', null, 'an event''s library stays under its limit');
reset role;

update public.settings set value = '{"enabled":[]}' where event_id = tests.u('ev') and namespace = 'plugins';
select tests.as_user(tests.u('pa'));
select is((select count(*)::int from public.sounds_cues where event_id = tests.u('ev')), 0,
  'nothing is read while the extension is off');
reset role;

select * from finish();
rollback;

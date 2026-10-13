-- Leaderboard: hidden answers stay hidden, scoring, the daily cap, public and private boards, ranking.
begin;
select plan(16);

insert into public.orgs (id, slug, name) values (tests.u('org'), 'alpha', 'Alpha');
insert into public.events (id, org_id, slug, name, visibility, team_size_min, team_size_max)
values (tests.u('ev'), tests.u('org'), 'ev', 'Ev', 'public', 1, 4);
insert into public.event_windows (event_id, key, override) values (tests.u('ev'), 'submissions', 'open');
insert into public.settings (scope, event_id, namespace, value)
values ('event', tests.u('ev'), 'plugins', '{"enabled":["leaderboard"]}');
insert into public.submission_forms (id, event_id, key, title) values (tests.u('form'), tests.u('ev'), 'project', 'Project');
insert into public.submission_items (id, event_id, form_id, key, label, kind, config) values
  (tests.u('acc'), tests.u('ev'), tests.u('form'), 'preds', 'Predictions', 'leaderboard.predictions',
   '{"metric":"accuracy","publicPercent":50,"dailyLimit":2}'),
  (tests.u('err'), tests.u('ev'), tests.u('form'), 'errs', 'Errors', 'leaderboard.predictions',
   '{"metric":"rmse","publicPercent":50}');
select tests.create_user(tests.u(n), n || '@t.test') from unnest(array['own','pa','pb']) n;
insert into public.org_members (org_id, user_id, role) values (tests.u('org'), tests.u('own'), 'owner');
insert into public.event_members (event_id, user_id, role) values
  (tests.u('ev'), tests.u('pa'), 'participant'), (tests.u('ev'), tests.u('pb'), 'participant');
insert into public.teams (id, event_id, name) values (tests.u('ta'), tests.u('ev'), 'A'), (tests.u('tb'), tests.u('ev'), 'B');
insert into public.team_members (event_id, team_id, user_id) values
  (tests.u('ev'), tests.u('ta'), tests.u('pa')), (tests.u('ev'), tests.u('tb'), tests.u('pb'));
insert into public.submissions (id, event_id, form_id, team_id, title, status) values
  (tests.u('sa'), tests.u('ev'), tests.u('form'), tests.u('ta'), 'A', 'draft'),
  (tests.u('sb'), tests.u('ev'), tests.u('form'), tests.u('tb'), 'B', 'draft');

-- answers: ids 1..20, label a for odd ids, b for even; and 40 numbers for the rmse task
create temp table answers on commit drop as select
  (select 'id,answer' || E'\n' || string_agg(i || ',' || case when i % 2 = 1 then 'a' else 'b' end, E'\n' order by i) from generate_series(1, 20) i) as acc,
  (select 'id,answer' || E'\n' || string_agg(i || ',' || i, E'\n' order by i) from generate_series(1, 40) i) as err;
grant select on answers to authenticated;

select tests.as_user(tests.u('pa'));
select throws_ok(format($$select public.leaderboard_set_answers(%L, (select acc from answers))$$, tests.u('acc')), '42501', null, 'participants can''t set the answers');
reset role;
select tests.as_user(tests.u('own'));
select is(public.leaderboard_set_answers(tests.u('acc'), (select acc from answers)), 20, 'organizers upload the answers');
select is(public.leaderboard_set_answers(tests.u('err'), (select err from answers)), 40, 'one per task');
reset role;
select tests.as_user(tests.u('pa'));
select is((select count(*)::integer from public.leaderboard_answers), 0, 'nobody reads the answers back');

-- scoring
select is((select public_score from public.leaderboard_submit(tests.u('acc'),
  (select 'id,prediction' || E'\n' || string_agg(i || ',' || case when i % 2 = 1 then 'a' else 'b' end, E'\n') from generate_series(1, 20) i))),
  1::double precision, 'a perfect file scores 1');
select throws_ok(format($$select public.leaderboard_submit(%L, 'id,prediction%s1,a')$$, tests.u('acc'), E'\n'), '22023', null, 'a file missing ids is refused');
select is((select count(*)::integer from public.leaderboard_submit(tests.u('acc'),
  (select 'id,prediction' || E'\n' || string_agg(i || ',a', E'\n') from generate_series(1, 20) i))), 1, 'a second try scores');
select throws_ok(format($$select public.leaderboard_submit(%L, 'id,prediction')$$, tests.u('acc')), '22023', null, 'the third try today is over the cap');
select is((select count(*)::integer from public.leaderboard_my_attempts(tests.u('acc'))), 2, 'a team lists its tries');
select is((select public_score from public.leaderboard_submit(tests.u('err'),
  (select 'id,prediction' || E'\n' || string_agg(i || ',' || (i + 1), E'\n') from generate_series(1, 40) i))),
  1::double precision, 'rmse of values one off is 1');
select is((select count(*)::integer from public.leaderboard_attempts), 0, 'the attempts table, with private scores, is closed to teams');
select throws_ok(format($$select * from public.leaderboard_board(%L)$$, tests.u('acc')), '42501', null, 'the board stays shut until its window opens');
reset role;

insert into public.event_windows (event_id, key, override) values (tests.u('ev'), 'leaderboard.board', 'open');
select tests.as_user(tests.u('pb'));
select is((select count(*)::integer from public.leaderboard_board(tests.u('acc')) where private_score is null), 1, 'once open, everyone sees public scores only');
select is((select count(*)::integer from public.leaderboard_my_attempts(tests.u('acc'))), 0, 'and tries stay with their team');
reset role;
select tests.as_user(tests.u('own'));
select is((select count(*)::integer from public.leaderboard_board(tests.u('acc')) where private_score is not null), 1, 'organizers also see private scores');
reset role;

-- ranking by the leaderboard once entries are submitted
update public.judging_rounds set method = 'leaderboard.score' where form_id = tests.u('form');
update public.submissions set status = 'submitted', submitted_at = now() where id = tests.u('sa');
select tests.as_user(tests.u('own'));
select public.leaderboard_refresh(tests.u('ev'));
reset role;
select is((select count(*)::integer from public.ranking_inputs where event_id = tests.u('ev')), 1, 'the submitted entry has a score');

select * from finish();
rollback;

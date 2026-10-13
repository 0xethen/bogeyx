-- Extra Judging: pairwise, peer rating, ranked ballots and points budgets.
begin;
select plan(39);

insert into public.orgs (id, slug, name) values (tests.u('org'), 'alpha', 'Alpha');
insert into public.events (id, org_id, slug, name, visibility, team_size_min, team_size_max)
values (tests.u('ev'), tests.u('org'), 'ev', 'Ev', 'public', 1, 4);
insert into public.event_windows (event_id, key, override) values
  (tests.u('ev'), 'judging', 'open'), (tests.u('ev'), 'extra-judging.rating', 'open');
insert into public.settings (scope, event_id, namespace, value) values
  ('event', tests.u('ev'), 'plugins', '{"enabled":["extra-judging"]}'),
  ('event', tests.u('ev'), 'plugin.extra-judging',
   '{"peerCriteria":"Fun\nTheme","peerMaxScore":5,"peerMinRatings":2,"peerPerPerson":2,"budget":10}');
insert into public.submission_forms (id, event_id, key, title) values (tests.u('form'), tests.u('ev'), 'project', 'Project');
select tests.create_user(tests.u(n), n || '@t.test') from unnest(array['own','j1','j2','pa','pb','pc','pd']) n;
insert into public.org_members (org_id, user_id, role) values (tests.u('org'), tests.u('own'), 'owner');
insert into public.event_members (event_id, user_id, role) values
  (tests.u('ev'), tests.u('j1'), 'judge'), (tests.u('ev'), tests.u('j2'), 'judge');
insert into public.event_members (event_id, user_id, role)
select tests.u('ev'), tests.u(n), 'participant' from unnest(array['pa','pb','pc','pd']) n;
insert into public.teams (id, event_id, name) values
  (tests.u('ta'), tests.u('ev'), 'A'), (tests.u('tb'), tests.u('ev'), 'B'),
  (tests.u('tc'), tests.u('ev'), 'C'), (tests.u('td'), tests.u('ev'), 'D');
insert into public.team_members (event_id, team_id, user_id) values
  (tests.u('ev'), tests.u('ta'), tests.u('pa')), (tests.u('ev'), tests.u('tb'), tests.u('pb')),
  (tests.u('ev'), tests.u('tc'), tests.u('pc')), (tests.u('ev'), tests.u('td'), tests.u('pd'));
insert into public.submissions (id, event_id, form_id, team_id, title, status, submitted_at) values
  (tests.u('sa'), tests.u('ev'), tests.u('form'), tests.u('ta'), 'A', 'submitted', now()),
  (tests.u('sb'), tests.u('ev'), tests.u('form'), tests.u('tb'), 'B', 'submitted', now()),
  (tests.u('sc'), tests.u('ev'), tests.u('form'), tests.u('tc'), 'C', 'submitted', now()),
  (tests.u('sd'), tests.u('ev'), tests.u('form'), tests.u('td'), 'D', 'submitted', now());
create temporary table round_of on commit drop as
  select id from public.judging_rounds where form_id = tests.u('form');
grant select on round_of to authenticated;

-- ── pairwise ──
select tests.as_user(tests.u('j1'));
select throws_ok($$select public.xj_pairwise_choose(tests.u('sa'), tests.u('sb'))$$, '22023', null, 'a round on the rubric takes no comparisons');
reset role;
update public.judging_rounds set method = 'extra-judging.pairwise' where form_id = tests.u('form');
select is((select count(*)::integer from public.audit_log where event_id = tests.u('ev') and action = 'judging.method_set'), 1, 'setting the method is audited by core');

select tests.as_user(tests.u('pa'));
select throws_ok($$select public.xj_pairwise_choose(tests.u('sa'), tests.u('sb'))$$, '42501', null, 'participants can''t compare');
reset role;
select tests.as_user(tests.u('j1'));
select lives_ok($$select public.xj_pairwise_choose(tests.u('sa'), tests.u('sb'))$$, 'a judge picks A over B');
select lives_ok($$select public.xj_pairwise_choose(tests.u('sb'), tests.u('sc'))$$, 'and B over C');
select lives_ok($$select public.xj_pairwise_choose(tests.u('sc'), tests.u('sd'))$$, 'and C over D');
select isnt((select id from public.xj_pairwise_next(tests.u('sa'))), tests.u('sb'), 'the next entry is one not yet compared with A');
reset role;
select is(
  (select array_agg(s.title order by ri.score desc) from public.ranking_inputs ri
   join public.submissions s on s.id = ri.submission_id where ri.event_id = tests.u('ev')),
  array['A', 'B', 'C', 'D'], 'the fit ranks A above B above C above D');

select tests.as_user(tests.u('j1'));
select lives_ok($$select public.xj_pairwise_choose(tests.u('sb'), tests.u('sa'))$$, 'a judge can change their mind');
reset role;
select is((select count(*)::integer from public.xj_comparisons where judge_id = tests.u('j1')), 3, 'without adding a row');

select tests.as_user(tests.u('j2'));
select is((select count(*)::integer from public.xj_comparisons where event_id = tests.u('ev')), 0, 'other judges can''t read the picks');
select lives_ok($$select public.xj_set_absent(tests.u('sd'), true)$$, 'a judge marks a team absent');
reset role;
select is((select count(*)::integer from public.ranking_inputs where submission_id = tests.u('sd')), 0, 'it drops out of the ranking');
select is((select count(*)::integer from public.audit_log where event_id = tests.u('ev') and action = 'extra-judging.absent'), 1, 'and that is audited');
select tests.as_user(tests.u('own'));
select is((select count(*)::integer from public.xj_pairwise_agreement(tests.u('ev'))), 1, 'organizers see judge agreement');
reset role;

-- ── ranked ballots ──
update public.judging_rounds set method = 'extra-judging.ranked' where form_id = tests.u('form');
delete from public.ranking_inputs where event_id = tests.u('ev');
insert into public.judge_assignments (event_id, judge_id, submission_id) values
  (tests.u('ev'), tests.u('j1'), tests.u('sa')), (tests.u('ev'), tests.u('j1'), tests.u('sb')),
  (tests.u('ev'), tests.u('j1'), tests.u('sc'));
insert into public.judge_conflicts (event_id, judge_id, team_id, reason, declared_by)
values (tests.u('ev'), tests.u('j2'), tests.u('tc'), 'friend', tests.u('own'));

select tests.as_user(tests.u('j1'));
select is((select count(*)::integer from public.xj_sheet((select id from round_of))), 3, 'a judge''s sheet holds their assignments');
select is((select count(*)::integer from public.xj_sheet((select id from round_of), tests.u('sd'))), 4, 'and the entry they have open');
select throws_ok(format($$select public.xj_save_ballot(%L, array[%L, %L]::uuid[])$$, (select id from round_of), tests.u('sa'), tests.u('sa')),
  '22023', null, 'an entry is ranked once');
select lives_ok(format($$select public.xj_save_ballot(%L, array[%L, %L, %L]::uuid[])$$, (select id from round_of), tests.u('sb'), tests.u('sa'), tests.u('sc')),
  'a judge saves a ballot');
select is((select array_agg(submission_id order by place) from public.xj_sheet((select id from round_of))),
  array[tests.u('sb'), tests.u('sa'), tests.u('sc')], 'the sheet comes back in ballot order');
reset role;
select tests.as_user(tests.u('j2'));
select throws_ok(format($$select public.xj_save_ballot(%L, array[%L, %L]::uuid[])$$, (select id from round_of), tests.u('sa'), tests.u('sc')),
  '22023', null, 'a judge can''t rank a team they have a conflict with');
select lives_ok(format($$select public.xj_save_ballot(%L, array[%L, %L]::uuid[])$$, (select id from round_of), tests.u('sa'), tests.u('sb')),
  'another judge saves theirs');
reset role;
select is((select score from public.ranking_inputs where submission_id = tests.u('sb')), 50.00, 'B is first once and last once: 50');
select is((select score from public.ranking_inputs where submission_id = tests.u('sc')), 0.00, 'C is last on its only ballot: 0');
select is((select (detail ->> 'ballots')::integer from public.ranking_inputs where submission_id = tests.u('sa')), 2, 'A is on two ballots');

-- ── points budget ──
update public.judging_rounds set method = 'extra-judging.budget' where form_id = tests.u('form');
delete from public.ranking_inputs where event_id = tests.u('ev');
select tests.as_user(tests.u('j1'));
select lives_ok($$select public.xj_allocate(tests.u('sa'), 6)$$, 'a judge puts points on an entry');
select throws_ok($$select public.xj_allocate(tests.u('sb'), 5)$$, '22023', null, 'the total can''t pass the budget');
select lives_ok($$select public.xj_allocate(tests.u('sb'), 4)$$, 'up to the budget is fine');
select lives_ok($$select public.xj_allocate(tests.u('sa'), 0)$$, 'zero takes points back');
reset role;
select is((select count(*)::integer from public.xj_allocations where judge_id = tests.u('j1')), 1, 'leaving one allocation');
select is((select score from public.ranking_inputs where submission_id = tests.u('sb')), 4::numeric, 'the score is the points received');
select tests.as_user(tests.u('j2'));
select throws_ok($$select public.xj_allocate(tests.u('sc'), 1)$$, '42501', null, 'not on a conflicted team');
reset role;

-- ── peer rating ──
update public.judging_rounds set method = 'extra-judging.peer' where form_id = tests.u('form');
delete from public.ranking_inputs where event_id = tests.u('ev');
select tests.as_user(tests.u('pa'));
select is(public.xj_peer_claim(tests.u('ev')), 2, 'a rater is given peerPerPerson projects');
select is((select count(*)::integer from public.xj_peer_mine(tests.u('ev')) where submission_id = tests.u('sa')), 0, 'and not their own');
select throws_ok(format($$select public.xj_peer_rate(%L, '{"Fun":3}')$$, (select submission_id from public.xj_peer_mine(tests.u('ev')) limit 1)),
  '22023', null, 'every criterion needs a mark');
select lives_ok(format($$select public.xj_peer_rate(%L, '{"Fun":4,"Theme":4}')$$, (select submission_id from public.xj_peer_mine(tests.u('ev')) limit 1)),
  'a complete rating saves');
reset role;
select is((select count(*)::integer from public.ranking_inputs where event_id = tests.u('ev')), 0, 'one rating is not enough to rank');
insert into public.xj_peer_ratings (event_id, round_id, rater_id, submission_id, scores)
select event_id, round_id, tests.u('pd'), submission_id, '{"Fun":5,"Theme":3}'
from public.xj_peer_ratings where rater_id = tests.u('pa');
select private.xj_peer_rerank((select id from round_of));
select is((select score from public.ranking_inputs where event_id = tests.u('ev')), 80.00, 'two ratings (4,4) and (5,3) average 4 of 5, so 80');
select tests.as_user(tests.u('pa'));
select throws_ok($$select * from public.xj_peer_summary(tests.u('ev'))$$, '42501', null, 'raters can''t read the summary');
reset role;

select * from finish();
rollback;

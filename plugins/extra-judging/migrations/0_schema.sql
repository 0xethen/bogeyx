-- extra-judging plugin: four ranking methods besides the rubric, each `extra-judging.<key>`:
--   pairwise  judges pick the better of two entries; a Bradley-Terry fit of every pick is the score
--   peer      participants rate other teams' entries while `extra-judging.rating` is open
--   ranked    each judge orders the entries they saw; a Borda count of the ballots is the score
--   budget    each judge spreads a budget of points over entries; the points received are the score
-- Settings (namespace `plugin.extra-judging`, defaults in manifest.ts and repeated below):
--   peerCriteria (one per line, up to 8), peerMaxScore, peerMinRatings, peerMode 'assigned'|'chosen',
--   peerPerPerson, rankedMinBallots, budget.
-- Audit actions: extra-judging.absent, extra-judging.present.

create function private.xj_setting(p_event uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.event_setting(p_event, 'plugin.extra-judging'), '{}');
$$;
revoke execute on function private.xj_setting(uuid) from public, anon, authenticated;

-- the entries of a round: submitted, in its form, and (after round 1) advanced into it
create function private.xj_round_entries(p_round uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from public.judging_rounds r
  join public.submissions s on s.event_id = r.event_id and s.form_id = r.form_id and s.status = 'submitted'
  where r.id = p_round
    and (r.ordinal = 1 or exists (
      select 1 from public.round_entries e where e.round_id = r.id and e.submission_id = s.id));
$$;
revoke execute on function private.xj_round_entries(uuid) from public, anon, authenticated;

-- the round, when the caller is a judge who may judge it now with the given method
create function private.xj_assert_judge(p_round uuid, p_method text)
returns public.judging_rounds
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
begin
  select * into v_round from public.judging_rounds where id = p_round;
  if v_round.id is null
    or not private.plugin_enabled(v_round.event_id, 'extra-judging')
    or not private.has_permission(v_round.event_id, 'judging.score') then
    raise exception 'only judges can do this' using errcode = '42501';
  end if;
  if v_round.method <> 'extra-judging.' || p_method then
    raise exception 'this round is not ranked that way' using errcode = '22023';
  end if;
  if not private.round_window_open(p_round) then
    raise exception 'judging is closed' using errcode = '42501';
  end if;
  return v_round;
end;
$$;
revoke execute on function private.xj_assert_judge(uuid, text) from public, anon, authenticated;

-- true when the judge declared (or was given) a conflict with the entry's team
create function private.xj_conflicted(p_judge uuid, p_submission uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.submissions s
    join public.judge_conflicts jc on jc.team_id = s.team_id and jc.judge_id = p_judge
    where s.id = p_submission);
$$;
revoke execute on function private.xj_conflicted(uuid, uuid) from public, anon, authenticated;

-- ─── pairwise ───────────────────────────────────────────────────────────────────────────────

create table public.xj_comparisons (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  round_id uuid not null,
  judge_id uuid not null,
  winner_id uuid not null,
  loser_id uuid not null,
  created_at timestamptz not null default now(),
  check (winner_id <> loser_id),
  foreign key (event_id, round_id) references public.judging_rounds (event_id, id) on delete cascade,
  foreign key (event_id, judge_id) references public.event_members (event_id, user_id) on delete cascade,
  foreign key (event_id, winner_id) references public.submissions (event_id, id) on delete cascade,
  foreign key (event_id, loser_id) references public.submissions (event_id, id) on delete cascade
);
-- a judge compares a pair once; choosing again replaces the earlier pick
create unique index xj_comparisons_pair_idx on public.xj_comparisons
  (round_id, judge_id, least(winner_id, loser_id), greatest(winner_id, loser_id));
create index xj_comparisons_event_id_round_id_fk_idx on public.xj_comparisons (event_id, round_id);
create index xj_comparisons_event_id_judge_id_fk_idx on public.xj_comparisons (event_id, judge_id);
create index xj_comparisons_event_id_winner_id_fk_idx on public.xj_comparisons (event_id, winner_id);
create index xj_comparisons_event_id_loser_id_fk_idx on public.xj_comparisons (event_id, loser_id);
alter table public.xj_comparisons enable row level security;
create policy xj_comparisons_select on public.xj_comparisons for select to authenticated
  using ((select private.can_manage(event_id)) or judge_id = (select auth.uid()));

-- entries whose team isn't at the table; they leave the round's comparisons and ranking
create table public.xj_absent (
  event_id uuid not null,
  round_id uuid not null,
  submission_id uuid not null,
  marked_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  primary key (round_id, submission_id),
  foreign key (event_id, round_id) references public.judging_rounds (event_id, id) on delete cascade,
  foreign key (event_id, submission_id) references public.submissions (event_id, id) on delete cascade
);
create index xj_absent_event_id_round_id_fk_idx on public.xj_absent (event_id, round_id);
create index xj_absent_event_id_submission_id_fk_idx on public.xj_absent (event_id, submission_id);
create index xj_absent_marked_by_fk_idx on public.xj_absent (marked_by);
alter table public.xj_absent enable row level security;
create policy xj_absent_select on public.xj_absent for select to authenticated
  using ((select private.has_permission(event_id, 'judging.score')) or (select private.can_manage(event_id)));

-- Fits Bradley-Terry strengths to the round's picks and writes each entry's score (the log of its
-- strength). Every entry also plays one half-won game against an average entry, which keeps entries
-- with no losses (or no wins) finite. Entries nobody has compared score 0, the average.
create function private.xj_pairwise_rerank(p_round uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
  v_ids uuid[];
  v_n integer;
  v_wins double precision[];
  v_games integer[];
  v_w integer[];
  v_l integer[];
  v_p double precision[];
  v_next double precision[];
  v_denom double precision[];
  v_term double precision;
  v_mean double precision;
  v_change double precision;
  v_i integer;
  v_k integer;
begin
  select * into v_round from public.judging_rounds where id = p_round;
  if v_round.id is null or v_round.method <> 'extra-judging.pairwise' then
    return;
  end if;

  select array_agg(e.id order by e.id) into v_ids
  from private.xj_round_entries(p_round) e(id)
  where not exists (select 1 from public.xj_absent a where a.round_id = p_round and a.submission_id = e.id);
  v_n := coalesce(cardinality(v_ids), 0);

  -- absent entries have no score in this round
  delete from public.ranking_inputs ri
  where ri.round_id = p_round and ri.provider = 'extra-judging.pairwise'
    and (v_n = 0 or ri.submission_id <> all (v_ids));
  if v_n = 0 then
    return;
  end if;

  select coalesce(array_agg(w.i), '{}'), coalesce(array_agg(l.i), '{}') into v_w, v_l
  from public.xj_comparisons c
  join (select id, ordinality::integer as i from unnest(v_ids) with ordinality as t(id, ordinality)) w on w.id = c.winner_id
  join (select id, ordinality::integer as i from unnest(v_ids) with ordinality as t(id, ordinality)) l on l.id = c.loser_id
  where c.round_id = p_round;

  v_wins := array_fill(0.5::double precision, array[v_n]);
  v_games := array_fill(0, array[v_n]);
  v_p := array_fill(1::double precision, array[v_n]);
  for v_k in 1 .. coalesce(cardinality(v_w), 0) loop
    v_wins[v_w[v_k]] := v_wins[v_w[v_k]] + 1;
    v_games[v_w[v_k]] := v_games[v_w[v_k]] + 1;
    v_games[v_l[v_k]] := v_games[v_l[v_k]] + 1;
  end loop;

  -- minorization-maximization: strength = wins / sum over games of 1 / (own + opponent)
  for v_k in 1 .. 200 loop
    v_denom := array_fill(0::double precision, array[v_n]);
    for v_i in 1 .. v_n loop
      v_denom[v_i] := 1 / (v_p[v_i] + 1);
    end loop;
    for v_i in 1 .. coalesce(cardinality(v_w), 0) loop
      v_term := 1 / (v_p[v_w[v_i]] + v_p[v_l[v_i]]);
      v_denom[v_w[v_i]] := v_denom[v_w[v_i]] + v_term;
      v_denom[v_l[v_i]] := v_denom[v_l[v_i]] + v_term;
    end loop;
    v_next := array_fill(0::double precision, array[v_n]);
    v_mean := 0;
    for v_i in 1 .. v_n loop
      v_next[v_i] := v_wins[v_i] / v_denom[v_i];
      v_mean := v_mean + ln(v_next[v_i]);
    end loop;
    v_mean := exp(v_mean / v_n);
    v_change := 0;
    for v_i in 1 .. v_n loop
      v_next[v_i] := v_next[v_i] / v_mean;
      v_change := greatest(v_change, abs(ln(v_next[v_i]) - ln(v_p[v_i])));
    end loop;
    v_p := v_next;
    exit when v_change < 0.000001;
  end loop;

  for v_i in 1 .. v_n loop
    perform private.set_ranking_input(p_round, v_ids[v_i], 'extra-judging.pairwise',
      round(ln(v_p[v_i])::numeric, 4),
      jsonb_build_object(
        'comparisons', v_games[v_i],
        'wins', (select count(*) from public.xj_comparisons c
                 where c.round_id = p_round and c.winner_id = v_ids[v_i])));
  end loop;
end;
$$;
revoke execute on function private.xj_pairwise_rerank(uuid) from public, anon, authenticated;

-- The entry to set beside p_submission for this judge: one they haven't compared it with, that is
-- here, and that they have no conflict with; the least compared first.
create function public.xj_pairwise_next(p_submission uuid)
returns table (id uuid, title text, table_label text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
  v_judge uuid := (select auth.uid());
begin
  v_round := private.xj_assert_judge(private.active_round(p_submission), 'pairwise');
  if exists (select 1 from public.xj_absent a where a.round_id = v_round.id and a.submission_id = p_submission) then
    return;
  end if;
  return query
  select s.id, s.title, s.table_label
  from public.submissions s
  where s.id in (select private.xj_round_entries(v_round.id))
    and s.id <> p_submission
    and not exists (select 1 from public.xj_absent a where a.round_id = v_round.id and a.submission_id = s.id)
    and not exists (select 1 from public.judge_conflicts jc where jc.judge_id = v_judge and jc.team_id = s.team_id)
    and not exists (
      select 1 from public.xj_comparisons c
      where c.round_id = v_round.id and c.judge_id = v_judge
        and least(c.winner_id, c.loser_id) = least(s.id, p_submission)
        and greatest(c.winner_id, c.loser_id) = greatest(s.id, p_submission))
  order by
    (select count(*) from public.xj_comparisons c
     where c.round_id = v_round.id and (c.winner_id = s.id or c.loser_id = s.id)),
    random()
  limit 1;
end;
$$;
revoke execute on function public.xj_pairwise_next(uuid) from public, anon;
grant execute on function public.xj_pairwise_next(uuid) to authenticated;

-- records which of two entries the judge found better, replacing an earlier pick of the same pair
create function public.xj_pairwise_choose(p_winner uuid, p_loser uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
  v_judge uuid := (select auth.uid());
begin
  if p_winner = p_loser then
    raise exception 'pick two different entries' using errcode = '22023';
  end if;
  v_round := private.xj_assert_judge(private.active_round(p_winner), 'pairwise');
  if private.active_round(p_loser) is distinct from v_round.id then
    raise exception 'both entries must be in the same round' using errcode = '22023';
  end if;
  if private.xj_conflicted(v_judge, p_winner) or private.xj_conflicted(v_judge, p_loser) or exists (
    select 1 from public.xj_absent a
    where a.round_id = v_round.id and a.submission_id in (p_winner, p_loser)
  ) then
    raise exception 'that pair can''t be compared' using errcode = '42501';
  end if;
  -- the unique index is on the unordered pair, so a flipped pick replaces the old row
  delete from public.xj_comparisons c
  where c.round_id = v_round.id and c.judge_id = v_judge
    and least(c.winner_id, c.loser_id) = least(p_winner, p_loser)
    and greatest(c.winner_id, c.loser_id) = greatest(p_winner, p_loser);
  insert into public.xj_comparisons (event_id, round_id, judge_id, winner_id, loser_id)
  values (v_round.event_id, v_round.id, v_judge, p_winner, p_loser);
  perform private.xj_pairwise_rerank(v_round.id);
end;
$$;
revoke execute on function public.xj_pairwise_choose(uuid, uuid) from public, anon;
grant execute on function public.xj_pairwise_choose(uuid, uuid) to authenticated;

-- marks an entry absent (its team isn't at the table) or back; it drops out of the round's ranking
create function public.xj_set_absent(p_submission uuid, p_absent boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
begin
  v_round := private.xj_assert_judge(private.active_round(p_submission), 'pairwise');
  if p_absent then
    insert into public.xj_absent (event_id, round_id, submission_id, marked_by)
    values (v_round.event_id, v_round.id, p_submission, (select auth.uid()))
    on conflict do nothing;
  else
    delete from public.xj_absent where round_id = v_round.id and submission_id = p_submission;
  end if;
  perform private.audit(v_round.event_id,
    case when p_absent then 'extra-judging.absent' else 'extra-judging.present' end,
    'submission', p_submission, jsonb_build_object('round', v_round.name));
  perform private.xj_pairwise_rerank(v_round.id);
end;
$$;
revoke execute on function public.xj_set_absent(uuid, boolean) from public, anon;
grant execute on function public.xj_set_absent(uuid, boolean) to authenticated;

-- how often each judge's picks agree with the round's ranking, for organizers
create function public.xj_pairwise_agreement(p_event uuid)
returns table (round_id uuid, round_name text, judge_id uuid, judge_name text, comparisons integer, agreement numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.plugin_enabled(p_event, 'extra-judging') or not private.can_manage(p_event) then
    raise exception 'only organizers can see this' using errcode = '42501';
  end if;
  return query
  select c.round_id, r.name, c.judge_id, p.display_name, count(*)::integer,
    round(avg((coalesce(w.score, 0) >= coalesce(l.score, 0))::integer), 3)
  from public.xj_comparisons c
  join public.judging_rounds r on r.id = c.round_id
  join public.profiles p on p.id = c.judge_id
  left join public.ranking_inputs w on w.round_id = c.round_id and w.submission_id = c.winner_id
  left join public.ranking_inputs l on l.round_id = c.round_id and l.submission_id = c.loser_id
  where c.event_id = p_event
  group by c.round_id, r.name, r.ordinal, c.judge_id, p.display_name
  order by r.ordinal, count(*) desc;
end;
$$;
revoke execute on function public.xj_pairwise_agreement(uuid) from public, anon;
grant execute on function public.xj_pairwise_agreement(uuid) to authenticated;

-- ─── peer rating ────────────────────────────────────────────────────────────────────────────

create table public.xj_peer_assignments (
  event_id uuid not null,
  round_id uuid not null,
  rater_id uuid not null,
  submission_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (rater_id, submission_id),
  foreign key (event_id, round_id) references public.judging_rounds (event_id, id) on delete cascade,
  foreign key (event_id, rater_id) references public.event_members (event_id, user_id) on delete cascade,
  foreign key (event_id, submission_id) references public.submissions (event_id, id) on delete cascade
);
create index xj_peer_assignments_event_id_round_id_fk_idx on public.xj_peer_assignments (event_id, round_id);
create index xj_peer_assignments_event_id_rater_id_fk_idx on public.xj_peer_assignments (event_id, rater_id);
create index xj_peer_assignments_event_id_submission_id_fk_idx on public.xj_peer_assignments (event_id, submission_id);
alter table public.xj_peer_assignments enable row level security;
create policy xj_peer_assignments_select on public.xj_peer_assignments for select to authenticated
  using ((select private.can_manage(event_id)) or rater_id = (select auth.uid()));

-- one row per rater and project; scores is { criterion: number }
create table public.xj_peer_ratings (
  event_id uuid not null,
  round_id uuid not null,
  rater_id uuid not null,
  submission_id uuid not null,
  scores jsonb not null check (jsonb_typeof(scores) = 'object' and pg_column_size(scores) <= 2048),
  updated_at timestamptz not null default now(),
  primary key (rater_id, submission_id),
  foreign key (event_id, round_id) references public.judging_rounds (event_id, id) on delete cascade,
  foreign key (event_id, rater_id) references public.event_members (event_id, user_id) on delete cascade,
  foreign key (event_id, submission_id) references public.submissions (event_id, id) on delete cascade
);
create index xj_peer_ratings_event_id_round_id_fk_idx on public.xj_peer_ratings (event_id, round_id);
create index xj_peer_ratings_event_id_rater_id_fk_idx on public.xj_peer_ratings (event_id, rater_id);
create index xj_peer_ratings_event_id_submission_id_fk_idx on public.xj_peer_ratings (event_id, submission_id);
alter table public.xj_peer_ratings enable row level security;
-- the people being rated never read who gave what
create policy xj_peer_ratings_select on public.xj_peer_ratings for select to authenticated
  using ((select private.can_manage(event_id)) or rater_id = (select auth.uid()));

-- the organizer's criteria: one per non-empty line, at most 8, each up to 60 characters
create function private.xj_peer_criteria(p_event uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select array_agg(left(c, 60)) from (
       select btrim(l) as c
       from unnest(string_to_array(coalesce(private.xj_setting(p_event) ->> 'peerCriteria', 'Overall'), E'\n')) l
       where btrim(l) <> '' limit 8) t),
    array['Overall']);
$$;
revoke execute on function private.xj_peer_criteria(uuid) from public, anon, authenticated;

-- the round an entry would be rated in, null unless that round is ranked by peer ratings
create function private.xj_peer_round(p_submission uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id
  from public.submissions s
  join public.judging_rounds r on r.id = private.active_round(s.id)
  where s.id = p_submission and s.status = 'submitted' and r.method = 'extra-judging.peer';
$$;
revoke execute on function private.xj_peer_round(uuid) from public, anon, authenticated;

-- a project's score is its average rating as a percent of the top mark; projects with too few
-- ratings are left out of the round's ranking
create function private.xj_peer_rerank(p_round uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
  v_setting jsonb;
  v_max numeric;
  v_min integer;
  v_row record;
begin
  select * into v_round from public.judging_rounds where id = p_round;
  if v_round.id is null or v_round.method <> 'extra-judging.peer' then
    return;
  end if;
  v_setting := private.xj_setting(v_round.event_id);
  v_max := coalesce((v_setting ->> 'peerMaxScore')::numeric, 5);
  v_min := coalesce((v_setting ->> 'peerMinRatings')::integer, 3);
  delete from public.ranking_inputs ri
  where ri.round_id = p_round and ri.provider = 'extra-judging.peer'
    and ri.submission_id not in (
      select pr.submission_id from public.xj_peer_ratings pr where pr.round_id = p_round
      group by pr.submission_id having count(*) >= v_min);
  for v_row in
    select pr.submission_id, count(*) as n,
      avg((select avg(v.value::numeric) from jsonb_each_text(pr.scores) v)) as mean
    from public.xj_peer_ratings pr
    where pr.round_id = p_round
    group by pr.submission_id
    having count(*) >= v_min
  loop
    perform private.set_ranking_input(p_round, v_row.submission_id, 'extra-judging.peer',
      round(v_row.mean / v_max * 100, 2), jsonb_build_object('ratings', v_row.n));
  end loop;
end;
$$;
revoke execute on function private.xj_peer_rerank(uuid) from public, anon, authenticated;

-- true when the caller is a participant allowed to rate right now
create function private.xj_assert_rater(p_event uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.plugin_enabled(p_event, 'extra-judging')
    or not private.has_permission(p_event, 'event.compete') then
    raise exception 'only participants can rate projects' using errcode = '42501';
  end if;
  if not private.window_open(p_event, 'extra-judging.rating') then
    raise exception 'rating is closed' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function private.xj_assert_rater(uuid) from public, anon, authenticated;

-- Gives the caller projects to rate and returns how many they now hold. 'assigned' mode fills up to
-- peerPerPerson with the least-rated projects of other teams; 'chosen' mode adds p_submission.
create function public.xj_peer_claim(p_event uuid, p_submission uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_setting jsonb;
  v_cap integer;
  v_have integer;
  v_pick record;
begin
  perform private.xj_assert_rater(p_event);
  v_setting := private.xj_setting(p_event);
  v_cap := coalesce((v_setting ->> 'peerPerPerson')::integer, 5);
  select count(*) into v_have from public.xj_peer_assignments where rater_id = v_me and event_id = p_event;

  if coalesce(v_setting ->> 'peerMode', 'assigned') = 'chosen' then
    if p_submission is null then
      raise exception 'pick a project' using errcode = '22023';
    end if;
    if v_have >= v_cap then
      raise exception 'you can rate % projects', v_cap using errcode = '22023';
    end if;
    insert into public.xj_peer_assignments (event_id, round_id, rater_id, submission_id)
    select s.event_id, private.xj_peer_round(s.id), v_me, s.id
    from public.submissions s
    where s.id = p_submission and s.event_id = p_event and private.xj_peer_round(s.id) is not null
      and s.team_id is distinct from private.my_team(p_event)
    on conflict do nothing;
    if not found and not exists (
      select 1 from public.xj_peer_assignments where rater_id = v_me and submission_id = p_submission) then
      raise exception 'that project can''t be rated' using errcode = '22023';
    end if;
  else
    for v_pick in
      select s.id, private.xj_peer_round(s.id) as round_id
      from public.submissions s
      where s.event_id = p_event and private.xj_peer_round(s.id) is not null
        and s.team_id is distinct from private.my_team(p_event)
        and not exists (select 1 from public.xj_peer_assignments a where a.rater_id = v_me and a.submission_id = s.id)
      order by (select count(*) from public.xj_peer_assignments a where a.submission_id = s.id), random()
      limit greatest(v_cap - v_have, 0)
    loop
      insert into public.xj_peer_assignments (event_id, round_id, rater_id, submission_id)
      values (p_event, v_pick.round_id, v_me, v_pick.id);
    end loop;
  end if;
  return (select count(*)::integer from public.xj_peer_assignments where rater_id = v_me and event_id = p_event);
end;
$$;
revoke execute on function public.xj_peer_claim(uuid, uuid) from public, anon;
grant execute on function public.xj_peer_claim(uuid, uuid) to authenticated;

-- saves the caller's rating of a project they hold; p_scores is { criterion: number }
create function public.xj_peer_rate(p_submission uuid, p_scores jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_assignment public.xj_peer_assignments;
  v_criteria text[];
  v_max numeric;
  v_key text;
  v_value jsonb;
begin
  select * into v_assignment from public.xj_peer_assignments where rater_id = v_me and submission_id = p_submission;
  if v_assignment.rater_id is null then
    raise exception 'that project isn''t one of yours to rate' using errcode = '42501';
  end if;
  perform private.xj_assert_rater(v_assignment.event_id);
  if private.xj_peer_round(p_submission) is distinct from v_assignment.round_id then
    raise exception 'that project can''t be rated now' using errcode = '22023';
  end if;
  v_criteria := private.xj_peer_criteria(v_assignment.event_id);
  v_max := coalesce((private.xj_setting(v_assignment.event_id) ->> 'peerMaxScore')::numeric, 5);
  if jsonb_typeof(p_scores) <> 'object' or (select count(*) from jsonb_object_keys(p_scores)) <> cardinality(v_criteria) then
    raise exception 'rate every criterion' using errcode = '22023';
  end if;
  for v_key, v_value in select * from jsonb_each(p_scores) loop
    if v_key <> all (v_criteria) or jsonb_typeof(v_value) <> 'number'
      or (v_value #>> '{}')::numeric not between 1 and v_max then
      raise exception 'each score is 1 to %', v_max using errcode = '22023';
    end if;
  end loop;
  insert into public.xj_peer_ratings (event_id, round_id, rater_id, submission_id, scores)
  values (v_assignment.event_id, v_assignment.round_id, v_me, p_submission, p_scores)
  on conflict (rater_id, submission_id) do update set scores = excluded.scores, updated_at = now();
  perform private.xj_peer_rerank(v_assignment.round_id);
end;
$$;
revoke execute on function public.xj_peer_rate(uuid, jsonb) from public, anon;
grant execute on function public.xj_peer_rate(uuid, jsonb) to authenticated;

-- the caller's projects, with what they gave; the page reads this rather than the submissions
create function public.xj_peer_mine(p_event uuid)
returns table (submission_id uuid, title text, table_label text, scores jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.plugin_enabled(p_event, 'extra-judging') or (select auth.uid()) is null then
    raise exception 'not available' using errcode = '42501';
  end if;
  return query
  select a.submission_id, s.title, s.table_label, r.scores
  from public.xj_peer_assignments a
  join public.submissions s on s.id = a.submission_id
  left join public.xj_peer_ratings r on r.rater_id = a.rater_id and r.submission_id = a.submission_id
  where a.event_id = p_event and a.rater_id = (select auth.uid())
  order by a.created_at;
end;
$$;
revoke execute on function public.xj_peer_mine(uuid) from public, anon;
grant execute on function public.xj_peer_mine(uuid) to authenticated;

-- the projects a person could pick to rate in 'chosen' mode: other teams' entries they don't hold yet
create function public.xj_peer_candidates(p_event uuid)
returns table (submission_id uuid, title text, table_label text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.xj_assert_rater(p_event);
  return query
  select s.id, s.title, s.table_label
  from public.submissions s
  where s.event_id = p_event and private.xj_peer_round(s.id) is not null
    and s.team_id is distinct from private.my_team(p_event)
    and not exists (
      select 1 from public.xj_peer_assignments a
      where a.rater_id = (select auth.uid()) and a.submission_id = s.id)
  order by s.title;
end;
$$;
revoke execute on function public.xj_peer_candidates(uuid) from public, anon;
grant execute on function public.xj_peer_candidates(uuid) to authenticated;

-- for organizers: how many ratings each project has and whether it ranks yet
create function public.xj_peer_summary(p_event uuid)
returns table (round_name text, submission_id uuid, title text, ratings integer, average numeric, ranked boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.plugin_enabled(p_event, 'extra-judging') or not private.can_manage(p_event) then
    raise exception 'only organizers can see this' using errcode = '42501';
  end if;
  return query
  select r.name, s.id, s.title, count(pr.rater_id)::integer,
    round(avg((select avg(v.value::numeric) from jsonb_each_text(pr.scores) v)), 2),
    exists (select 1 from public.ranking_inputs ri where ri.round_id = r.id and ri.submission_id = s.id)
  from public.submissions s
  join public.judging_rounds r on r.id = private.xj_peer_round(s.id)
  left join public.xj_peer_ratings pr on pr.submission_id = s.id and pr.round_id = r.id
  where s.event_id = p_event
  group by r.id, r.name, r.ordinal, s.id, s.title
  order by r.ordinal, count(pr.rater_id) desc, s.title;
end;
$$;
revoke execute on function public.xj_peer_summary(uuid) from public, anon;
grant execute on function public.xj_peer_summary(uuid) to authenticated;

-- ─── ranked ballots and points budgets ──────────────────────────────────────────────────────

-- a judge's ranking of the entries they saw in a round: position 1 is their favorite
create table public.xj_ballots (
  event_id uuid not null,
  round_id uuid not null,
  judge_id uuid not null,
  submission_id uuid not null,
  position smallint not null check (position between 1 and 500),
  updated_at timestamptz not null default now(),
  primary key (round_id, judge_id, submission_id),
  unique (round_id, judge_id, position) deferrable initially deferred,
  foreign key (event_id, round_id) references public.judging_rounds (event_id, id) on delete cascade,
  foreign key (event_id, judge_id) references public.event_members (event_id, user_id) on delete cascade,
  foreign key (event_id, submission_id) references public.submissions (event_id, id) on delete cascade
);
create index xj_ballots_event_id_round_id_fk_idx on public.xj_ballots (event_id, round_id);
create index xj_ballots_event_id_judge_id_fk_idx on public.xj_ballots (event_id, judge_id);
create index xj_ballots_event_id_submission_id_fk_idx on public.xj_ballots (event_id, submission_id);
alter table public.xj_ballots enable row level security;
create policy xj_ballots_select on public.xj_ballots for select to authenticated
  using ((select private.can_manage(event_id)) or judge_id = (select auth.uid()));

-- the points a judge put on an entry in a round ranked by budget
create table public.xj_allocations (
  event_id uuid not null,
  round_id uuid not null,
  judge_id uuid not null,
  submission_id uuid not null,
  points integer not null check (points > 0),
  updated_at timestamptz not null default now(),
  primary key (round_id, judge_id, submission_id),
  foreign key (event_id, round_id) references public.judging_rounds (event_id, id) on delete cascade,
  foreign key (event_id, judge_id) references public.event_members (event_id, user_id) on delete cascade,
  foreign key (event_id, submission_id) references public.submissions (event_id, id) on delete cascade
);
create index xj_allocations_event_id_round_id_fk_idx on public.xj_allocations (event_id, round_id);
create index xj_allocations_event_id_judge_id_fk_idx on public.xj_allocations (event_id, judge_id);
create index xj_allocations_event_id_submission_id_fk_idx on public.xj_allocations (event_id, submission_id);
alter table public.xj_allocations enable row level security;
create policy xj_allocations_select on public.xj_allocations for select to authenticated
  using ((select private.can_manage(event_id)) or judge_id = (select auth.uid()));

-- Borda count: on a ballot of n entries, place p earns (n - p) / (n - 1); an entry's score is its
-- average over the ballots it is on, as a percent. Ballots of one entry say nothing and are skipped.
create function private.xj_ranked_rerank(p_round uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
  v_min integer;
  v_row record;
begin
  select * into v_round from public.judging_rounds where id = p_round;
  if v_round.id is null or v_round.method <> 'extra-judging.ranked' then
    return;
  end if;
  v_min := coalesce((private.xj_setting(v_round.event_id) ->> 'rankedMinBallots')::integer, 1);
  delete from public.ranking_inputs ri
  where ri.round_id = p_round and ri.provider = 'extra-judging.ranked';
  for v_row in
    with sizes as (
      select b.judge_id, count(*) as size from public.xj_ballots b where b.round_id = p_round group by b.judge_id
    )
    select b.submission_id, count(*) as ballots,
      avg((z.size - b.position)::numeric / (z.size - 1)) as mean, avg(b.position) as place
    from public.xj_ballots b
    join sizes z on z.judge_id = b.judge_id and z.size > 1
    where b.round_id = p_round
    group by b.submission_id
    having count(*) >= v_min
  loop
    perform private.set_ranking_input(p_round, v_row.submission_id, 'extra-judging.ranked',
      round(v_row.mean * 100, 2),
      jsonb_build_object('ballots', v_row.ballots, 'averagePlace', round(v_row.place, 2)));
  end loop;
end;
$$;
revoke execute on function private.xj_ranked_rerank(uuid) from public, anon, authenticated;

-- the points each entry received in total; entries with none have no score
create function private.xj_budget_rerank(p_round uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
  v_row record;
begin
  select * into v_round from public.judging_rounds where id = p_round;
  if v_round.id is null or v_round.method <> 'extra-judging.budget' then
    return;
  end if;
  delete from public.ranking_inputs ri
  where ri.round_id = p_round and ri.provider = 'extra-judging.budget'
    and ri.submission_id not in (select a.submission_id from public.xj_allocations a where a.round_id = p_round);
  for v_row in
    select a.submission_id, sum(a.points) as points, count(*) as judges
    from public.xj_allocations a
    where a.round_id = p_round
    group by a.submission_id
  loop
    perform private.set_ranking_input(p_round, v_row.submission_id, 'extra-judging.budget',
      v_row.points, jsonb_build_object('judges', v_row.judges));
  end loop;
end;
$$;
revoke execute on function private.xj_budget_rerank(uuid) from public, anon, authenticated;

-- The entries on the caller's ballot or budget sheet for a round: the ones they are assigned, the
-- ones they already placed, and p_include (the entry they have open), minus conflicts. Ranked
-- entries come first in their order; points are the caller's for budget rounds.
create function public.xj_sheet(p_round uuid, p_include uuid default null)
returns table (submission_id uuid, title text, table_label text, place integer, points integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
  v_judge uuid := (select auth.uid());
begin
  select * into v_round from public.judging_rounds where id = p_round;
  if v_round.id is null or not private.plugin_enabled(v_round.event_id, 'extra-judging')
    or not private.has_permission(v_round.event_id, 'judging.score') then
    raise exception 'only judges can do this' using errcode = '42501';
  end if;
  return query
  select s.id, s.title, s.table_label, b.position::integer, a.points
  from public.submissions s
  left join public.xj_ballots b on b.round_id = p_round and b.judge_id = v_judge and b.submission_id = s.id
  left join public.xj_allocations a on a.round_id = p_round and a.judge_id = v_judge and a.submission_id = s.id
  where s.id in (select private.xj_round_entries(p_round))
    and not private.xj_conflicted(v_judge, s.id)
    and (s.id = p_include or b.submission_id is not null or a.submission_id is not null
      or exists (select 1 from public.judge_assignments ja
                 where ja.round_id = p_round and ja.judge_id = v_judge and ja.submission_id = s.id))
  order by b.position nulls last, s.table_label nulls last, s.title;
end;
$$;
revoke execute on function public.xj_sheet(uuid, uuid) from public, anon;
grant execute on function public.xj_sheet(uuid, uuid) to authenticated;

-- replaces the caller's ballot for a round with p_order, best first
create function public.xj_save_ballot(p_round uuid, p_order uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
  v_judge uuid := (select auth.uid());
begin
  v_round := private.xj_assert_judge(p_round, 'ranked');
  if coalesce(cardinality(p_order), 0) > 500 then
    raise exception 'rank up to 500 entries' using errcode = '22023';
  end if;
  if (select count(distinct x) from unnest(p_order) x) <> coalesce(cardinality(p_order), 0) then
    raise exception 'an entry can only be ranked once' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_order) x
    where x not in (select private.xj_round_entries(p_round)) or private.xj_conflicted(v_judge, x)
  ) then
    raise exception 'that entry can''t be ranked in this round' using errcode = '22023';
  end if;
  delete from public.xj_ballots where round_id = p_round and judge_id = v_judge;
  insert into public.xj_ballots (event_id, round_id, judge_id, submission_id, position)
  select v_round.event_id, p_round, v_judge, x.id, x.n
  from unnest(p_order) with ordinality as x(id, n);
  perform private.xj_ranked_rerank(p_round);
end;
$$;
revoke execute on function public.xj_save_ballot(uuid, uuid[]) from public, anon;
grant execute on function public.xj_save_ballot(uuid, uuid[]) to authenticated;

-- sets the caller's points on one entry (0 takes them back); their total can't pass the budget
create function public.xj_allocate(p_submission uuid, p_points integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
  v_judge uuid := (select auth.uid());
  v_budget integer;
  v_other integer;
begin
  v_round := private.xj_assert_judge(private.active_round(p_submission), 'budget');
  if p_points is null or p_points < 0 then
    raise exception 'points can''t be negative' using errcode = '22023';
  end if;
  if private.xj_conflicted(v_judge, p_submission) then
    raise exception 'you have a conflict with this team' using errcode = '42501';
  end if;
  v_budget := coalesce((private.xj_setting(v_round.event_id) ->> 'budget')::integer, 100);
  select coalesce(sum(points), 0) into v_other from public.xj_allocations
  where round_id = v_round.id and judge_id = v_judge and submission_id <> p_submission;
  if v_other + p_points > v_budget then
    raise exception 'that is more than your % points; % are left', v_budget, v_budget - v_other
      using errcode = '22023';
  end if;
  if p_points = 0 then
    delete from public.xj_allocations
    where round_id = v_round.id and judge_id = v_judge and submission_id = p_submission;
  else
    insert into public.xj_allocations (event_id, round_id, judge_id, submission_id, points)
    values (v_round.event_id, v_round.id, v_judge, p_submission, p_points)
    on conflict (round_id, judge_id, submission_id) do update set points = excluded.points, updated_at = now();
  end if;
  perform private.xj_budget_rerank(v_round.id);
end;
$$;
revoke execute on function public.xj_allocate(uuid, integer) from public, anon;
grant execute on function public.xj_allocate(uuid, integer) to authenticated;

-- for organizers: what each judge has done in rounds ranked by ballot or budget
create function public.xj_judge_progress(p_event uuid)
returns table (round_id uuid, round_name text, method text, judge_id uuid, judge_name text, entries integer, points integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.plugin_enabled(p_event, 'extra-judging') or not private.can_manage(p_event) then
    raise exception 'only organizers can see this' using errcode = '42501';
  end if;
  return query
  select r.id, r.name, r.method, x.judge_id, p.display_name, count(*)::integer, sum(x.points)::integer
  from (
    select b.round_id, b.judge_id, 0 as points from public.xj_ballots b where b.event_id = p_event
    union all
    select a.round_id, a.judge_id, a.points from public.xj_allocations a where a.event_id = p_event
  ) x
  join public.judging_rounds r on r.id = x.round_id
  join public.profiles p on p.id = x.judge_id
  group by r.id, r.name, r.ordinal, r.method, x.judge_id, p.display_name
  order by r.ordinal, p.display_name;
end;
$$;
revoke execute on function public.xj_judge_progress(uuid) from public, anon;
grant execute on function public.xj_judge_progress(uuid) to authenticated;

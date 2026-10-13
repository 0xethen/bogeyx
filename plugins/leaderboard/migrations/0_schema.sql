-- leaderboard plugin: scored file submissions, Kaggle style. An item of kind `leaderboard.predictions`
-- is the task. Config on the item: metric (accuracy|macro_f1|rmse|mae|log_loss), idColumn,
-- answerColumn (in the hidden answers file), valueColumn (in a team's predictions), publicPercent,
-- dailyLimit. Window `leaderboard.board` shows the public board. Ranking method `leaderboard.score`.
-- Audit actions: leaderboard.answers_set, leaderboard.submitted.

-- the hidden answers: no policy, so no client reads them; only the functions below do
create table public.leaderboard_answers (
  item_id uuid not null references public.submission_items on delete cascade,
  row_id text not null check (length(row_id) <= 200),
  answer text not null check (length(answer) <= 200),
  is_public boolean not null,
  primary key (item_id, row_id)
);
alter table public.leaderboard_answers enable row level security;

create table public.leaderboard_attempts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  item_id uuid not null references public.submission_items on delete cascade,
  submission_id uuid not null,
  submitted_by uuid references public.profiles on delete set null,
  public_score double precision not null,
  private_score double precision not null,
  created_at timestamptz not null default now(),
  foreign key (event_id, submission_id) references public.submissions (event_id, id) on delete cascade
);
create index leaderboard_attempts_item_id_submission_id_idx on public.leaderboard_attempts (item_id, submission_id, created_at desc);
create index leaderboard_attempts_event_id_submission_id_fk_idx on public.leaderboard_attempts (event_id, submission_id);
create index leaderboard_attempts_submitted_by_fk_idx on public.leaderboard_attempts (submitted_by);
alter table public.leaderboard_attempts enable row level security;
-- the private score stays with organizers; teams read their own through leaderboard_my_attempts
create policy leaderboard_attempts_select on public.leaderboard_attempts for select to authenticated
  using ((select private.can_manage(event_id)));

create function private.leaderboard_lower_better(p_metric text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_metric in ('rmse', 'mae', 'log_loss');
$$;

-- reads a CSV into (id, value) rows from the named columns. Quoted fields and "" escapes work.
create function private.leaderboard_parse(p_csv text, p_id_column text, p_value_column text)
returns table (row_id text, value text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_field constant text := '(?:^|,)(?:"((?:[^"]|"")*)"|([^,"]*))';
  v_header_line bigint;
  v_header text[];
  v_id integer;
  v_value integer;
begin
  select t.n, (select array_agg(btrim(coalesce(replace(m[1], '""', '"'), m[2])) order by o)
               from regexp_matches(regexp_replace(t.l, '^﻿', ''), c_field, 'g') with ordinality as x(m, o))
  into v_header_line, v_header
  from regexp_split_to_table(p_csv, E'\r?\n') with ordinality as t(l, n)
  where btrim(t.l) <> ''
  order by t.n
  limit 1;
  v_id := array_position(v_header, p_id_column);
  v_value := array_position(v_header, p_value_column);
  if v_id is null or v_value is null then
    raise exception 'the file needs columns "%" and "%"', p_id_column, p_value_column using errcode = '22023';
  end if;
  return query
  select parsed.cells[v_id], parsed.cells[v_value]
  from (
    select (select array_agg(btrim(coalesce(replace(m[1], '""', '"'), m[2])) order by o)
            from regexp_matches(t.l, c_field, 'g') with ordinality as x(m, o)) as cells
    from regexp_split_to_table(p_csv, E'\r?\n') with ordinality as t(l, n)
    where t.n > v_header_line and btrim(t.l) <> ''
  ) parsed
  where parsed.cells[v_id] is not null and parsed.cells[v_value] is not null;
end;
$$;

-- one split's score: the metric of the team's predictions against the hidden answers
create function private.leaderboard_metric(
  p_item uuid, p_metric text, p_public boolean, p_csv text, p_id_column text, p_value_column text
)
returns double precision
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_score double precision;
begin
  if p_metric not in ('accuracy', 'macro_f1', 'rmse', 'mae', 'log_loss') then
    raise exception 'unknown metric %', p_metric using errcode = '22023';
  end if;
  -- one statement, so the pairs are built once; only the chosen metric's branch is evaluated
  with pairs as materialized (
    select a.answer as truth, p.value as guess
    from public.leaderboard_answers a
    join private.leaderboard_parse(p_csv, p_id_column, p_value_column) p on p.row_id = a.row_id
    where a.item_id = p_item and a.is_public = p_public
  )
  select case p_metric
    when 'accuracy' then (select avg((truth = guess)::integer) from pairs)
    when 'macro_f1' then (
      select avg(case when 2 * tp + fp + fn = 0 then 0 else 2.0 * tp / (2 * tp + fp + fn) end)
      from (
        select c.cls,
          (select count(*) from pairs where truth = c.cls and guess = c.cls) as tp,
          (select count(*) from pairs where truth <> c.cls and guess = c.cls) as fp,
          (select count(*) from pairs where truth = c.cls and guess <> c.cls) as fn
        from (select distinct truth as cls from pairs) c
      ) f)
    when 'rmse' then (select sqrt(avg(power(truth::double precision - guess::double precision, 2))) from pairs)
    when 'mae' then (select avg(abs(truth::double precision - guess::double precision)) from pairs)
    else (
      select -avg(truth::integer * ln(q.p) + (1 - truth::integer) * ln(1 - q.p))
      from (select truth, least(greatest(guess::double precision, 1e-15), 1 - 1e-15) as p from pairs) q)
  end into v_score;
  return v_score;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'a value in the file isn''t the kind this metric needs' using errcode = '22023';
end;
$$;
revoke execute on function private.leaderboard_metric(uuid, text, boolean, text, text, text) from public, anon, authenticated;

-- writes each submitted entry's score for a round ranked by leaderboard.score: the private score of
-- the team's best attempt by public score, negated when lower is better
create function private.leaderboard_rerank(p_round uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.judging_rounds;
  v_item public.submission_items;
  v_metric text;
  v_row record;
begin
  select * into v_round from public.judging_rounds where id = p_round;
  if v_round.id is null or v_round.method <> 'leaderboard.score' then
    return;
  end if;
  select * into v_item from public.submission_items
  where form_id = v_round.form_id and kind = 'leaderboard.predictions' order by sort limit 1;
  if v_item.id is null then
    return;
  end if;
  v_metric := coalesce(v_item.config ->> 'metric', 'accuracy');
  for v_row in
    select distinct on (a.submission_id) a.submission_id, a.private_score, a.public_score,
      (select count(*) from public.leaderboard_attempts n where n.item_id = a.item_id and n.submission_id = a.submission_id) as attempts
    from public.leaderboard_attempts a
    join public.submissions s on s.id = a.submission_id and s.status = 'submitted'
    where a.item_id = v_item.id
    order by a.submission_id,
      case when private.leaderboard_lower_better(v_metric) then -a.public_score else a.public_score end desc,
      a.created_at
  loop
    if v_round.ordinal = 1 or exists (
      select 1 from public.round_entries e where e.round_id = p_round and e.submission_id = v_row.submission_id) then
      perform private.set_ranking_input(p_round, v_row.submission_id, 'leaderboard.score',
        (case when private.leaderboard_lower_better(v_metric) then -v_row.private_score else v_row.private_score end)::numeric,
        jsonb_build_object('metric', v_metric, 'private', v_row.private_score, 'attempts', v_row.attempts));
    end if;
  end loop;
end;
$$;
revoke execute on function private.leaderboard_rerank(uuid) from public, anon, authenticated;

-- an organizer's button: refresh every leaderboard round's ranking from the attempts so far (needed
-- once entries are submitted after their attempts)
create function public.leaderboard_refresh(p_event uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round uuid;
begin
  if not private.plugin_enabled(p_event, 'leaderboard') or not private.can_manage(p_event) then
    raise exception 'only organizers can refresh the ranking' using errcode = '42501';
  end if;
  for v_round in select r.id from public.judging_rounds r where r.event_id = p_event and r.method = 'leaderboard.score' loop
    perform private.leaderboard_rerank(v_round);
  end loop;
end;
$$;
revoke execute on function public.leaderboard_refresh(uuid) from public, anon;
grant execute on function public.leaderboard_refresh(uuid) to authenticated;

-- stores the hidden answers, each row going to the public or the private split by a seeded hash
-- of its id, so the split is the same every time. Replaces earlier answers until teams have submitted.
create function public.leaderboard_set_answers(p_item uuid, p_csv text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.submission_items;
  v_percent integer;
  v_rows integer;
begin
  select * into v_item from public.submission_items where id = p_item and kind = 'leaderboard.predictions';
  if v_item.id is null or not private.plugin_enabled(v_item.event_id, 'leaderboard') or not private.can_manage(v_item.event_id) then
    raise exception 'only organizers can set the answers' using errcode = '42501';
  end if;
  if length(p_csv) > 5000000 then
    raise exception 'the file is over 5 MB' using errcode = '22023';
  end if;
  if exists (select 1 from public.leaderboard_attempts where item_id = p_item) then
    raise exception 'teams have already submitted; the answers can''t change' using errcode = '22023';
  end if;
  v_percent := coalesce((v_item.config ->> 'publicPercent')::integer, 30);
  delete from public.leaderboard_answers where item_id = p_item;
  insert into public.leaderboard_answers (item_id, row_id, answer, is_public)
  select p_item, p.row_id, p.value,
    abs(('x' || substr(md5(p_item::text || p.row_id), 1, 7))::bit(28)::integer) % 100 < v_percent
  from private.leaderboard_parse(p_csv, coalesce(v_item.config ->> 'idColumn', 'id'),
    coalesce(v_item.config ->> 'answerColumn', 'answer')) p
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 or v_rows > 200000 then
    raise exception 'the answers file needs 1 to 200,000 rows' using errcode = '22023';
  end if;
  perform private.audit(v_item.event_id, 'leaderboard.answers_set', 'submission_item', p_item,
    jsonb_build_object('rows', v_rows));
  return v_rows;
end;
$$;
revoke execute on function public.leaderboard_set_answers(uuid, text) from public, anon;
grant execute on function public.leaderboard_set_answers(uuid, text) to authenticated;

-- scores a team's predictions; returns the public score and how many tries are left today
create function public.leaderboard_submit(p_item uuid, p_csv text)
returns table (attempt_id uuid, public_score double precision, tries_left integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.submission_items;
  v_sub public.submissions;
  v_metric text;
  v_id text;
  v_value text;
  v_limit integer;
  v_used integer;
  v_public double precision;
  v_private double precision;
  v_missing integer;
  v_attempt uuid;
  v_round uuid;
begin
  select * into v_item from public.submission_items where id = p_item and kind = 'leaderboard.predictions';
  if v_item.id is null or not private.plugin_enabled(v_item.event_id, 'leaderboard') then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into v_sub from public.submissions s
  where s.form_id = v_item.form_id and s.team_id = private.my_team(v_item.event_id);
  if v_sub.id is null then
    raise exception 'save your submission first, then send predictions' using errcode = '22023';
  end if;
  if not private.is_team_member(v_sub.team_id) or not private.team_write_allowed(v_item.form_id) then
    raise exception 'submissions are closed' using errcode = '42501';
  end if;
  if length(p_csv) > 5000000 then
    raise exception 'the file is over 5 MB' using errcode = '22023';
  end if;
  v_metric := coalesce(v_item.config ->> 'metric', 'accuracy');
  v_id := coalesce(v_item.config ->> 'idColumn', 'id');
  v_value := coalesce(v_item.config ->> 'valueColumn', 'prediction');
  v_limit := coalesce((v_item.config ->> 'dailyLimit')::integer, 5);
  select count(*) into v_used from public.leaderboard_attempts a
  where a.item_id = p_item and a.submission_id = v_sub.id and a.created_at > now() - interval '24 hours';
  if v_used >= v_limit then
    raise exception 'you have used today''s % tries', v_limit using errcode = '22023';
  end if;
  if not exists (select 1 from public.leaderboard_answers where item_id = p_item) then
    raise exception 'the organizers haven''t set up this task yet' using errcode = '22023';
  end if;
  -- every id the organizers hold must be predicted
  select count(*) into v_missing from public.leaderboard_answers a
  where a.item_id = p_item and not exists (
    select 1 from private.leaderboard_parse(p_csv, v_id, v_value) p where p.row_id = a.row_id);
  if v_missing > 0 then
    raise exception 'the file is missing predictions for % ids', v_missing using errcode = '22023';
  end if;
  v_public := private.leaderboard_metric(p_item, v_metric, true, p_csv, v_id, v_value);
  v_private := private.leaderboard_metric(p_item, v_metric, false, p_csv, v_id, v_value);
  if v_public is null or v_private is null then
    raise exception 'both splits need at least one row' using errcode = '22023';
  end if;
  insert into public.leaderboard_attempts (event_id, item_id, submission_id, submitted_by, public_score, private_score)
  values (v_item.event_id, p_item, v_sub.id, (select auth.uid()), v_public, v_private)
  returning id into v_attempt;
  -- the team's page shows the best public score as the item's answer
  update public.submissions s set answers = s.answers || jsonb_build_object(v_item.key, (
    select to_char(case when private.leaderboard_lower_better(v_metric) then min(a.public_score) else max(a.public_score) end, 'FM999990.0000')
    from public.leaderboard_attempts a where a.item_id = p_item and a.submission_id = v_sub.id))
  where s.id = v_sub.id;
  perform private.audit(v_item.event_id, 'leaderboard.submitted', 'submission', v_sub.id, jsonb_build_object('item', v_item.key));
  v_round := private.active_round(v_sub.id);
  if v_round is not null then
    perform private.leaderboard_rerank(v_round);
  end if;
  return query select v_attempt, v_public, v_limit - v_used - 1;
end;
$$;
revoke execute on function public.leaderboard_submit(uuid, text) from public, anon;
grant execute on function public.leaderboard_submit(uuid, text) to authenticated;

-- the caller's team's tries, public score only
create function public.leaderboard_my_attempts(p_item uuid)
returns table (attempt_id uuid, public_score double precision, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item public.submission_items;
begin
  select * into v_item from public.submission_items where id = p_item and kind = 'leaderboard.predictions';
  if v_item.id is null or not private.plugin_enabled(v_item.event_id, 'leaderboard') then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return query
  select a.id, a.public_score, a.created_at
  from public.leaderboard_attempts a
  join public.submissions s on s.id = a.submission_id
  where a.item_id = p_item and s.team_id = private.my_team(v_item.event_id) and private.is_team_member(s.team_id)
  order by a.created_at desc;
end;
$$;
revoke execute on function public.leaderboard_my_attempts(uuid) from public, anon;
grant execute on function public.leaderboard_my_attempts(uuid) to authenticated;

-- the tasks of an event: what a team or organizer can submit to or set up
create function public.leaderboard_tasks(p_event uuid)
returns table (item_id uuid, form_title text, label text, metric text, daily_limit integer, has_answers boolean, answer_rows integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.plugin_enabled(p_event, 'leaderboard') or not private.can_view_event(p_event) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return query
  select i.id, f.title, i.label, coalesce(i.config ->> 'metric', 'accuracy'),
    coalesce((i.config ->> 'dailyLimit')::integer, 5),
    exists (select 1 from public.leaderboard_answers a where a.item_id = i.id),
    case when private.can_manage(p_event) then (select count(*)::integer from public.leaderboard_answers a where a.item_id = i.id) else 0 end
  from public.submission_items i
  join public.submission_forms f on f.id = i.form_id
  where i.event_id = p_event and i.kind = 'leaderboard.predictions'
  order by f.sort, i.sort;
end;
$$;
revoke execute on function public.leaderboard_tasks(uuid) from public, anon;
grant execute on function public.leaderboard_tasks(uuid) to authenticated;

-- The board. While the leaderboard window is open it ranks by the public score. Once results are
-- published, or for organizers, it also shows each team's private score (of its best public attempt)
-- and ranks by that.
create function public.leaderboard_board(p_item uuid)
returns table (rank integer, team_name text, public_score double precision, private_score double precision, attempts integer, last_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item public.submission_items;
  v_metric text;
  v_reveal boolean;
  v_hide boolean;
begin
  select * into v_item from public.submission_items where id = p_item and kind = 'leaderboard.predictions';
  if v_item.id is null or not private.plugin_enabled(v_item.event_id, 'leaderboard') or not private.can_view_event(v_item.event_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  v_metric := coalesce(v_item.config ->> 'metric', 'accuracy');
  v_reveal := private.can_manage(v_item.event_id)
    or exists (select 1 from public.result_publications r where r.event_id = v_item.event_id);
  if not v_reveal and not private.window_open(v_item.event_id, 'leaderboard.board') then
    raise exception 'the leaderboard isn''t open' using errcode = '42501';
  end if;
  v_hide := private.hides_team_names(v_item.event_id);
  return query
  with best as (
    select distinct on (a.submission_id) a.submission_id, a.public_score, a.private_score, a.created_at
    from public.leaderboard_attempts a
    where a.item_id = p_item
    order by a.submission_id,
      case when private.leaderboard_lower_better(v_metric) then -a.public_score else a.public_score end desc,
      a.created_at
  ), counted as (
    select b.*, (select count(*)::integer from public.leaderboard_attempts n where n.item_id = p_item and n.submission_id = b.submission_id) as tries,
      (select max(n.created_at) from public.leaderboard_attempts n where n.item_id = p_item and n.submission_id = b.submission_id) as latest
    from best b
  )
  select (rank() over (order by
      case when private.leaderboard_lower_better(v_metric) then -1 else 1 end *
      (case when v_reveal then c.private_score else c.public_score end) desc))::integer,
    case when v_hide then 'Team' else t.name end,
    c.public_score,
    case when v_reveal then c.private_score end,
    c.tries, c.latest
  from counted c
  join public.submissions s on s.id = c.submission_id
  join public.teams t on t.id = s.team_id
  order by 1, c.latest;
end;
$$;
revoke execute on function public.leaderboard_board(uuid) from public, anon;
grant execute on function public.leaderboard_board(uuid) to authenticated;

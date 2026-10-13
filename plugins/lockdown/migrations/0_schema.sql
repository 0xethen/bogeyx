-- lockdown plugin: contest monitoring. A deterrent and a record, never proof.
-- Settings namespace `lockdown`: mode 'off'|'monitor'|'enforce'|'require_extension',
--   maxViolations (enforce), heartbeatSeconds (require_extension, default 60)

insert into public.roles (key, label, source) values ('lockdown.proctor', 'Proctor', 'lockdown')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission) values
  ('lockdown.proctor', 'lockdown.review'),
  ('lockdown.proctor', 'event.view');

create table public.lockdown_sessions (
  event_id uuid not null,
  user_id uuid not null,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  extension_version text,
  attested_at timestamptz,
  violations integer not null default 0,
  locked_at timestamptz,
  primary key (event_id, user_id),
  foreign key (event_id, user_id) references public.event_members on delete cascade
);

-- p_attested: the companion extension answered the page's nonce challenge
create function public.lockdown_heartbeat(p_event uuid, p_extension_version text default null, p_attested boolean default false)
returns public.lockdown_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.lockdown_sessions;
begin
  if not private.plugin_enabled(p_event, 'lockdown') or not private.has_permission(p_event, 'event.compete') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.lockdown_sessions (event_id, user_id, extension_version, attested_at)
  values (p_event, (select auth.uid()), p_extension_version, case when p_attested then now() end)
  on conflict (event_id, user_id) do update set
    heartbeat_at = now(),
    extension_version = coalesce(excluded.extension_version, public.lockdown_sessions.extension_version),
    attested_at = case when p_attested then now() else public.lockdown_sessions.attested_at end
  returning * into v_row;
  return v_row;
end;
$$;

-- p_kind: blur | fullscreen_exit | devtools | tab_switch | clipboard | new_window | …
create function public.lockdown_violation(p_event uuid, p_kind text, p_meta jsonb default '{}')
returns public.lockdown_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.lockdown_sessions;
  v_max integer := nullif(private.event_setting(p_event, 'lockdown') ->> 'maxViolations', '')::integer;
begin
  if p_kind !~ '^[a-z][a-z_]{1,30}$' then
    raise exception 'bad violation kind' using errcode = '22023';
  end if;
  perform public.lockdown_heartbeat(p_event);
  update public.lockdown_sessions set
    violations = violations + 1,
    locked_at = case when v_max is not null and violations + 1 >= v_max then coalesce(locked_at, now()) else locked_at end
  where event_id = p_event and user_id = (select auth.uid())
  returning * into v_row;
  perform private.audit(p_event, 'lockdown.' || p_kind, 'user', (select auth.uid()),
    p_meta || jsonb_build_object('violations', v_row.violations));
  return v_row;
end;
$$;

-- called by challenges_submit when lockdown is on for the event
create function private.lockdown_assert_can_submit(p_event uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings jsonb := private.event_setting(p_event, 'lockdown');
  v_mode text := coalesce(v_settings ->> 'mode', 'monitor');
  v_row public.lockdown_sessions;
begin
  if v_mode in ('off', 'monitor') then
    return;
  end if;
  select * into v_row from public.lockdown_sessions where event_id = p_event and user_id = (select auth.uid());
  if v_row.locked_at is not null then
    raise exception 'submissions are locked after too many lockdown violations; talk to an organizer'
      using errcode = 'P0001';
  end if;
  if v_mode = 'require_extension' and (
    v_row.attested_at is null
    or v_row.attested_at < now() - make_interval(secs => coalesce((v_settings ->> 'heartbeatSeconds')::integer, 60))
  ) then
    raise exception 'this contest requires the Bogey lockdown extension' using errcode = 'P0001';
  end if;
end;
$$;

-- organizers can clear a lock
create function public.lockdown_unlock(p_event uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_permission(p_event, 'lockdown.review') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.lockdown_sessions set locked_at = null, violations = 0
  where event_id = p_event and user_id = p_user;
  perform private.audit(p_event, 'lockdown.unlocked', 'user', p_user, '{}');
end;
$$;

grant execute on function
  public.lockdown_heartbeat(uuid, text, boolean),
  public.lockdown_violation(uuid, text, jsonb),
  public.lockdown_unlock(uuid, uuid)
to authenticated;

alter table public.lockdown_sessions enable row level security;

create policy lockdown_sessions_select on public.lockdown_sessions for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_permission(event_id, 'lockdown.review')));

alter publication supabase_realtime add table public.lockdown_sessions;

-- ──── from 1_plugin_settings.sql, folded in before the first release ────

-- Settings move to `plugin.lockdown`, where Manage → Extensions edits them (plugin API 1).
-- maxViolations 0 means submissions never stop; require_extension mode is gone until the
-- companion extension exists.

insert into public.settings (scope, org_id, event_id, namespace, value)
select s.scope, s.org_id, s.event_id, 'plugin.lockdown', jsonb_strip_nulls(jsonb_build_object(
  'mode', case when s.value ->> 'mode' = 'require_extension' then 'enforce' else s.value ->> 'mode' end,
  'maxViolations', s.value -> 'maxViolations'
))
from public.settings s
where s.namespace = 'lockdown'
on conflict (scope, org_id, event_id, namespace) do update set value = excluded.value || public.settings.value;

delete from public.settings where namespace = 'lockdown';

-- the event's settings with the manifest's defaults under them
create function private.lockdown_settings(p_event uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('mode', 'monitor', 'maxViolations', 3)
    || coalesce(private.event_setting(p_event, 'plugin.lockdown'), '{}');
$$;
grant execute on function private.lockdown_settings(uuid) to authenticated;

create or replace function public.lockdown_violation(p_event uuid, p_kind text, p_meta jsonb default '{}')
returns public.lockdown_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.lockdown_sessions;
  v_settings jsonb := private.lockdown_settings(p_event);
  v_max integer := case when v_settings ->> 'mode' = 'enforce'
    then nullif((v_settings ->> 'maxViolations')::integer, 0) end;
begin
  if p_kind !~ '^[a-z][a-z_]{1,30}$' then
    raise exception 'bad violation kind' using errcode = '22023';
  end if;
  perform public.lockdown_heartbeat(p_event);
  update public.lockdown_sessions set
    violations = violations + 1,
    locked_at = case when v_max is not null and violations + 1 >= v_max then coalesce(locked_at, now()) else locked_at end
  where event_id = p_event and user_id = (select auth.uid())
  returning * into v_row;
  perform private.audit(p_event, 'lockdown.' || p_kind, 'user', (select auth.uid()),
    p_meta || jsonb_build_object('violations', v_row.violations));
  return v_row;
end;
$$;

-- called by challenges_submit when lockdown is on for the event
create or replace function private.lockdown_assert_can_submit(p_event uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.lockdown_settings(p_event) ->> 'mode' <> 'enforce' then
    return;
  end if;
  if exists (
    select 1 from public.lockdown_sessions
    where event_id = p_event and user_id = (select auth.uid()) and locked_at is not null
  ) then
    raise exception 'submissions are stopped after leaving the page too often; talk to an organizer'
      using errcode = 'P0001';
  end if;
end;
$$;

-- ──── from 2_companion.sql, folded in before the first release ────

-- Lockdown 1.0: the companion browser extension and Safe Exam Browser (SEB) as ways to attest.
-- `require` (none | extension | seb) says which one submissions need while lockdown enforces.

alter table public.lockdown_sessions
  add column attested_by text check (attested_by in ('extension', 'seb'));

-- p_attested: the page heard the companion extension answer its nonce
drop function public.lockdown_heartbeat(uuid, text, boolean);
create function public.lockdown_heartbeat(
  p_event uuid, p_extension_version text default null, p_attested boolean default false
)
returns public.lockdown_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.lockdown_sessions;
begin
  if not private.plugin_enabled(p_event, 'lockdown') or not private.has_permission(p_event, 'event.compete') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.lockdown_sessions (event_id, user_id, extension_version, attested_at, attested_by)
  values (p_event, (select auth.uid()), p_extension_version,
    case when p_attested then now() end, case when p_attested then 'extension' end)
  on conflict (event_id, user_id) do update set
    heartbeat_at = now(),
    extension_version = coalesce(excluded.extension_version, public.lockdown_sessions.extension_version),
    attested_at = case when p_attested then now() else public.lockdown_sessions.attested_at end,
    attested_by = case when p_attested then 'extension' else public.lockdown_sessions.attested_by end
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.lockdown_heartbeat(uuid, text, boolean) to authenticated;

-- ── Safe Exam Browser keys ───────────────────────────────────────────────

-- The keys are secrets: with one, anyone can write the headers SEB sends. Only proctors read them,
-- and the check below runs here so a participant never sees them.
create table public.lockdown_seb_keys (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events on delete cascade,
  kind text not null check (kind in ('config', 'browser_exam')),
  value text not null check (value ~ '^[0-9a-fA-F]{64}$'),
  label text not null default '' check (length(label) <= 80),
  created_at timestamptz not null default now(),
  unique (event_id, kind, value)
);
create index lockdown_seb_keys_event_idx on public.lockdown_seb_keys (event_id);

alter table public.lockdown_seb_keys enable row level security;
create policy lockdown_seb_keys_select on public.lockdown_seb_keys for select to authenticated
  using ((select private.has_permission(event_id, 'lockdown.review')));

-- replaces the event's keys: [{ kind, value, label }]
create function public.lockdown_set_seb_keys(p_event uuid, p_keys jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not private.has_permission(p_event, 'lockdown.review') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_keys) is distinct from 'array' or jsonb_array_length(p_keys) > 20 then
    raise exception 'give up to 20 keys' using errcode = '22023';
  end if;
  delete from public.lockdown_seb_keys where event_id = p_event;
  insert into public.lockdown_seb_keys (event_id, kind, value, label)
  select distinct on (k.value ->> 'kind', lower(k.value ->> 'value')) p_event, k.value ->> 'kind',
    lower(k.value ->> 'value'), coalesce(k.value ->> 'label', '')
  from jsonb_array_elements(p_keys) as k(value);
  get diagnostics v_count = row_count;
  perform private.audit(p_event, 'lockdown.seb_keys_saved', 'event', p_event,
    jsonb_build_object('count', v_count));
  return v_count;
end;
$$;

-- SEB hashes the address it requested together with a key and sends the result in a header:
-- X-SafeExamBrowser-RequestHash for the Browser Exam Key, X-SafeExamBrowser-ConfigKeyHash for the
-- Config Key. True, and the session attested by 'seb', when either matches one of the event's keys.
create function public.lockdown_check_seb(
  p_event uuid, p_url text, p_request_hash text, p_config_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  if not private.plugin_enabled(p_event, 'lockdown') or not private.has_permission(p_event, 'event.compete') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select exists (
    select 1 from public.lockdown_seb_keys k
    where k.event_id = p_event
      and (
        (k.kind = 'browser_exam' and lower(coalesce(p_request_hash, '')) =
          encode(extensions.digest(p_url || k.value, 'sha256'), 'hex'))
        or (k.kind = 'config' and lower(coalesce(p_config_hash, '')) =
          encode(extensions.digest(p_url || k.value, 'sha256'), 'hex'))
      )
  ) into v_ok;
  if v_ok then
    insert into public.lockdown_sessions (event_id, user_id, attested_at, attested_by)
    values (p_event, (select auth.uid()), now(), 'seb')
    on conflict (event_id, user_id) do update set
      heartbeat_at = now(), attested_at = now(), attested_by = 'seb';
  end if;
  return v_ok;
end;
$$;

grant execute on function
  public.lockdown_set_seb_keys(uuid, jsonb),
  public.lockdown_check_seb(uuid, text, text, text)
to authenticated;

-- ── requiring one ────────────────────────────────────────────────────────

-- the event's settings with the manifest's defaults under them
create or replace function private.lockdown_settings(p_event uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('mode', 'monitor', 'maxViolations', 3, 'require', 'none')
    || coalesce(private.event_setting(p_event, 'plugin.lockdown'), '{}');
$$;

-- Attestation counts for three minutes: the page beats every minute, the extension every 15 seconds.
create or replace function private.lockdown_assert_can_submit(p_event uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings jsonb := private.lockdown_settings(p_event);
  v_require text := v_settings ->> 'require';
  v_row public.lockdown_sessions;
begin
  if v_settings ->> 'mode' <> 'enforce' then
    return;
  end if;
  select * into v_row from public.lockdown_sessions
  where event_id = p_event and user_id = (select auth.uid());
  if v_row.locked_at is not null then
    raise exception 'submissions are stopped after leaving the page too often; talk to an organizer'
      using errcode = 'P0001';
  end if;
  if v_require in ('extension', 'seb') and (
    v_row.attested_by is distinct from v_require
    or v_row.attested_at is null
    or v_row.attested_at < now() - interval '3 minutes'
  ) then
    raise exception using errcode = 'P0001', message = case v_require
      when 'seb' then 'this contest has to be opened in Safe Exam Browser'
      else 'this contest needs the Bogey lockdown extension'
    end;
  end if;
end;
$$;

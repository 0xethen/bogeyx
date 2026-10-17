-- Lockdown 1.1: the cover holds on the server. While a participant's cover is up, Bogey asks
-- private.lockdown_gate and gives them no permission in the event: other pages send them home and
-- the event's data stays shut, even to someone calling the API by hand. Organizers are never gated.
-- Full screen is what the page reports, so someone calling lockdown_heartbeat by hand can claim it;
-- each claim is in the audit log. Safe Exam Browser is the one check a browser can't make up.

alter table public.lockdown_sessions add column if not exists fullscreen_at timestamptz;

-- what the cover needs, with the manifest's defaults under the event's settings
create or replace function private.lockdown_settings(p_event uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'mode', 'monitor', 'maxViolations', 3, 'require', 'none', 'during', 'always',
    'whenStopped', 'cover', 'requireFullscreen', true
  ) || coalesce(private.event_setting(p_event, 'plugin.lockdown'), '{}');
$$;

-- A gated participant holds no permission, so the RPCs that let them back in ask what their role
-- grants instead. Before Bogey had gates, has_permission was that.
create or replace function private.lockdown_may_compete(p_event uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  if to_regprocedure('private.holds_permission(uuid, text)') is null then
    return private.has_permission(p_event, 'event.compete');
  end if;
  execute 'select private.holds_permission($1, ''event.compete'')' into v_ok using p_event;
  return coalesce(v_ok, false);
end;
$$;
grant execute on function private.lockdown_may_compete(uuid) to authenticated;

-- Why the event is closed to this participant, or null. The same covers the page shows, less the
-- phone one: a browser that lies about being a phone gains nothing.
create or replace function private.lockdown_gate(p_event uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings jsonb := private.lockdown_settings(p_event);
  v_enforce boolean := v_settings ->> 'mode' = 'enforce';
  v_require text := v_settings ->> 'require';
  v_row public.lockdown_sessions;
begin
  if v_settings ->> 'mode' = 'off'
     or (v_settings ->> 'during' = 'window' and not private.window_open(p_event, 'lockdown.armed')) then
    return null;
  end if;
  select * into v_row from public.lockdown_sessions
  where event_id = p_event and user_id = (select auth.uid());
  if v_enforce and v_settings ->> 'whenStopped' = 'cover' and v_row.locked_at is not null then
    return 'stopped';
  end if;
  if v_require in ('extension', 'seb') and (
    v_row.attested_by is distinct from v_require
    or v_row.attested_at is null
    or v_row.attested_at < now() - interval '3 minutes'
  ) then
    return v_require;
  end if;
  -- the page beats every minute; a page that has gone quiet is no longer in full screen
  if (v_settings ->> 'requireFullscreen')::boolean and (
    v_row.fullscreen_at is null or v_row.heartbeat_at < now() - interval '3 minutes'
  ) then
    return 'fullscreen';
  end if;
  return null;
end;
$$;
grant execute on function private.lockdown_gate(uuid) to authenticated;

-- p_attested: the page heard the companion extension answer its nonce
-- p_fullscreen: whether the page is in full screen; null leaves it as it was
drop function if exists public.lockdown_heartbeat(uuid, text, boolean);
create or replace function public.lockdown_heartbeat(
  p_event uuid,
  p_extension_version text default null,
  p_attested boolean default false,
  p_fullscreen boolean default null
)
returns public.lockdown_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before timestamptz;
  v_row public.lockdown_sessions;
begin
  if not private.plugin_enabled(p_event, 'lockdown') or not private.lockdown_may_compete(p_event) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select fullscreen_at into v_before from public.lockdown_sessions
  where event_id = p_event and user_id = (select auth.uid());
  insert into public.lockdown_sessions (event_id, user_id, extension_version, attested_at, attested_by, fullscreen_at)
  values (p_event, (select auth.uid()), p_extension_version,
    case when p_attested then now() end, case when p_attested then 'extension' end,
    case when p_fullscreen then now() end)
  on conflict (event_id, user_id) do update set
    heartbeat_at = now(),
    extension_version = coalesce(excluded.extension_version, public.lockdown_sessions.extension_version),
    attested_at = case when p_attested then now() else public.lockdown_sessions.attested_at end,
    attested_by = case when p_attested then 'extension' else public.lockdown_sessions.attested_by end,
    fullscreen_at = case
      when p_fullscreen is null then public.lockdown_sessions.fullscreen_at
      when p_fullscreen then coalesce(public.lockdown_sessions.fullscreen_at, now())
    end
  returning * into v_row;
  -- the claim that opens the event; written down, since only the page can make it
  if p_fullscreen and v_before is null then
    perform private.audit(p_event, 'lockdown.fullscreen_entered', 'user', (select auth.uid()), '{}');
  end if;
  return v_row;
end;
$$;
grant execute on function public.lockdown_heartbeat(uuid, text, boolean, boolean) to authenticated;

-- leaving full screen closes the event again at once
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
  perform public.lockdown_heartbeat(p_event, p_fullscreen => case when p_kind = 'fullscreen_exit' then false end);
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

create or replace function public.lockdown_check_seb(
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
  if not private.plugin_enabled(p_event, 'lockdown') or not private.lockdown_may_compete(p_event) then
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

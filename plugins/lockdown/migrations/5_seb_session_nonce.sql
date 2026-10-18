-- Safe Exam Browser's check counts for the sign-in that made it, and can't be replayed.
--
-- A passing check used to open the event to the whole account: a second browser signed in as the
-- same person rode on the SEB's check without ever making one. Now the check keeps the session it
-- came from (the JWT's session_id) and the gate opens only that session. Participants sign in
-- again inside SEB, so SEB's session is its own. A token without a session_id opens nothing.
--
-- SEB's header is SHA-256 of the address plus a key, and /seb-check's address never changed, so a
-- header captured once passed forever. Each check now asks for a nonce first (lockdown_seb_nonce),
-- puts it in the address SEB hashes, and the database spends it: a header is good for one check.

alter table public.lockdown_sessions add column if not exists attested_session text;

create table if not exists public.lockdown_seb_nonces (
  nonce text primary key default encode(extensions.gen_random_bytes(16), 'hex'),
  event_id uuid not null references public.events on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  expires_at timestamptz not null default now() + interval '2 minutes'
);
create index if not exists lockdown_seb_nonces_user_idx on public.lockdown_seb_nonces (event_id, user_id);
-- only the functions below read or write it
alter table public.lockdown_seb_nonces enable row level security;

create or replace function private.lockdown_session_id()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif((select auth.jwt()) ->> 'session_id', '');
$$;
grant execute on function private.lockdown_session_id() to authenticated;

-- a fresh nonce for the next check. Each tab asks for its own, so only spent and expired ones go.
create or replace function public.lockdown_seb_nonce(p_event uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nonce text;
begin
  if not private.plugin_enabled(p_event, 'lockdown') or not private.lockdown_may_compete(p_event) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.lockdown_seb_nonces where expires_at < now();
  insert into public.lockdown_seb_nonces (event_id, user_id)
  values (p_event, (select auth.uid()))
  returning nonce into v_nonce;
  return v_nonce;
end;
$$;
grant execute on function public.lockdown_seb_nonce(uuid) to authenticated;

create or replace function public.lockdown_check_seb(
  p_event uuid, p_url text, p_request_hash text, p_config_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session text := private.lockdown_session_id();
  v_nonce text := substring(coalesce(p_url, '') from '[?&]nonce=([0-9a-f]{32})(&|$)');
  v_fresh boolean;
  v_ok boolean;
begin
  if not private.plugin_enabled(p_event, 'lockdown') or not private.lockdown_may_compete(p_event) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- the nonce is spent whether or not the hash matches
  delete from public.lockdown_seb_nonces
  where nonce = v_nonce and event_id = p_event and user_id = (select auth.uid()) and expires_at >= now();
  v_fresh := found;
  select v_fresh and v_session is not null and (exists (
    select 1 from public.lockdown_seb_keys k
    where k.event_id = p_event
      and (
        (k.kind = 'browser_exam' and lower(coalesce(p_request_hash, '')) =
          encode(extensions.digest(p_url || k.value, 'sha256'), 'hex'))
        or (k.kind = 'config' and lower(coalesce(p_config_hash, '')) =
          encode(extensions.digest(p_url || k.value, 'sha256'), 'hex'))
      )
  ) or exists (
    select 1 from public.lockdown_seb_configs c
    where c.event_id = p_event
      and lower(coalesce(p_config_hash, '')) =
        encode(extensions.digest(p_url || c.config_key, 'sha256'), 'hex')
  )) into v_ok;
  if v_ok then
    insert into public.lockdown_sessions (event_id, user_id, attested_at, attested_by, attested_session)
    values (p_event, (select auth.uid()), now(), 'seb', v_session)
    on conflict (event_id, user_id) do update set
      heartbeat_at = now(), attested_at = now(), attested_by = 'seb', attested_session = v_session;
  else
    -- the SEB that passed failing now (its configuration changed under it) closes at once; another
    -- browser failing leaves it be, since that browser was never let in
    update public.lockdown_sessions set attested_at = null
    where event_id = p_event and user_id = (select auth.uid()) and attested_by = 'seb'
      and attested_session is not distinct from v_session;
  end if;
  return v_ok;
end;
$$;

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
     or private.lockdown_problems_closed(p_event)
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
    -- SEB opens only the sign-in it was checked in
    or (v_require = 'seb' and (
      private.lockdown_session_id() is null
      or v_row.attested_session is distinct from private.lockdown_session_id()
    ))
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
    or (v_require = 'seb' and (
      private.lockdown_session_id() is null
      or v_row.attested_session is distinct from private.lockdown_session_id()
    ))
  ) then
    raise exception using errcode = 'P0001', message = case v_require
      when 'seb' then 'this contest has to be opened in Safe Exam Browser'
      else 'this contest needs the Bogey lockdown extension'
    end;
  end if;
end;
$$;

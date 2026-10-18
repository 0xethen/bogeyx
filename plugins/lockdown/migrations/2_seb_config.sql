-- Lockdown 1.2: Bogey writes the Safe Exam Browser configuration. Organizers build it on Manage →
-- Lockdown Browser, where the page turns it into a .seb file and works out the file's Config Key. SEB
-- downloads the file from a link with the event's token in it, since it has no session to sign in with.
-- The file is readable by whoever has the link, and its Config Key can be worked out from it: the key
-- keeps casual attempts out, as the README says.

create table public.lockdown_seb_configs (
  event_id uuid primary key references public.events on delete cascade,
  -- what the editor shows
  config jsonb not null default '{}',
  -- the .seb file, as served
  plist text not null check (length(plist) <= 200000),
  config_key text not null check (config_key ~ '^[0-9a-f]{64}$'),
  token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  updated_at timestamptz not null default now()
);

alter table public.lockdown_seb_configs enable row level security;
create policy lockdown_seb_configs_select on public.lockdown_seb_configs for select to authenticated
  using ((select private.has_permission(event_id, 'event.manage')));

create function public.lockdown_save_seb_config(
  p_event uuid, p_config jsonb, p_plist text, p_config_key text
)
returns public.lockdown_seb_configs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.lockdown_seb_configs;
begin
  if not private.has_permission(p_event, 'event.manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.lockdown_seb_configs (event_id, config, plist, config_key)
  values (p_event, coalesce(p_config, '{}'), p_plist, lower(p_config_key))
  on conflict (event_id) do update set
    config = excluded.config,
    plist = excluded.plist,
    config_key = excluded.config_key,
    updated_at = now()
  returning * into v_row;
  perform private.audit(p_event, 'lockdown.seb_config_saved', 'event', p_event, '{}');
  return v_row;
end;
$$;

-- The token in the link that opens SEB, for the event's participants (a covered one too, since the
-- link is how they get past the cover) and its organizers. Null while SEB isn't required.
create function public.lockdown_seb_link(p_event uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.plugin_enabled(p_event, 'lockdown')
     or not (private.lockdown_may_compete(p_event) or private.has_permission(p_event, 'event.manage')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if private.lockdown_settings(p_event) ->> 'require' is distinct from 'seb' then
    return null;
  end if;
  return (select token from public.lockdown_seb_configs where event_id = p_event);
end;
$$;

-- The .seb file for a link's token. SEB asks without signing in, so anyone with the link may read it.
create function public.lockdown_seb_file(p_token text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.plist from public.lockdown_seb_configs c
  where c.token = p_token
    and private.plugin_enabled(c.event_id, 'lockdown')
    and private.lockdown_settings(c.event_id) ->> 'require' = 'seb'
    and private.lockdown_settings(c.event_id) ->> 'mode' <> 'off';
$$;

-- The generated file's Config Key passes the check as the keys organizers add by hand do.
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
  ) or exists (
    select 1 from public.lockdown_seb_configs c
    where c.event_id = p_event
      and lower(coalesce(p_config_hash, '')) =
        encode(extensions.digest(p_url || c.config_key, 'sha256'), 'hex')
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
  public.lockdown_save_seb_config(uuid, jsonb, text, text),
  public.lockdown_seb_link(uuid)
to authenticated;
grant execute on function public.lockdown_seb_file(text) to anon, authenticated;

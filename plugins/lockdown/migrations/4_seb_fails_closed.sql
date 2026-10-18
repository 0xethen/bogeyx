-- Safe Exam Browser holds even when it's set up wrong.
--
-- A check that fails now takes back what an earlier one granted. Before, a passing check counted for
-- three minutes whatever came after, so opening the event in another browser right after SEB (or
-- in an SEB whose configuration doesn't match) still had the event open on the server for up to
-- three minutes. An SEB without a matching key, without the key header switched on, or behind a
-- proxy that drops the headers fails the check, and so closes the event, at once.

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
  select coalesce(p_url, '') <> '' and (exists (
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
    insert into public.lockdown_sessions (event_id, user_id, attested_at, attested_by)
    values (p_event, (select auth.uid()), now(), 'seb')
    on conflict (event_id, user_id) do update set
      heartbeat_at = now(), attested_at = now(), attested_by = 'seb';
  else
    -- any browser of theirs that fails closes the event: it is one account, and one of its
    -- browsers isn't Safe Exam Browser
    update public.lockdown_sessions set attested_at = null
    where event_id = p_event and user_id = (select auth.uid()) and attested_by = 'seb';
  end if;
  return v_ok;
end;
$$;

-- For the page's cover, and for organizers: whether Safe Exam Browser can pass at all. With no
-- generated file and no keys, no browser matches, so nobody gets in until an organizer sets it up.
create or replace function public.lockdown_seb_ready(p_event uuid)
returns boolean
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
  return exists (select 1 from public.lockdown_seb_configs where event_id = p_event)
    or exists (select 1 from public.lockdown_seb_keys where event_id = p_event);
end;
$$;
grant execute on function public.lockdown_seb_ready(uuid) to authenticated;

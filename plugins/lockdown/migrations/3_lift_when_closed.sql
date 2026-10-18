-- Lockdown lifts once problems can't be submitted: the page stops covering the event then, so the
-- server stops gating it too. Before, a participant whose submissions had closed saw the event's home
-- with no tabs and no cover, since the page had lifted lockdown and the server hadn't.

-- Whether the window problems are submitted in has closed, and not just not opened yet: the
-- challenges contest when the event has one, the core submissions window otherwise.
create or replace function private.lockdown_problems_closed(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when w.override is not null then w.override = 'closed'
      else w.closes_at is not null and now() >= w.closes_at
    end
    from public.event_windows w
    where w.event_id = p_event and w.key in ('challenges.contest', 'submissions')
    order by w.key = 'challenges.contest' desc
    limit 1
  ), false);
$$;
grant execute on function private.lockdown_problems_closed(uuid) to authenticated;

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

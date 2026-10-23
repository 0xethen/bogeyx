-- Lockdown applies only while its window is open unless an event picks "always"
create or replace function private.lockdown_settings(p_event uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'mode', 'monitor', 'maxViolations', 3, 'require', 'none', 'during', 'window',
    'whenStopped', 'cover', 'requireFullscreen', true
  ) || coalesce(private.event_setting(p_event, 'plugin.lockdown'), '{}');
$$;

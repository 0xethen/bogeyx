-- Linked sounds: a library entry can be a web address instead of an upload. It plays from there,
-- so it takes no room in the bucket and doesn't count toward the event's limit (a link has no
-- size, which sum() skips). sounds_remove_file returns null for one: nothing to delete there.

alter table public.sounds_files
  add column if not exists link text check (link ~ '^https://' and char_length(link) <= 2000);
alter table public.sounds_files alter column storage_path drop not null;
alter table public.sounds_files alter column mime_type drop not null;
alter table public.sounds_files alter column size_bytes drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sounds_files_upload_or_link') then
    alter table public.sounds_files add constraint sounds_files_upload_or_link
      check ((storage_path is null) <> (link is null));
  end if;
end;
$$;

-- adds a sound that plays from a web address; the browser that adds it measured how long it is
create or replace function public.sounds_link_file(p_event uuid, p_name text, p_link text, p_duration_ms integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.sounds_check_manage(p_event);
  insert into public.sounds_files (event_id, name, link, duration_ms)
  values (p_event, btrim(p_name), btrim(p_link), p_duration_ms)
  returning id into v_id;
  perform private.audit(p_event, 'sounds.linked', 'sounds_file', v_id,
    jsonb_build_object('name', left(btrim(p_name), 120), 'link', btrim(p_link)));
  return v_id;
end;
$$;
revoke execute on function public.sounds_link_file(uuid, text, text, integer) from public, anon;
grant execute on function public.sounds_link_file(uuid, text, text, integer) to authenticated;

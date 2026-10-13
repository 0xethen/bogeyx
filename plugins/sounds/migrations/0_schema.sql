-- Sounds: an event's uploaded sounds, the effect that plays for each signal (something that just
-- happened in someone's browser, like a message arriving), and cues that play at a time worked out
-- from the event's schedule ("end this song when the event ends").
--
--   sounds/<event_id>/<file>     the uploads; public read like event-assets, organizers write
--
-- Effects store only what an organizer changed: a signal with no row plays the extension's default.
-- Organizers edit the library's details, the effects and the cues together with sounds_save_setup,
-- so one save is one transaction and one audit entry.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sounds', 'sounds', true, 25 * 1024 * 1024,
  array[
    'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/opus',
    'audio/webm', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/x-flac'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- served by URL from the public bucket, so there's no read policy; organizers of an event with
-- the extension on write under its folder
create policy sounds_write on storage.objects for all to authenticated
  using (
    bucket_id = 'sounds'
    and (select private.can_manage(private.path_uuid(name, 1)))
    and (select private.plugin_enabled(private.path_uuid(name, 1), 'sounds'))
  )
  with check (
    bucket_id = 'sounds'
    and (select private.can_manage(private.path_uuid(name, 1)))
    and (select private.plugin_enabled(private.path_uuid(name, 1), 'sounds'))
  );

create table public.sounds_files (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  storage_path text not null unique,
  mime_type text not null check (mime_type like 'audio/%'),
  size_bytes integer not null check (size_bytes > 0),
  duration_ms integer not null check (duration_ms > 0),
  -- fetched as soon as someone opens the event, instead of shortly before it plays
  preload boolean not null default false,
  -- its place in the background playlist, or null when it isn't in it
  playlist_position integer check (playlist_position >= 0),
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, event_id),
  check (storage_path like event_id::text || '/%')
);
create index sounds_files_event_id_idx on public.sounds_files (event_id);
alter table public.sounds_files enable row level security;

create policy sounds_files_read on public.sounds_files for select to authenticated
  using (
    (select private.can_view_event(event_id))
    and (select private.plugin_enabled(event_id, 'sounds'))
  );

-- the sounds the extension synthesizes itself, so it works with nothing uploaded
create function private.sounds_builtin(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_name in ('chime', 'alert', 'pop', 'rise', 'fall', 'tick', 'success', 'error', 'fanfare', 'none');
$$;

create table public.sounds_effects (
  event_id uuid not null references public.events on delete cascade,
  -- `<area>.<name>` from core or `<plugin>.<name>`; unknown ones are kept, in case a plugin comes back
  signal text not null check (signal ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$' and char_length(signal) <= 100),
  file_id uuid,
  builtin text check (private.sounds_builtin(builtin)),
  volume smallint not null default 100 check (volume between 0 and 100),
  primary key (event_id, signal),
  -- removing an upload puts its signals back to their defaults
  foreign key (file_id, event_id) references public.sounds_files (id, event_id) on delete cascade,
  check ((file_id is null) <> (builtin is null))
);
create index sounds_effects_file_id_idx on public.sounds_effects (file_id);
alter table public.sounds_effects enable row level security;

create policy sounds_effects_read on public.sounds_effects for select to authenticated
  using (
    (select private.can_view_event(event_id))
    and (select private.plugin_enabled(event_id, 'sounds'))
  );

create table public.sounds_cues (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  file_id uuid,
  builtin text check (private.sounds_builtin(builtin) and builtin <> 'none'),
  -- what the time is worked out from
  anchor text not null check (anchor in ('event.start', 'event.end', 'window.open', 'window.close', 'time')),
  window_key text check (char_length(window_key) <= 100),
  at timestamptz,
  -- moves the time later (or earlier, when negative), up to a week either way
  offset_seconds integer not null default 0 check (abs(offset_seconds) <= 7 * 24 * 3600),
  -- 'start': the sound starts at that time; 'end': it ends then, so it starts its length earlier
  align text not null default 'start' check (align in ('start', 'end')),
  -- 'music' pauses background music and follows the music volume; 'effect' plays over it
  channel text not null default 'music' check (channel in ('music', 'effect')),
  -- people who open the event partway through hear the rest, in step with everyone else
  join_late boolean not null default true,
  volume smallint not null default 100 check (volume between 0 and 100),
  sort integer not null default 0,
  foreign key (file_id, event_id) references public.sounds_files (id, event_id) on delete cascade,
  check ((file_id is null) <> (builtin is null)),
  check ((anchor in ('window.open', 'window.close')) = (window_key is not null)),
  check ((anchor = 'time') = (at is not null))
);
create index sounds_cues_event_id_idx on public.sounds_cues (event_id);
create index sounds_cues_file_id_idx on public.sounds_cues (file_id);
alter table public.sounds_cues enable row level security;

create policy sounds_cues_read on public.sounds_cues for select to authenticated
  using (
    (select private.can_view_event(event_id))
    and (select private.plugin_enabled(event_id, 'sounds'))
  );

-- refuses callers who can't manage the event, or whose event has the extension off
create function private.sounds_check_manage(p_event uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_manage(p_event) then
    raise exception 'only organizers can change sounds' using errcode = '42501';
  end if;
  if not private.plugin_enabled(p_event, 'sounds') then
    raise exception 'Sounds is off for this event' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function private.sounds_check_manage(uuid) from public, anon, authenticated;

-- records an upload already in the bucket, under the event's limit on uploaded sound
create function public.sounds_add_file(
  p_event uuid, p_name text, p_path text, p_mime text, p_size integer, p_duration_ms integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit numeric;
  v_used bigint;
  v_id uuid;
begin
  perform private.sounds_check_manage(p_event);
  if not exists (
    select 1 from storage.objects o where o.bucket_id = 'sounds' and o.name = p_path
  ) then
    raise exception 'upload the file first' using errcode = '22023';
  end if;
  v_limit := private.org_limit(private.event_org(p_event), 'sounds.maxLibraryMb');
  -- platform admins are exempt, as from core's limits
  if v_limit is not null and not private.is_platform_admin() then
    select coalesce(sum(size_bytes), 0) into v_used from public.sounds_files where event_id = p_event;
    if v_used + p_size > v_limit * 1024 * 1024 then
      raise exception 'this event can hold at most % MB of sounds', v_limit using errcode = '23514';
    end if;
  end if;
  insert into public.sounds_files (event_id, name, storage_path, mime_type, size_bytes, duration_ms)
  values (p_event, btrim(p_name), p_path, p_mime, p_size, p_duration_ms)
  returning id into v_id;
  perform private.audit(p_event, 'sounds.uploaded', 'sounds_file', v_id,
    jsonb_build_object('name', left(btrim(p_name), 120)));
  return v_id;
end;
$$;
revoke execute on function public.sounds_add_file(uuid, text, text, text, integer, integer) from public, anon;
grant execute on function public.sounds_add_file(uuid, text, text, text, integer, integer) to authenticated;

-- forgets an upload, and the effects and cues that used it; returns its path so the caller can
-- remove the file from the bucket
create function public.sounds_remove_file(p_file uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file public.sounds_files;
begin
  select * into v_file from public.sounds_files where id = p_file;
  if not found then
    raise exception 'no such sound' using errcode = 'P0002';
  end if;
  perform private.sounds_check_manage(v_file.event_id);
  delete from public.sounds_files where id = p_file;
  perform private.audit(v_file.event_id, 'sounds.removed', 'sounds_file', p_file,
    jsonb_build_object('name', v_file.name));
  return v_file.storage_path;
end;
$$;
revoke execute on function public.sounds_remove_file(uuid) from public, anon;
grant execute on function public.sounds_remove_file(uuid) to authenticated;

-- saves the library's details, every effect and every cue at once; effects and cues are replaced
create function public.sounds_save_setup(p_event uuid, p_files jsonb, p_effects jsonb, p_cues jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.sounds_check_manage(p_event);
  if jsonb_typeof(p_files) <> 'array' or jsonb_typeof(p_effects) <> 'array' or jsonb_typeof(p_cues) <> 'array' then
    raise exception 'files, effects and cues must be lists' using errcode = '22023';
  end if;
  if jsonb_array_length(p_effects) > 200 or jsonb_array_length(p_cues) > 200 then
    raise exception 'at most 200 effects and 200 cues' using errcode = '22023';
  end if;

  update public.sounds_files f set
    name = btrim(x.name),
    preload = x.preload,
    playlist_position = x.playlist_position
  from jsonb_to_recordset(p_files) as x(id uuid, name text, preload boolean, playlist_position integer)
  where f.id = x.id and f.event_id = p_event;

  delete from public.sounds_effects where event_id = p_event;
  insert into public.sounds_effects (event_id, signal, file_id, builtin, volume)
  select p_event, x.signal, x.file_id, x.builtin, coalesce(x.volume, 100)
  from jsonb_to_recordset(p_effects) as x(signal text, file_id uuid, builtin text, volume smallint);

  delete from public.sounds_cues where event_id = p_event;
  -- ids are kept, so a cue that's playing carries on through a save
  insert into public.sounds_cues (
    id, event_id, label, file_id, builtin, anchor, window_key, at, offset_seconds, align, channel,
    join_late, volume, sort
  )
  select coalesce((c ->> 'id')::uuid, gen_random_uuid()), p_event, btrim(c ->> 'label'), (c ->> 'file_id')::uuid, c ->> 'builtin', c ->> 'anchor',
    c ->> 'window_key', (c ->> 'at')::timestamptz, coalesce((c ->> 'offset_seconds')::integer, 0),
    coalesce(c ->> 'align', 'start'), coalesce(c ->> 'channel', 'music'),
    coalesce((c ->> 'join_late')::boolean, true), coalesce((c ->> 'volume')::smallint, 100),
    ord::integer
  from jsonb_array_elements(p_cues) with ordinality as cues(c, ord);

  perform private.audit(p_event, 'sounds.setup_saved', 'event', p_event,
    jsonb_build_object('effects', jsonb_array_length(p_effects), 'cues', jsonb_array_length(p_cues)));
end;
$$;
revoke execute on function public.sounds_save_setup(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.sounds_save_setup(uuid, jsonb, jsonb, jsonb) to authenticated;

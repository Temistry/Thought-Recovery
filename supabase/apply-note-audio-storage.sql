-- Apply note-audio Storage bucket and user-scoped policies

insert into storage.buckets (id, name, public)
values ('note-audio', 'note-audio', false)
on conflict (id) do nothing;

drop policy if exists "note_audio_select_own" on storage.objects;
drop policy if exists "note_audio_insert_own" on storage.objects;
drop policy if exists "note_audio_update_own" on storage.objects;
drop policy if exists "note_audio_delete_own" on storage.objects;

create policy "note_audio_select_own" on storage.objects
for select using (
  bucket_id = 'note-audio'
  and auth.uid()::text = (storage.foldername(name))[1]
);

create policy "note_audio_insert_own" on storage.objects
for insert with check (
  bucket_id = 'note-audio'
  and auth.uid()::text = (storage.foldername(name))[1]
);

create policy "note_audio_update_own" on storage.objects
for update using (
  bucket_id = 'note-audio'
  and auth.uid()::text = (storage.foldername(name))[1]
) with check (
  bucket_id = 'note-audio'
  and auth.uid()::text = (storage.foldername(name))[1]
);

create policy "note_audio_delete_own" on storage.objects
for delete using (
  bucket_id = 'note-audio'
  and auth.uid()::text = (storage.foldername(name))[1]
);

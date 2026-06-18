alter table public.notes
add column if not exists deleted_at timestamptz;

create index if not exists notes_user_deleted_created_idx
on public.notes(user_id, deleted_at, created_at desc);

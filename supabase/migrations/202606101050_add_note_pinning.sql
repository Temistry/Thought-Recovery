-- Allow users to protect main thought cards from automatic append routing.

alter table public.notes
add column if not exists is_pinned boolean not null default false;

create index if not exists notes_user_pinned_idx on public.notes(user_id, is_pinned, updated_at desc);

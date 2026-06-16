-- Add lightweight thought-thread routing to notes.
-- parent_note_id is null for main feed thoughts, and points to a main thought for folded source logs.

alter table public.notes
add column if not exists parent_note_id uuid references public.notes(id) on delete cascade;

alter table public.notes
add column if not exists ai_thread_reason text;

alter table public.notes
add column if not exists ai_thread_confidence numeric(4,3);

create index if not exists notes_user_parent_created_idx on public.notes(user_id, parent_note_id, created_at desc);

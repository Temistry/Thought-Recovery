-- Idea Second Brain MVP schema
-- Supabase SQL editor에서 실행한다.

create extension if not exists pgcrypto;

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_text text not null,
  ai_title text,
  ai_summary text,
  ai_tags text[] not null default '{}',
  intent text,
  problem text,
  situation text,
  "reusePurpose" text,
  "decisionAxis" text,
  emotion text,
  "lifeArea" text,
  "memoryType" text,
  "lifeDomain" text,
  topic text,
  "outputPurpose" text,
  "userRole" text,
  "evidenceType" text,
  "paragraphIntents" jsonb not null default '[]'::jsonb,
  source_type text not null default 'text' check (source_type in ('text', 'voice')),
  audio_url text,
  parent_note_id uuid references public.notes(id) on delete cascade,
  ai_thread_reason text,
  ai_thread_confidence numeric(4,3),
  routing_status text not null default 'routed' check (routing_status in ('pending_review', 'routing', 'routed', 'route_failed')),
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.note_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_note_id uuid not null references public.notes(id) on delete cascade,
  to_note_id uuid not null references public.notes(id) on delete cascade,
  reason text,
  confidence numeric(4,3) not null default 0,
  created_at timestamptz not null default now(),
  constraint note_links_no_self_link check (from_note_id <> to_note_id)
);

create table if not exists public.note_versions (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  version_type text not null default 'ai_draft',
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists notes_set_updated_at on public.notes;
create trigger notes_set_updated_at
before update on public.notes
for each row execute function public.set_updated_at();

alter table public.notes enable row level security;
alter table public.note_links enable row level security;
alter table public.note_versions enable row level security;

create policy "notes_select_own" on public.notes for select using (auth.uid() = user_id);
create policy "notes_insert_own" on public.notes for insert with check (auth.uid() = user_id);
create policy "notes_update_own" on public.notes for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "notes_delete_own" on public.notes for delete using (auth.uid() = user_id);

create policy "note_links_select_own" on public.note_links for select using (auth.uid() = user_id);
create policy "note_links_insert_own" on public.note_links for insert with check (auth.uid() = user_id);
create policy "note_links_update_own" on public.note_links for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "note_links_delete_own" on public.note_links for delete using (auth.uid() = user_id);

create policy "note_versions_select_own" on public.note_versions for select using (auth.uid() = user_id);
create policy "note_versions_insert_own" on public.note_versions for insert with check (auth.uid() = user_id);
create policy "note_versions_delete_own" on public.note_versions for delete using (auth.uid() = user_id);

create index if not exists notes_user_created_idx on public.notes(user_id, created_at desc);
create index if not exists notes_user_deleted_created_idx on public.notes(user_id, deleted_at, created_at desc);
create index if not exists notes_user_parent_created_idx on public.notes(user_id, parent_note_id, created_at desc);
create index if not exists notes_user_routing_status_idx on public.notes(user_id, routing_status, created_at desc);
create index if not exists notes_user_pinned_idx on public.notes(user_id, is_pinned, updated_at desc);
create index if not exists notes_user_life_domain_idx on public.notes(user_id, "lifeDomain", created_at desc);
create index if not exists notes_user_output_purpose_idx on public.notes(user_id, "outputPurpose", created_at desc);
create index if not exists notes_raw_text_search_idx on public.notes using gin(to_tsvector('simple', raw_text));
create index if not exists notes_paragraph_intents_gin_idx on public.notes using gin("paragraphIntents");
create index if not exists note_links_user_from_idx on public.note_links(user_id, from_note_id);
create index if not exists note_links_user_to_idx on public.note_links(user_id, to_note_id);

-- Private audio bucket for voice notes.
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
);\n\n-- Subscription readiness: usage metering and plan limits.
-- This migration only adds conservative infrastructure; app enforcement is implemented separately.

create table if not exists public.plan_limits (
  plan_code text primary key,
  display_name text not null,
  monthly_voice_minutes integer not null default 60,
  monthly_transcription_count integer not null default 120,
  monthly_report_count integer not null default 30,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_code text not null references public.plan_limits(plan_code) default 'beta',
  status text not null default 'active' check (status in ('active', 'past_due', 'cancelled', 'trialing')),
  current_period_start timestamptz not null default date_trunc('month', now()),
  current_period_end timestamptz not null default (date_trunc('month', now()) + interval '1 month'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('voice_transcription', 'note_organization', 'note_routing', 'merged_thought_draft')),
  units numeric(10,2) not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.plan_limits enable row level security;
alter table public.user_plans enable row level security;
alter table public.usage_events enable row level security;

drop policy if exists "plan_limits_read_all" on public.plan_limits;
drop policy if exists "user_plans_select_own" on public.user_plans;
drop policy if exists "usage_events_select_own" on public.usage_events;
drop policy if exists "usage_events_insert_own" on public.usage_events;

create policy "plan_limits_read_all" on public.plan_limits
for select using (true);

create policy "user_plans_select_own" on public.user_plans
for select using (auth.uid() = user_id);

create policy "usage_events_select_own" on public.usage_events
for select using (auth.uid() = user_id);

create policy "usage_events_insert_own" on public.usage_events
for insert with check (auth.uid() = user_id);

insert into public.plan_limits (plan_code, display_name, monthly_voice_minutes, monthly_transcription_count, monthly_report_count)
values
  ('beta', 'Closed Beta', 120, 240, 60),
  ('pro', 'Pro', 600, 1200, 300)
on conflict (plan_code) do update set
  display_name = excluded.display_name,
  monthly_voice_minutes = excluded.monthly_voice_minutes,
  monthly_transcription_count = excluded.monthly_transcription_count,
  monthly_report_count = excluded.monthly_report_count,
  updated_at = now();

create index if not exists usage_events_user_type_created_idx
on public.usage_events(user_id, event_type, created_at desc);

drop trigger if exists user_plans_set_updated_at on public.user_plans;
create trigger user_plans_set_updated_at
before update on public.user_plans
for each row execute function public.set_updated_at();

drop trigger if exists plan_limits_set_updated_at on public.plan_limits;
create trigger plan_limits_set_updated_at
before update on public.plan_limits
for each row execute function public.set_updated_at();

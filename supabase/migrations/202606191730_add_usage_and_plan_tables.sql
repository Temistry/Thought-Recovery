-- Subscription readiness: usage metering and plan limits.
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

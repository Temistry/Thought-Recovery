alter table public.notes
  add column if not exists intent text,
  add column if not exists problem text,
  add column if not exists situation text,
  add column if not exists "reusePurpose" text,
  add column if not exists "decisionAxis" text,
  add column if not exists emotion text,
  add column if not exists "lifeArea" text,
  add column if not exists "memoryType" text,
  add column if not exists "lifeDomain" text,
  add column if not exists topic text,
  add column if not exists "outputPurpose" text,
  add column if not exists "userRole" text,
  add column if not exists "evidenceType" text,
  add column if not exists "paragraphIntents" jsonb not null default '[]'::jsonb;

create index if not exists notes_user_life_domain_idx on public.notes(user_id, "lifeDomain", created_at desc);
create index if not exists notes_user_output_purpose_idx on public.notes(user_id, "outputPurpose", created_at desc);
create index if not exists notes_paragraph_intents_gin_idx on public.notes using gin("paragraphIntents");

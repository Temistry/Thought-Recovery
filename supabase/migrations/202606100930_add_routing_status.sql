-- Track whether a note is waiting for user review before AI thread routing.

alter table public.notes
add column if not exists routing_status text not null default 'routed'
check (routing_status in ('pending_review', 'routing', 'routed', 'route_failed'));

create index if not exists notes_user_routing_status_idx on public.notes(user_id, routing_status, created_at desc);

alter table public.hearings
add column if not exists outcome_required boolean not null default true;

create table if not exists public.hearing_outcomes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  hearing_id uuid not null references public.hearings(id) on delete cascade,
  matter_id uuid not null references public.matters(id) on delete cascade,
  updated_by uuid null references public.users(id) on delete set null,
  appearance_status text not null check (
    appearance_status in ('appeared', 'not_appeared', 'proxy_appeared', 'unknown')
  ),
  outcome_type text not null check (
    outcome_type in (
      'adjourned',
      'order_reserved',
      'disposed',
      'awaiting_cause_list',
      'no_proceedings',
      'next_date_pending',
      'other'
    )
  ),
  outcome_summary text null,
  next_date_status text not null default 'not_required' check (
    next_date_status in (
      'entered',
      'pending',
      'not_given',
      'awaiting_cause_list',
      'not_required'
    )
  ),
  next_hearing_id uuid null references public.hearings(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hearing_id)
);

create index if not exists idx_hearing_outcomes_org_next_date_status
on public.hearing_outcomes(organization_id, next_date_status);

create index if not exists idx_hearing_outcomes_matter
on public.hearing_outcomes(matter_id);

alter table public.hearing_outcomes enable row level security;

create table if not exists public.whatsapp_conversation_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  phone text not null,
  flow text not null check (flow in ('check_slot', 'save_date')),
  step text not null check (step in ('date', 'time', 'matter', 'court', 'senior', 'confirm_save')),
  payload_json jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default now() + interval '30 minutes',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, phone)
);

create index if not exists idx_whatsapp_conversation_states_expires_at
on public.whatsapp_conversation_states(expires_at);

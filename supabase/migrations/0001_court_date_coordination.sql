create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid null,
  full_name text not null,
  email text null,
  phone text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'chamber' check (type in ('chamber', 'firm', 'platform')),
  timezone text not null default 'Asia/Karachi',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('owner', 'senior_lawyer', 'junior_lawyer', 'clerk', 'reviewer', 'admin', 'viewer')),
  status text not null default 'active' check (status in ('active', 'invited', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists public.courts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations(id) on delete cascade,
  name text not null,
  court_type text null,
  city text null,
  address text null,
  latitude numeric null,
  longitude numeric null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.matters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source text not null default 'manual' check (source in ('manual', 'duhai_escalation', 'imported')),
  source_reference_id uuid null,
  title text not null,
  matter_type text null,
  status text not null default 'open' check (status in ('open', 'pending', 'closed', 'on_hold')),
  client_name text null,
  client_phone text null,
  opposite_party_name text null,
  court_id uuid null references public.courts(id) on delete set null,
  case_number text null,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  created_by uuid null references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create table if not exists public.hearings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  matter_id uuid not null references public.matters(id) on delete cascade,
  court_id uuid null references public.courts(id) on delete set null,
  hearing_date date not null,
  start_time time null,
  end_time time null,
  purpose text null,
  status text not null default 'scheduled' check (status in ('scheduled', 'attended', 'adjourned', 'missed', 'cancelled', 'completed', 'pending_update')),
  senior_lawyer_id uuid null references public.users(id) on delete set null,
  appearing_lawyer_id uuid null references public.users(id) on delete set null,
  clerk_id uuid null references public.users(id) on delete set null,
  previous_order_summary text null,
  outcome_summary text null,
  next_action text null,
  next_hearing_id uuid null references public.hearings(id) on delete set null,
  file_status text not null default 'unknown' check (file_status in ('not_ready', 'ready', 'carried', 'submitted', 'returned', 'unknown')),
  is_important boolean not null default false,
  created_by uuid null references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create table if not exists public.date_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  matter_id uuid not null references public.matters(id) on delete cascade,
  hearing_id uuid null references public.hearings(id) on delete set null,
  requested_by uuid null references public.users(id) on delete set null,
  requested_for uuid null references public.users(id) on delete set null,
  proposed_date date not null,
  proposed_start_time time null,
  proposed_end_time time null,
  court_id uuid null references public.courts(id) on delete set null,
  reason text null,
  urgency text not null default 'normal' check (urgency in ('normal', 'urgent')),
  status text not null default 'requested' check (status in ('draft', 'requested', 'approved', 'rejected', 'suggested_alternative', 'confirmed_in_court', 'expired', 'cancelled')),
  reviewer_id uuid null references public.users(id) on delete set null,
  reviewer_note text null,
  alternative_date date null,
  alternative_start_time time null,
  confirmed_hearing_id uuid null references public.hearings(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_availability_blocks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  date date not null,
  start_time time null,
  end_time time null,
  reason text null,
  block_type text not null default 'unavailable' check (block_type in ('leave', 'court_busy', 'personal', 'unavailable', 'other')),
  created_by uuid null references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  reminder_type text not null,
  title text not null,
  message text null,
  remind_at timestamptz not null,
  assigned_to uuid null references public.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'queued', 'sent', 'dismissed', 'failed', 'completed')),
  preferred_channel text not null default 'in_app' check (preferred_channel in ('in_app', 'whatsapp', 'email', 'sms', 'push')),
  created_by uuid null references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'email', 'in_app')),
  template_key text not null,
  provider_template_name text null,
  language text not null default 'en',
  category text null,
  body text not null,
  variables_json jsonb null,
  is_active boolean not null default true,
  approved_by_provider boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, channel, template_key, language)
);

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  reminder_id uuid null references public.reminders(id) on delete set null,
  entity_type text not null,
  entity_id uuid not null,
  channel text not null check (channel in ('whatsapp', 'email', 'in_app', 'sms', 'push')),
  recipient_user_id uuid null references public.users(id) on delete set null,
  recipient_phone text null,
  recipient_email text null,
  template_id uuid null references public.notification_templates(id) on delete set null,
  message_preview text null,
  provider text null,
  provider_message_id text null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled', 'manual_sent')),
  failure_reason text null,
  sent_at timestamptz null,
  delivered_at timestamptz null,
  read_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.whatsapp_opt_ins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  phone text not null,
  opt_in_status text not null default 'pending' check (opt_in_status in ('opted_in', 'opted_out', 'pending')),
  opted_in_at timestamptz null,
  opted_out_at timestamptz null,
  source text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, phone)
);

create table if not exists public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  phone text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone)
);

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations(id) on delete cascade,
  actor_user_id uuid null references public.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  metadata_json jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists idx_org_members_user on public.organization_members(user_id, organization_id);
create index if not exists idx_matters_org on public.matters(organization_id, status) where deleted_at is null;
create index if not exists idx_hearings_org_date on public.hearings(organization_id, hearing_date) where deleted_at is null;
create index if not exists idx_hearings_senior_date on public.hearings(senior_lawyer_id, hearing_date) where deleted_at is null;
create index if not exists idx_hearings_appearing_date on public.hearings(appearing_lawyer_id, hearing_date) where deleted_at is null;
create index if not exists idx_date_requests_org_status on public.date_requests(organization_id, status);
create index if not exists idx_availability_user_date on public.user_availability_blocks(user_id, date);
create index if not exists idx_whatsapp_contacts_phone on public.whatsapp_contacts(phone) where is_active = true;
create index if not exists idx_notification_events_status on public.notification_events(status, channel);

alter table public.users enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.courts enable row level security;
alter table public.matters enable row level security;
alter table public.hearings enable row level security;
alter table public.date_requests enable row level security;
alter table public.user_availability_blocks enable row level security;
alter table public.reminders enable row level security;
alter table public.notification_templates enable row level security;
alter table public.notification_events enable row level security;
alter table public.whatsapp_opt_ins enable row level security;
alter table public.whatsapp_contacts enable row level security;
alter table public.activity_log enable row level security;

-- MVP server routes use the Supabase service-role key. Add user-facing RLS
-- policies when authenticated dashboard screens are wired.

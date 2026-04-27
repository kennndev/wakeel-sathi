# Court Date Coordination + WhatsApp Agent — Vertical Slice Code

This is the first working slice for the flow:

```txt
Junior in court sends WhatsApp check request
        ↓
System checks senior lawyer availability
        ↓
WhatsApp replies YES/NO + reason
        ↓
Junior confirms actual date from court by WhatsApp
        ↓
System saves hearing into chamber diary
        ↓
No clash is created silently
```

Assumptions:

- Next.js 15 App Router
- TypeScript strict mode
- Supabase Postgres
- WhatsApp Cloud API or compatible provider
- One monorepo with apps/packages later, but this code can start inside `/apps/chamber-web` or single Next app first

---

# 1. File Tree

```txt
/supabase/migrations/0001_court_date_coordination.sql

/apps/chamber-web/app/api/whatsapp/webhook/route.ts
/apps/chamber-web/app/api/whatsapp/send-test/route.ts

/apps/chamber-web/lib/db/supabase-admin.ts
/apps/chamber-web/lib/availability/check-availability.ts
/apps/chamber-web/lib/hearings/create-confirmed-hearing.ts
/apps/chamber-web/lib/whatsapp/send-whatsapp-message.ts
/apps/chamber-web/lib/whatsapp/parse-inbound-command.ts
/apps/chamber-web/lib/whatsapp/handle-inbound-message.ts
/apps/chamber-web/lib/whatsapp/types.ts
/apps/chamber-web/lib/utils/date.ts
/apps/chamber-web/lib/security/audit.ts
```

---

# 2. Environment Variables

```env
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

WHATSAPP_VERIFY_TOKEN=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_GRAPH_API_VERSION=v23.0

APP_BASE_URL=https://app.duhai.pk
DEFAULT_ORGANIZATION_ID=
```

For MVP, `DEFAULT_ORGANIZATION_ID` can point to your father's firm/chamber. Later, route organization by WhatsApp phone mapping.

---

# 3. Supabase Migration

File: `/supabase/migrations/0001_court_date_coordination.sql`

```sql
create extension if not exists "pgcrypto";

-- USERS
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid null,
  full_name text not null,
  email text null,
  phone text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ORGANIZATIONS
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'chamber' check (type in ('chamber', 'firm', 'platform')),
  timezone text not null default 'Asia/Karachi',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ORGANIZATION MEMBERS
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

-- COURTS
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

-- MATTERS
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

-- HEARINGS
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

-- DATE REQUESTS
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

-- USER AVAILABILITY BLOCKS
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

-- REMINDERS
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

-- NOTIFICATION TEMPLATES
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

-- NOTIFICATION EVENTS
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

-- WHATSAPP OPT-INS
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

-- WHATSAPP CONTACT MAP
-- Maps inbound WhatsApp phone numbers to users inside an organization.
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

-- ACTIVITY LOG
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

-- INDEXES
create index if not exists idx_org_members_user on public.organization_members(user_id, organization_id);
create index if not exists idx_matters_org on public.matters(organization_id, status) where deleted_at is null;
create index if not exists idx_hearings_org_date on public.hearings(organization_id, hearing_date) where deleted_at is null;
create index if not exists idx_hearings_senior_date on public.hearings(senior_lawyer_id, hearing_date) where deleted_at is null;
create index if not exists idx_hearings_appearing_date on public.hearings(appearing_lawyer_id, hearing_date) where deleted_at is null;
create index if not exists idx_date_requests_org_status on public.date_requests(organization_id, status);
create index if not exists idx_availability_user_date on public.user_availability_blocks(user_id, date);
create index if not exists idx_whatsapp_contacts_phone on public.whatsapp_contacts(phone) where is_active = true;
create index if not exists idx_notification_events_status on public.notification_events(status, channel);

-- RLS
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

-- For MVP, server-side routes use service-role client.
-- Add user-facing RLS policies when auth UI is wired.
```

---

# 4. Supabase Admin Client

File: `/apps/chamber-web/lib/db/supabase-admin.ts`

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
}

if (!serviceRoleKey) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
```

---

# 5. Types

File: `/apps/chamber-web/lib/whatsapp/types.ts`

```ts
export type AvailabilityStatus = "available" | "hard_conflict" | "soft_warning";

export type CheckAvailabilityInput = {
  organizationId: string;
  seniorLawyerId: string;
  appearingLawyerId?: string | null;
  date: string; // YYYY-MM-DD
  startTime?: string | null; // HH:mm or HH:mm:ss
  endTime?: string | null;
  courtId?: string | null;
  matterId?: string | null;
};

export type AvailabilityConflict = {
  type:
    | "senior_same_time"
    | "appearing_same_time"
    | "senior_unavailable"
    | "appearing_unavailable"
    | "same_day_different_court"
    | "duplicate_matter_date";
  severity: "hard" | "soft";
  reason: string;
  relatedEntityId?: string;
};

export type AvailabilityResult = {
  status: AvailabilityStatus;
  isAvailable: boolean;
  reason: string;
  conflicts: AvailabilityConflict[];
};

export type ParsedInboundCommand =
  | {
      ok: true;
      command: "check_slot";
      date: string;
      startTime?: string | null;
      endTime?: string | null;
      seniorLawyerName?: string | null;
      matterText?: string | null;
      courtText?: string | null;
      rawText: string;
    }
  | {
      ok: true;
      command: "save_date";
      date: string;
      startTime?: string | null;
      endTime?: string | null;
      seniorLawyerName?: string | null;
      matterText?: string | null;
      courtText?: string | null;
      rawText: string;
    }
  | {
      ok: false;
      error: string;
      rawText: string;
    };
```

---

# 6. Date Utilities

File: `/apps/chamber-web/lib/utils/date.ts`

```ts
export function normalizeTime(input?: string | null): string | null {
  if (!input) return null;

  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);

  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];

  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  if (hour < 0 || hour > 23) return null;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

export function normalizeDate(input: string): string | null {
  const trimmed = input.trim();

  // Accept YYYY-MM-DD
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return trimmed;

  // Accept DD-MM-YYYY or DD/MM/YYYY
  const dmy = trimmed.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);

    if (day < 1 || day > 31 || month < 1 || month > 12) return null;

    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return null;
}

export function formatDateForWhatsapp(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}-${month}-${year}`;
}

export function timeOverlaps(
  aStart?: string | null,
  aEnd?: string | null,
  bStart?: string | null,
  bEnd?: string | null,
): boolean {
  // If no exact time exists, same date is warning-level, not hard overlap.
  if (!aStart || !bStart) return false;

  const aStartMinutes = toMinutes(aStart);
  const aEndMinutes = toMinutes(aEnd) ?? aStartMinutes + 60;
  const bStartMinutes = toMinutes(bStart);
  const bEndMinutes = toMinutes(bEnd) ?? bStartMinutes + 60;

  return aStartMinutes < bEndMinutes && bStartMinutes < aEndMinutes;
}

function toMinutes(time?: string | null): number | null {
  if (!time) return null;
  const [hourRaw, minuteRaw] = time.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);

  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

  return hour * 60 + minute;
}
```

---

# 7. Availability Checker

File: `/apps/chamber-web/lib/availability/check-availability.ts`

```ts
import "server-only";
import { supabaseAdmin } from "../db/supabase-admin";
import { timeOverlaps } from "../utils/date";
import type {
  AvailabilityConflict,
  AvailabilityResult,
  CheckAvailabilityInput,
} from "../whatsapp/types";

type HearingRow = {
  id: string;
  matter_id: string;
  court_id: string | null;
  hearing_date: string;
  start_time: string | null;
  end_time: string | null;
  purpose: string | null;
  status: string;
  senior_lawyer_id: string | null;
  appearing_lawyer_id: string | null;
};

type AvailabilityBlockRow = {
  id: string;
  user_id: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
  block_type: string;
};

export async function checkAvailability(
  input: CheckAvailabilityInput,
): Promise<AvailabilityResult> {
  const conflicts: AvailabilityConflict[] = [];

  const { data: hearings, error: hearingsError } = await supabaseAdmin
    .from("hearings")
    .select(
      "id,matter_id,court_id,hearing_date,start_time,end_time,purpose,status,senior_lawyer_id,appearing_lawyer_id",
    )
    .eq("organization_id", input.organizationId)
    .eq("hearing_date", input.date)
    .is("deleted_at", null)
    .not("status", "in", "(cancelled,completed)");

  if (hearingsError) {
    throw new Error(`Failed to load hearings: ${hearingsError.message}`);
  }

  const sameDayHearings = (hearings ?? []) as HearingRow[];

  const { data: availabilityBlocks, error: blocksError } = await supabaseAdmin
    .from("user_availability_blocks")
    .select("id,user_id,date,start_time,end_time,reason,block_type")
    .eq("organization_id", input.organizationId)
    .eq("date", input.date)
    .in("user_id", [input.seniorLawyerId, input.appearingLawyerId].filter(Boolean));

  if (blocksError) {
    throw new Error(`Failed to load availability blocks: ${blocksError.message}`);
  }

  for (const block of (availabilityBlocks ?? []) as AvailabilityBlockRow[]) {
    const overlaps = timeOverlaps(
      input.startTime,
      input.endTime,
      block.start_time,
      block.end_time,
    );

    const fullDayBlock = !block.start_time && !block.end_time;

    if (block.user_id === input.seniorLawyerId && (fullDayBlock || overlaps)) {
      conflicts.push({
        type: "senior_unavailable",
        severity: "hard",
        reason: `Senior lawyer is unavailable${block.reason ? `: ${block.reason}` : ""}.`,
        relatedEntityId: block.id,
      });
    }

    if (input.appearingLawyerId && block.user_id === input.appearingLawyerId && (fullDayBlock || overlaps)) {
      conflicts.push({
        type: "appearing_unavailable",
        severity: "hard",
        reason: `Appearing lawyer is unavailable${block.reason ? `: ${block.reason}` : ""}.`,
        relatedEntityId: block.id,
      });
    }
  }

  for (const hearing of sameDayHearings) {
    const overlap = timeOverlaps(
      input.startTime,
      input.endTime,
      hearing.start_time,
      hearing.end_time,
    );

    const noExactTime = !input.startTime || !hearing.start_time;

    if (hearing.senior_lawyer_id === input.seniorLawyerId) {
      if (overlap) {
        conflicts.push({
          type: "senior_same_time",
          severity: "hard",
          reason: "Senior lawyer already has a hearing at this time.",
          relatedEntityId: hearing.id,
        });
      } else if (noExactTime) {
        conflicts.push({
          type: "same_day_different_court",
          severity: "soft",
          reason: "Senior lawyer already has at least one hearing on this date. Time is not exact, so confirm manually.",
          relatedEntityId: hearing.id,
        });
      } else if (input.courtId && hearing.court_id && hearing.court_id !== input.courtId) {
        conflicts.push({
          type: "same_day_different_court",
          severity: "soft",
          reason: "Senior lawyer has another hearing in a different court on the same date.",
          relatedEntityId: hearing.id,
        });
      }
    }

    if (input.appearingLawyerId && hearing.appearing_lawyer_id === input.appearingLawyerId) {
      if (overlap) {
        conflicts.push({
          type: "appearing_same_time",
          severity: "hard",
          reason: "Appearing lawyer already has a hearing at this time.",
          relatedEntityId: hearing.id,
        });
      } else if (noExactTime) {
        conflicts.push({
          type: "same_day_different_court",
          severity: "soft",
          reason: "Appearing lawyer already has another hearing on this date. Time is not exact, so confirm manually.",
          relatedEntityId: hearing.id,
        });
      }
    }

    if (input.matterId && hearing.matter_id === input.matterId) {
      conflicts.push({
        type: "duplicate_matter_date",
        severity: "soft",
        reason: "This matter already has a hearing on the proposed date.",
        relatedEntityId: hearing.id,
      });
    }
  }

  const hasHardConflict = conflicts.some((conflict) => conflict.severity === "hard");
  const hasSoftWarning = conflicts.some((conflict) => conflict.severity === "soft");

  if (hasHardConflict) {
    return {
      status: "hard_conflict",
      isAvailable: false,
      reason: conflicts.find((conflict) => conflict.severity === "hard")?.reason ?? "Slot has a hard conflict.",
      conflicts,
    };
  }

  if (hasSoftWarning) {
    return {
      status: "soft_warning",
      isAvailable: true,
      reason: "Slot is not blocked, but there are warnings. Confirm manually before taking the date.",
      conflicts,
    };
  }

  return {
    status: "available",
    isAvailable: true,
    reason: "Slot is available. No conflict found.",
    conflicts,
  };
}
```

---

# 8. Create Confirmed Hearing

File: `/apps/chamber-web/lib/hearings/create-confirmed-hearing.ts`

```ts
import "server-only";
import { supabaseAdmin } from "../db/supabase-admin";
import { checkAvailability } from "../availability/check-availability";
import { writeActivityLog } from "../security/audit";

type CreateConfirmedHearingInput = {
  organizationId: string;
  matterId: string;
  courtId?: string | null;
  hearingDate: string;
  startTime?: string | null;
  endTime?: string | null;
  seniorLawyerId: string;
  appearingLawyerId?: string | null;
  clerkId?: string | null;
  createdBy?: string | null;
  purpose?: string | null;
};

export async function createConfirmedHearing(input: CreateConfirmedHearingInput) {
  const availability = await checkAvailability({
    organizationId: input.organizationId,
    seniorLawyerId: input.seniorLawyerId,
    appearingLawyerId: input.appearingLawyerId,
    date: input.hearingDate,
    startTime: input.startTime,
    endTime: input.endTime,
    courtId: input.courtId,
    matterId: input.matterId,
  });

  if (availability.status === "hard_conflict") {
    return {
      ok: false as const,
      error: availability.reason,
      availability,
    };
  }

  const { data, error } = await supabaseAdmin
    .from("hearings")
    .insert({
      organization_id: input.organizationId,
      matter_id: input.matterId,
      court_id: input.courtId ?? null,
      hearing_date: input.hearingDate,
      start_time: input.startTime ?? null,
      end_time: input.endTime ?? null,
      purpose: input.purpose ?? "Next hearing",
      status: "scheduled",
      senior_lawyer_id: input.seniorLawyerId,
      appearing_lawyer_id: input.appearingLawyerId ?? null,
      clerk_id: input.clerkId ?? null,
      file_status: "unknown",
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to create hearing: ${error.message}`);
  }

  await writeActivityLog({
    organizationId: input.organizationId,
    actorUserId: input.createdBy ?? null,
    action: "hearing.created_from_whatsapp",
    entityType: "hearing",
    entityId: data.id,
    metadata: {
      matterId: input.matterId,
      hearingDate: input.hearingDate,
      startTime: input.startTime,
      availabilityStatus: availability.status,
    },
  });

  return {
    ok: true as const,
    hearingId: data.id as string,
    availability,
  };
}
```

---

# 9. Audit Helper

File: `/apps/chamber-web/lib/security/audit.ts`

```ts
import "server-only";
import { supabaseAdmin } from "../db/supabase-admin";

type WriteActivityLogInput = {
  organizationId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown> | null;
};

export async function writeActivityLog(input: WriteActivityLogInput): Promise<void> {
  const { error } = await supabaseAdmin.from("activity_log").insert({
    organization_id: input.organizationId ?? null,
    actor_user_id: input.actorUserId ?? null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    metadata_json: input.metadata ?? null,
  });

  if (error) {
    // Do not throw and break core workflow because audit insert failed.
    // But keep this server-side only; never include PII here.
    console.error("activity_log_insert_failed", {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
    });
  }
}
```

---

# 10. WhatsApp Command Parser

File: `/apps/chamber-web/lib/whatsapp/parse-inbound-command.ts`

```ts
import { normalizeDate, normalizeTime } from "../utils/date";
import type { ParsedInboundCommand } from "./types";

export function parseInboundCommand(rawText: string): ParsedInboundCommand {
  const text = rawText.trim();
  const lowered = text.toLowerCase();

  const isCheck = lowered.startsWith("check") || lowered.startsWith("slot") || lowered.includes("available");
  const isSave = lowered.startsWith("save") || lowered.startsWith("confirm") || lowered.startsWith("date confirmed");

  if (!isCheck && !isSave) {
    return {
      ok: false,
      error:
        "Command not understood. Send: CHECK 12-05-2026 10am matter: ABC court: Lahore High Court senior: Ali",
      rawText,
    };
  }

  const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/);
  if (!dateMatch) {
    return {
      ok: false,
      error: "Date missing. Use DD-MM-YYYY, DD/MM/YYYY, or YYYY-MM-DD.",
      rawText,
    };
  }

  const date = normalizeDate(dateMatch[1]);
  if (!date) {
    return {
      ok: false,
      error: "Invalid date format.",
      rawText,
    };
  }

  const timeMatch = text.match(/(?:\s|^)(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s|$)/i);
  const startTime = timeMatch ? normalizeTime(timeMatch[1]) : null;

  const seniorLawyerName = getKeyValue(text, "senior");
  const matterText = getKeyValue(text, "matter");
  const courtText = getKeyValue(text, "court");

  return {
    ok: true,
    command: isSave ? "save_date" : "check_slot",
    date,
    startTime,
    endTime: null,
    seniorLawyerName,
    matterText,
    courtText,
    rawText,
  };
}

function getKeyValue(text: string, key: string): string | null {
  const regex = new RegExp(`${key}\\s*:\\s*([^\\n]+)`, "i");
  const match = text.match(regex);
  if (!match) return null;

  // Stop at next known key if user writes in one line.
  return match[1]
    .split(/\s+(matter|court|senior)\s*:/i)[0]
    .trim();
}
```

Example accepted commands:

```txt
CHECK 12-05-2026 10am senior: Ali matter: State vs Khan court: Model Town Court

SAVE 12-05-2026 10am senior: Ali matter: State vs Khan court: Model Town Court

CONFIRM 2026-05-12 11:30 senior: Ahmed matter: Recovery case court: Banking Court Lahore
```

---

# 11. WhatsApp Sender

File: `/apps/chamber-web/lib/whatsapp/send-whatsapp-message.ts`

```ts
import "server-only";
import { supabaseAdmin } from "../db/supabase-admin";

type SendWhatsappTextInput = {
  organizationId: string;
  to: string;
  body: string;
  entityType: string;
  entityId: string;
  recipientUserId?: string | null;
};

export async function sendWhatsappText(input: SendWhatsappTextInput) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_GRAPH_API_VERSION ?? "v23.0";

  if (!token || !phoneNumberId) {
    await recordNotificationEvent({
      ...input,
      status: "failed",
      failureReason: "WhatsApp API env vars missing.",
      providerMessageId: null,
    });

    return { ok: false as const, error: "WhatsApp API env vars missing." };
  }

  await recordNotificationEvent({
    ...input,
    status: "sending",
    failureReason: null,
    providerMessageId: null,
  });

  const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: input.to,
      type: "text",
      text: {
        preview_url: false,
        body: input.body,
      },
    }),
  });

  const json = (await response.json()) as unknown;

  if (!response.ok) {
    await recordNotificationEvent({
      ...input,
      status: "failed",
      failureReason: JSON.stringify(json),
      providerMessageId: null,
    });

    return { ok: false as const, error: "Failed to send WhatsApp message.", details: json };
  }

  const providerMessageId = extractProviderMessageId(json);

  await recordNotificationEvent({
    ...input,
    status: "sent",
    failureReason: null,
    providerMessageId,
  });

  return { ok: true as const, providerMessageId, raw: json };
}

async function recordNotificationEvent(input: SendWhatsappTextInput & {
  status: "sending" | "sent" | "failed";
  failureReason: string | null;
  providerMessageId: string | null;
}) {
  await supabaseAdmin.from("notification_events").insert({
    organization_id: input.organizationId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    channel: "whatsapp",
    recipient_user_id: input.recipientUserId ?? null,
    recipient_phone: input.to,
    message_preview: input.body.slice(0, 500),
    provider: "meta_cloud_api",
    provider_message_id: input.providerMessageId,
    status: input.status,
    failure_reason: input.failureReason,
    sent_at: input.status === "sent" ? new Date().toISOString() : null,
  });
}

function extractProviderMessageId(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const maybe = json as { messages?: Array<{ id?: string }> };
  return maybe.messages?.[0]?.id ?? null;
}
```

Note: In production, use template messages for business-initiated alerts outside WhatsApp’s customer-service window. This direct text sender is useful for replying inside a user-initiated webhook conversation during MVP testing.

---

# 12. Inbound WhatsApp Handler

File: `/apps/chamber-web/lib/whatsapp/handle-inbound-message.ts`

```ts
import "server-only";
import { supabaseAdmin } from "../db/supabase-admin";
import { checkAvailability } from "../availability/check-availability";
import { createConfirmedHearing } from "../hearings/create-confirmed-hearing";
import { formatDateForWhatsapp } from "../utils/date";
import { parseInboundCommand } from "./parse-inbound-command";
import { sendWhatsappText } from "./send-whatsapp-message";

type HandleInboundMessageInput = {
  fromPhone: string;
  text: string;
};

type WhatsappContactRow = {
  organization_id: string;
  user_id: string;
  users: {
    id: string;
    full_name: string;
  } | null;
};

type UserRow = {
  id: string;
  full_name: string;
  phone: string | null;
};

type MatterRow = {
  id: string;
  title: string;
  court_id: string | null;
};

type CourtRow = {
  id: string;
  name: string;
};

export async function handleInboundWhatsappMessage(input: HandleInboundMessageInput) {
  const sender = await findWhatsappSender(input.fromPhone);

  if (!sender) {
    await sendWhatsappText({
      organizationId: process.env.DEFAULT_ORGANIZATION_ID ?? "00000000-0000-0000-0000-000000000000",
      to: input.fromPhone,
      body: "Your WhatsApp number is not registered with this chamber. Ask admin to add your number first.",
      entityType: "whatsapp_inbound",
      entityId: crypto.randomUUID(),
    });
    return;
  }

  const parsed = parseInboundCommand(input.text);

  if (!parsed.ok) {
    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body: parsed.error,
      entityType: "whatsapp_inbound",
      entityId: sender.user_id,
      recipientUserId: sender.user_id,
    });
    return;
  }

  const senior = await resolveSeniorLawyer({
    organizationId: sender.organization_id,
    seniorLawyerName: parsed.seniorLawyerName,
  });

  if (!senior) {
    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body: "Senior lawyer not found. Use: senior: Full Name. Example: senior: Ali Khan",
      entityType: "whatsapp_inbound",
      entityId: sender.user_id,
      recipientUserId: sender.user_id,
    });
    return;
  }

  const matter = await resolveMatter({
    organizationId: sender.organization_id,
    matterText: parsed.matterText,
    createdBy: sender.user_id,
  });

  const court = await resolveCourt({
    organizationId: sender.organization_id,
    courtText: parsed.courtText,
  });

  if (parsed.command === "check_slot") {
    const availability = await checkAvailability({
      organizationId: sender.organization_id,
      seniorLawyerId: senior.id,
      appearingLawyerId: sender.user_id,
      date: parsed.date,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      courtId: court?.id ?? matter.court_id ?? null,
      matterId: matter.id,
    });

    const body = formatAvailabilityReply({
      date: parsed.date,
      time: parsed.startTime,
      seniorName: senior.full_name,
      matterTitle: matter.title,
      courtName: court?.name ?? "Not specified",
      isSave: false,
      availability,
    });

    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body,
      entityType: "matter",
      entityId: matter.id,
      recipientUserId: sender.user_id,
    });

    return;
  }

  const created = await createConfirmedHearing({
    organizationId: sender.organization_id,
    matterId: matter.id,
    courtId: court?.id ?? matter.court_id ?? null,
    hearingDate: parsed.date,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    seniorLawyerId: senior.id,
    appearingLawyerId: sender.user_id,
    createdBy: sender.user_id,
    purpose: "Next hearing confirmed from court",
  });

  if (!created.ok) {
    const body = formatAvailabilityReply({
      date: parsed.date,
      time: parsed.startTime,
      seniorName: senior.full_name,
      matterTitle: matter.title,
      courtName: court?.name ?? "Not specified",
      isSave: true,
      availability: created.availability,
    });

    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body: `Date NOT saved.\n\n${body}`,
      entityType: "matter",
      entityId: matter.id,
      recipientUserId: sender.user_id,
    });
    return;
  }

  await sendWhatsappText({
    organizationId: sender.organization_id,
    to: input.fromPhone,
    body:
      `Saved in chamber diary.\n\n` +
      `Matter: ${matter.title}\n` +
      `Court: ${court?.name ?? "Not specified"}\n` +
      `Date: ${formatDateForWhatsapp(parsed.date)}\n` +
      `Time: ${parsed.startTime ?? "Not specified"}\n` +
      `Senior: ${senior.full_name}\n\n` +
      (created.availability.status === "soft_warning"
        ? `Warning: ${created.availability.reason}`
        : "No clash found."),
    entityType: "hearing",
    entityId: created.hearingId,
    recipientUserId: sender.user_id,
  });
}

async function findWhatsappSender(phone: string): Promise<WhatsappContactRow | null> {
  const normalized = normalizeWhatsappPhone(phone);

  const { data, error } = await supabaseAdmin
    .from("whatsapp_contacts")
    .select("organization_id,user_id,users(id,full_name)")
    .eq("phone", normalized)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve WhatsApp sender: ${error.message}`);

  return data as WhatsappContactRow | null;
}

async function resolveSeniorLawyer(input: {
  organizationId: string;
  seniorLawyerName?: string | null;
}): Promise<UserRow | null> {
  if (!input.seniorLawyerName) {
    const { data, error } = await supabaseAdmin
      .from("organization_members")
      .select("users(id,full_name,phone)")
      .eq("organization_id", input.organizationId)
      .eq("role", "senior_lawyer")
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Failed to resolve default senior lawyer: ${error.message}`);

    const row = data as { users: UserRow | null } | null;
    return row?.users ?? null;
  }

  const { data, error } = await supabaseAdmin
    .from("organization_members")
    .select("users(id,full_name,phone)")
    .eq("organization_id", input.organizationId)
    .eq("role", "senior_lawyer")
    .eq("status", "active")
    .ilike("users.full_name", `%${input.seniorLawyerName}%`)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve senior lawyer: ${error.message}`);

  const row = data as { users: UserRow | null } | null;
  return row?.users ?? null;
}

async function resolveMatter(input: {
  organizationId: string;
  matterText?: string | null;
  createdBy: string;
}): Promise<MatterRow> {
  const title = input.matterText?.trim() || "WhatsApp quick matter";

  const { data: existing, error: findError } = await supabaseAdmin
    .from("matters")
    .select("id,title,court_id")
    .eq("organization_id", input.organizationId)
    .ilike("title", `%${title}%`)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();

  if (findError) throw new Error(`Failed to resolve matter: ${findError.message}`);
  if (existing) return existing as MatterRow;

  const { data: created, error: createError } = await supabaseAdmin
    .from("matters")
    .insert({
      organization_id: input.organizationId,
      title,
      source: "manual",
      status: "open",
      priority: "normal",
      created_by: input.createdBy,
    })
    .select("id,title,court_id")
    .single();

  if (createError) throw new Error(`Failed to create matter: ${createError.message}`);

  return created as MatterRow;
}

async function resolveCourt(input: {
  organizationId: string;
  courtText?: string | null;
}): Promise<CourtRow | null> {
  const name = input.courtText?.trim();
  if (!name) return null;

  const { data: existing, error: findError } = await supabaseAdmin
    .from("courts")
    .select("id,name")
    .or(`organization_id.eq.${input.organizationId},organization_id.is.null`)
    .ilike("name", `%${name}%`)
    .limit(1)
    .maybeSingle();

  if (findError) throw new Error(`Failed to resolve court: ${findError.message}`);
  if (existing) return existing as CourtRow;

  const { data: created, error: createError } = await supabaseAdmin
    .from("courts")
    .insert({
      organization_id: input.organizationId,
      name,
    })
    .select("id,name")
    .single();

  if (createError) throw new Error(`Failed to create court: ${createError.message}`);

  return created as CourtRow;
}

function formatAvailabilityReply(input: {
  date: string;
  time?: string | null;
  seniorName: string;
  matterTitle: string;
  courtName: string;
  isSave: boolean;
  availability: {
    status: string;
    isAvailable: boolean;
    reason: string;
    conflicts: Array<{ severity: string; reason: string }>;
  };
}): string {
  const statusLine = input.availability.isAvailable ? "YES — slot is available." : "NO — slot has a clash.";
  const warningLine = input.availability.status === "soft_warning" ? "Available with warning." : "";
  const conflicts = input.availability.conflicts
    .slice(0, 3)
    .map((conflict, index) => `${index + 1}. ${conflict.reason}`)
    .join("\n");

  return [
    statusLine,
    warningLine,
    "",
    `Matter: ${input.matterTitle}`,
    `Court: ${input.courtName}`,
    `Date: ${formatDateForWhatsapp(input.date)}`,
    `Time: ${input.time ?? "Not specified"}`,
    `Senior: ${input.seniorName}`,
    "",
    `Reason: ${input.availability.reason}`,
    conflicts ? `\nConflicts/warnings:\n${conflicts}` : "",
    "",
    input.availability.isAvailable
      ? "If court confirms this date, reply with SAVE and the same details."
      : "Do not take this date unless senior lawyer overrides it.",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeWhatsappPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  if (digits.startsWith("92")) return `+${digits}`;
  if (digits.startsWith("0")) return `+92${digits.slice(1)}`;
  return `+${digits}`;
}
```

---

# 13. WhatsApp Webhook Route

File: `/apps/chamber-web/app/api/whatsapp/webhook/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { handleInboundWhatsappMessage } from "../../../../lib/whatsapp/handle-inbound-message";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as WhatsAppWebhookPayload;

  const messages = extractInboundMessages(body);

  for (const message of messages) {
    if (message.type !== "text" || !message.text?.body) continue;

    await handleInboundWhatsappMessage({
      fromPhone: message.from,
      text: message.text.body,
    });
  }

  return NextResponse.json({ ok: true });
}

type WhatsAppWebhookPayload = {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: {
            body?: string;
          };
        }>;
      };
    }>;
  }>;
};

function extractInboundMessages(payload: WhatsAppWebhookPayload) {
  return (
    payload.entry?.flatMap((entry) =>
      entry.changes?.flatMap((change) => change.value?.messages ?? []) ?? [],
    ) ?? []
  );
}
```

---

# 14. Optional Send Test Route

File: `/apps/chamber-web/app/api/whatsapp/send-test/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { sendWhatsappText } from "../../../../lib/whatsapp/send-whatsapp-message";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    to: string;
    message: string;
    organizationId: string;
  };

  if (!body.to || !body.message || !body.organizationId) {
    return NextResponse.json(
      { error: "to, message, and organizationId are required" },
      { status: 400 },
    );
  }

  const result = await sendWhatsappText({
    organizationId: body.organizationId,
    to: body.to,
    body: body.message,
    entityType: "manual_test",
    entityId: crypto.randomUUID(),
  });

  return NextResponse.json(result);
}
```

---

# 15. Seed Minimal Chamber Data

Run this manually in Supabase SQL editor for local MVP testing.

Replace phone numbers.

```sql
insert into public.organizations (id, name, type)
values ('11111111-1111-1111-1111-111111111111', 'Pilot Chamber', 'chamber')
on conflict do nothing;

insert into public.users (id, full_name, email, phone)
values
  ('22222222-2222-2222-2222-222222222222', 'Senior Lawyer', 'senior@example.com', '+923001111111'),
  ('33333333-3333-3333-3333-333333333333', 'Junior Lawyer', 'junior@example.com', '+923002222222')
on conflict do nothing;

insert into public.organization_members (organization_id, user_id, role, status)
values
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'senior_lawyer', 'active'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'junior_lawyer', 'active')
on conflict do nothing;

insert into public.whatsapp_contacts (organization_id, user_id, phone)
values
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '+923002222222')
on conflict do nothing;

insert into public.whatsapp_opt_ins (organization_id, user_id, phone, opt_in_status, opted_in_at, source)
values
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '+923002222222', 'opted_in', now(), 'manual_seed')
on conflict do nothing;
```

Set:

```env
DEFAULT_ORGANIZATION_ID=11111111-1111-1111-1111-111111111111
```

---

# 16. Test Commands from WhatsApp

Send from the registered junior’s WhatsApp number:

```txt
CHECK 12-05-2026 10am senior: Senior Lawyer matter: Cheque case court: Banking Court Lahore
```

Expected reply:

```txt
YES — slot is available.

Matter: Cheque case
Court: Banking Court Lahore
Date: 12-05-2026
Time: 10:00:00
Senior: Senior Lawyer

Reason: Slot is available. No conflict found.

If court confirms this date, reply with SAVE and the same details.
```

Then send:

```txt
SAVE 12-05-2026 10am senior: Senior Lawyer matter: Cheque case court: Banking Court Lahore
```

Expected reply:

```txt
Saved in chamber diary.

Matter: Cheque case
Court: Banking Court Lahore
Date: 12-05-2026
Time: 10:00:00
Senior: Senior Lawyer

No clash found.
```

If a clash exists, expected reply:

```txt
Date NOT saved.

NO — slot has a clash.
Reason: Senior lawyer already has a hearing at this time.
Do not take this date unless senior lawyer overrides it.
```

---

# 17. Immediate Next UI Files to Build

After this backend slice works, build:

```txt
/apps/chamber-web/app/(dashboard)/diary/page.tsx
/apps/chamber-web/app/(dashboard)/date-requests/page.tsx
/apps/chamber-web/app/(dashboard)/availability/page.tsx
/apps/chamber-web/components/diary/HearingCard.tsx
/apps/chamber-web/components/diary/CourtDiaryTable.tsx
/apps/chamber-web/components/availability/AvailabilityChecker.tsx
/apps/chamber-web/components/whatsapp/WhatsAppAlertCenter.tsx
```

Do not build the full UI before testing the WhatsApp flow. First prove the loop:

1. WhatsApp inbound works.
2. Availability check works.
3. Conflict detection works.
4. Save hearing works.
5. Notification events are recorded.

---

# 18. Known MVP Limitations

This is intentionally simple.

Current limitations:

- Matter resolution uses title search and auto-creates if missing.
- Court resolution uses name search and auto-creates if missing.
- Senior lawyer resolution uses name search or first senior lawyer.
- Natural language parsing is basic.
- Date confirmations are trusted from registered junior phone number.
- No senior approval link yet.
- WhatsApp template messages are not fully wired yet.

Next iteration:

- Add senior approval workflow.
- Add short signed approval links.
- Add command IDs: `REQ-1234`.
- Add structured WhatsApp interactive buttons.
- Add dashboard UI.
- Add reminder scheduler.
- Add template-message sender for proactive alerts.

---

# 19. Next Iteration Command Format

After MVP, improve WhatsApp commands to use IDs:

```txt
CHECK REQ matter: M-102 date: 12-05-2026 time: 10am court: Banking Court Lahore senior: SIR
```

Reply:

```txt
REQ-2401: Slot available with warning.
Reply SEND REQ-2401 to ask senior.
Reply SAVE REQ-2401 if court confirms.
```

This avoids repeated parsing mistakes.


import "server-only";
import { checkAvailability } from "../availability/check-availability";
import { getSupabaseAdmin } from "../db/supabase-admin";
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
      organizationId:
        process.env.DEFAULT_ORGANIZATION_ID ?? "00000000-0000-0000-0000-000000000000",
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

    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body: formatAvailabilityReply({
        date: parsed.date,
        time: parsed.startTime,
        seniorName: senior.full_name,
        matterTitle: matter.title,
        courtName: court?.name ?? "Not specified",
        availability,
      }),
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
    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body: `Date NOT saved.\n\n${formatAvailabilityReply({
        date: parsed.date,
        time: parsed.startTime,
        seniorName: senior.full_name,
        matterTitle: matter.title,
        courtName: court?.name ?? "Not specified",
        availability: created.availability,
      })}`,
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
  const supabaseAdmin = getSupabaseAdmin();

  const { data, error } = await supabaseAdmin
    .from("whatsapp_contacts")
    .select("organization_id,user_id")
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
  const supabaseAdmin = getSupabaseAdmin();
  const query = supabaseAdmin
    .from("organization_members")
    .select("users(id,full_name,phone)")
    .eq("organization_id", input.organizationId)
    .eq("role", "senior_lawyer")
    .eq("status", "active")
    .limit(1);

  if (input.seniorLawyerName) {
    query.ilike("users.full_name", `%${input.seniorLawyerName}%`);
  }

  const { data, error } = await query.maybeSingle();

  if (error) throw new Error(`Failed to resolve senior lawyer: ${error.message}`);

  const row = data as { users: UserRow | UserRow[] | null } | null;
  return normalizeJoinedUser(row?.users);
}

async function resolveMatter(input: {
  organizationId: string;
  matterText?: string | null;
  createdBy: string;
}): Promise<MatterRow> {
  const title = input.matterText?.trim() || "WhatsApp quick matter";
  const supabaseAdmin = getSupabaseAdmin();

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
  const supabaseAdmin = getSupabaseAdmin();

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
  availability: {
    status: string;
    isAvailable: boolean;
    reason: string;
    conflicts: Array<{ severity: string; reason: string }>;
  };
}): string {
  const statusLine = input.availability.isAvailable
    ? "YES - slot is available."
    : "NO - slot has a clash.";
  const warningLine =
    input.availability.status === "soft_warning" ? "Available with warning." : "";
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

function normalizeJoinedUser(value: UserRow | UserRow[] | null | undefined): UserRow | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

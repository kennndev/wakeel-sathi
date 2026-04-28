import "server-only";
import { checkAvailability } from "../availability/check-availability";
import { getSupabaseAdmin } from "../db/supabase-admin";
import { createConfirmedHearing } from "../hearings/create-confirmed-hearing";
import {
  addNextDateFromOutcome,
  createHearingOutcome,
  findLatestHearingForMatterReference,
  findOpenOutcomeForMatterReference,
  parseOutcomeDate,
  parseOutcomeTime,
  type NextDateStatus,
  type OutcomeType,
} from "../outcomes/hearing-outcomes";
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
  case_number: string | null;
  court_id: string | null;
};

type CourtRow = {
  id: string;
  name: string;
};

export async function handleInboundWhatsappMessage(input: HandleInboundMessageInput) {
  const sender = await findWhatsappSender(input.fromPhone);

  if (!sender) {
    const fallbackOrganizationId = await getFallbackOrganizationId();

    await sendWhatsappText({
      organizationId: fallbackOrganizationId,
      to: input.fromPhone,
      body: "Your WhatsApp number is not registered with this chamber. Ask admin to add your number first.",
      entityType: "whatsapp_inbound",
      entityId: crypto.randomUUID(),
    });
    return;
  }

  if (isOutcomeCommand(input.text)) {
    await handleOutcomeWhatsappCommand({
      organizationId: sender.organization_id,
      senderUserId: sender.user_id,
      fromPhone: input.fromPhone,
      text: input.text,
    });
    return;
  }

  if (isNextDateCommand(input.text)) {
    await handleNextDateWhatsappCommand({
      organizationId: sender.organization_id,
      senderUserId: sender.user_id,
      fromPhone: input.fromPhone,
      text: input.text,
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
      `Case no: ${matter.case_number ?? "Not set"}\n` +
      `Hearing ID: ${created.hearingId}\n` +
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

  await notifySeniorOfConfirmedHearing({
    organizationId: sender.organization_id,
    senior,
    senderUserId: sender.user_id,
    hearingId: created.hearingId,
    matterTitle: matter.title,
    courtName: court?.name ?? "Not specified",
    hearingDate: parsed.date,
    startTime: parsed.startTime,
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

async function getFallbackOrganizationId(): Promise<string> {
  const configured = process.env.DEFAULT_ORGANIZATION_ID?.trim();
  if (configured) return configured;

  const { data, error } = await getSupabaseAdmin()
    .from("organizations")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve fallback organization: ${error.message}`);
  if (data?.id) return data.id as string;

  throw new Error("No chamber exists. Create a chamber in /setup first.");
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
    .select("id,title,case_number,court_id")
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
    .select("id,title,case_number,court_id")
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

async function notifySeniorOfConfirmedHearing(input: {
  organizationId: string;
  senior: UserRow;
  senderUserId: string;
  hearingId: string;
  matterTitle: string;
  courtName: string;
  hearingDate: string;
  startTime?: string | null;
}) {
  if (input.senior.id === input.senderUserId) return;

  const phone = await getWhatsappPhoneForUser({
    organizationId: input.organizationId,
    userId: input.senior.id,
  });

  if (!phone) return;

  await sendWhatsappText({
    organizationId: input.organizationId,
    to: phone,
    body:
      `Hearing date confirmed.\n\n` +
      `Matter: ${input.matterTitle}\n` +
      `Hearing ID: ${input.hearingId}\n` +
      `Court: ${input.courtName}\n` +
      `Date: ${formatDateForWhatsapp(input.hearingDate)}\n` +
      `Time: ${input.startTime ?? "Not specified"}\n\n` +
      `A reminder will be sent one day before the hearing.`,
    entityType: "hearing",
    entityId: input.hearingId,
    recipientUserId: input.senior.id,
  });
}

async function getWhatsappPhoneForUser(input: {
  organizationId: string;
  userId: string;
}): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data: contact, error: contactError } = await supabase
    .from("whatsapp_contacts")
    .select("phone")
    .eq("organization_id", input.organizationId)
    .eq("user_id", input.userId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (contactError) {
    throw new Error(`Failed to load senior WhatsApp contact: ${contactError.message}`);
  }

  if (contact?.phone) return contact.phone as string;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("phone")
    .eq("id", input.userId)
    .maybeSingle();

  if (userError) {
    throw new Error(`Failed to load senior phone: ${userError.message}`);
  }

  return (user?.phone as string | undefined) ?? null;
}

async function handleOutcomeWhatsappCommand(input: {
  organizationId: string;
  senderUserId: string;
  fromPhone: string;
  text: string;
}) {
  const parsed = parseOutcomeWhatsappText(input.text);

  if (!parsed.ok) {
    await sendWhatsappText({
      organizationId: input.organizationId,
      to: input.fromPhone,
      body: parsed.error,
      entityType: "whatsapp_inbound",
      entityId: input.senderUserId,
      recipientUserId: input.senderUserId,
    });
    return;
  }

  const openOutcome = await findOpenOutcomeForMatterReference({
    organizationId: input.organizationId,
    reference: parsed.matterReference,
  });
  const hearing =
    openOutcome?.hearing ??
    (await findLatestHearingForMatterReference({
      organizationId: input.organizationId,
      reference: parsed.matterReference,
    }));

  if (!hearing) {
    await sendWhatsappText({
      organizationId: input.organizationId,
      to: input.fromPhone,
      body:
        `Matter/hearing not found for "${parsed.matterReference}". ` +
        `Use a case number, exact matter title, short hearing ID, or full hearing ID already saved in diary.`,
      entityType: "whatsapp_inbound",
      entityId: input.senderUserId,
      recipientUserId: input.senderUserId,
    });
    return;
  }

  if (parsed.nextDateStatus === "entered" && parsed.nextDate) {
    const nextHearingId = await addNextDateFromOutcome({
      organizationId: input.organizationId,
      sourceHearingId: hearing.id,
      matterId: hearing.matter_id,
      courtId: hearing.court_id,
      hearingDate: parsed.nextDate,
      startTime: parsed.nextTime,
      seniorLawyerId: hearing.senior_lawyer_id,
      appearingLawyerId: hearing.appearing_lawyer_id,
      createdBy: input.senderUserId,
      purpose: "Next hearing from WhatsApp outcome",
    });

    await sendWhatsappText({
      organizationId: input.organizationId,
      to: input.fromPhone,
      body:
        `Outcome saved.\n` +
        `Next date added to diary: ${formatDateForWhatsapp(parsed.nextDate)}.\n` +
        `Hearing ID: ${nextHearingId}`,
      entityType: "hearing",
      entityId: nextHearingId,
      recipientUserId: input.senderUserId,
    });
    return;
  }

  await createHearingOutcome({
    organizationId: input.organizationId,
    hearingId: hearing.id,
    matterId: hearing.matter_id,
    updatedBy: input.senderUserId,
    appearanceStatus: "appeared",
    outcomeType: parsed.outcomeType,
    outcomeSummary: parsed.summary,
    nextDateStatus: parsed.nextDateStatus,
  });

  await sendWhatsappText({
    organizationId: input.organizationId,
    to: input.fromPhone,
    body:
      parsed.nextDateStatus === "pending"
        ? "Outcome saved.\nThis matter is now in Missing Next-Date queue.\nReminder will stay active until next date is entered."
        : `Outcome saved.\nStatus: ${parsed.nextDateStatus}.`,
    entityType: "hearing",
    entityId: hearing.id,
    recipientUserId: input.senderUserId,
  });
}

async function handleNextDateWhatsappCommand(input: {
  organizationId: string;
  senderUserId: string;
  fromPhone: string;
  text: string;
}) {
  const parsed = parseNextDateWhatsappText(input.text);

  if (!parsed.ok) {
    await sendWhatsappText({
      organizationId: input.organizationId,
      to: input.fromPhone,
      body: parsed.error,
      entityType: "whatsapp_inbound",
      entityId: input.senderUserId,
      recipientUserId: input.senderUserId,
    });
    return;
  }

  const openOutcome = await findOpenOutcomeForMatterReference({
    organizationId: input.organizationId,
    reference: parsed.matterReference,
  });

  if (!openOutcome?.hearing) {
    await sendWhatsappText({
      organizationId: input.organizationId,
      to: input.fromPhone,
      body: `No Missing Next-Date item found for "${parsed.matterReference}".`,
      entityType: "whatsapp_inbound",
      entityId: input.senderUserId,
      recipientUserId: input.senderUserId,
    });
    return;
  }

  await addNextDateFromOutcome({
    organizationId: input.organizationId,
    sourceHearingId: openOutcome.hearing.id,
    matterId: openOutcome.hearing.matter_id,
    courtId: openOutcome.hearing.court_id,
    hearingDate: parsed.nextDate,
    startTime: parsed.nextTime,
    seniorLawyerId: openOutcome.hearing.senior_lawyer_id,
    appearingLawyerId: openOutcome.hearing.appearing_lawyer_id,
    createdBy: input.senderUserId,
    purpose: "Next hearing fixed from WhatsApp",
  });

  await sendWhatsappText({
    organizationId: input.organizationId,
    to: input.fromPhone,
    body:
      `Next date saved.\n` +
      `Matter removed from Missing Next-Date queue.\n` +
      `Date: ${formatDateForWhatsapp(parsed.nextDate)}\n` +
      `Time: ${parsed.nextTime ?? "Not specified"}`,
    entityType: "hearing_outcome",
    entityId: openOutcome.outcomeId,
    recipientUserId: input.senderUserId,
  });
}

function isOutcomeCommand(text: string) {
  return text.trim().toLowerCase().startsWith("outcome ");
}

function isNextDateCommand(text: string) {
  return text.trim().toLowerCase().startsWith("nextdate ");
}

function parseOutcomeWhatsappText(text: string):
  | {
      ok: true;
      matterReference: string;
      outcomeType: OutcomeType;
      nextDateStatus: NextDateStatus;
      nextDate: string | null;
      nextTime: string | null;
      summary: string;
    }
  | { ok: false; error: string } {
  const outcomeWords =
    "adjourned|disposed|reserved|order_reserved|order-reserved|cause-list|cause_list|awaiting_cause_list|awaiting-cause-list|no_proceedings|no-proceedings|pending|other";
  const match = text
    .trim()
    .match(new RegExp(`^outcome\\s+(.+?)\\s+(${outcomeWords})(.*)$`, "i"));
  if (!match) {
    return {
      ok: false,
      error:
        'Use: OUTCOME "Matter title/case number/hearing ID" adjourned next: 12-05-2026 OR next: pending',
    };
  }

  const matterReference = match[1].trim().replace(/^["']|["']$/g, "");
  const outcomeWord = match[2].toLowerCase();
  const rest = match[3] ?? "";
  const outcomeType = normalizeOutcomeType(outcomeWord);
  const nextValue = rest.match(/next\s*:\s*([^\n]+)/i)?.[1]?.trim() ?? null;

  if (!outcomeType) {
    return { ok: false, error: "Unknown outcome. Use adjourned, disposed, reserved, cause-list." };
  }

  if (!nextValue && outcomeType === "adjourned") {
    return { ok: false, error: "Adjourned outcome needs next: DD-MM-YYYY or next: pending." };
  }

  const nextDateStatus = getNextDateStatus(outcomeType, nextValue);
  const nextDateMatch = nextValue?.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})/);
  const nextDate = nextDateMatch ? parseOutcomeDate(nextDateMatch[1]) : null;
  const nextTime = parseOutcomeTime(nextValue?.replace(nextDateMatch?.[1] ?? "", "").trim());

  if (nextDateStatus === "entered" && !nextDate) {
    return { ok: false, error: "Invalid next date. Use DD-MM-YYYY, DD/MM/YYYY, or YYYY-MM-DD." };
  }

  return {
    ok: true,
    matterReference,
    outcomeType,
    nextDateStatus,
    nextDate,
    nextTime,
    summary: `WhatsApp outcome: ${outcomeType}${nextValue ? `, next: ${nextValue}` : ""}`,
  };
}

function parseNextDateWhatsappText(text: string):
  | { ok: true; matterReference: string; nextDate: string; nextTime: string | null }
  | { ok: false; error: string } {
  const match = text
    .trim()
    .match(/^nextdate\s+(.+?)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})(.*)$/i);

  if (!match) {
    return { ok: false, error: 'Use: NEXTDATE "Matter title/case number/hearing ID" 12-05-2026 10am' };
  }

  const nextDate = parseOutcomeDate(match[2]);
  if (!nextDate) return { ok: false, error: "Invalid date format." };

  return {
    ok: true,
    matterReference: match[1].trim().replace(/^["']|["']$/g, ""),
    nextDate,
    nextTime: parseOutcomeTime(match[3]?.trim()),
  };
}

function normalizeOutcomeType(value: string): OutcomeType | null {
  if (value === "adjourned" || value === "adjourn") return "adjourned";
  if (value === "disposed" || value === "closed") return "disposed";
  if (value === "reserved" || value === "order_reserved") return "order_reserved";
  if (value === "cause-list" || value === "causelist" || value === "awaiting") {
    return "awaiting_cause_list";
  }
  if (value === "pending") return "next_date_pending";
  if (value === "none" || value === "no_proceedings") return "no_proceedings";
  return null;
}

function getNextDateStatus(outcomeType: OutcomeType, nextValue: string | null): NextDateStatus {
  const lowered = nextValue?.toLowerCase() ?? "";
  if (lowered.includes("pending")) return "pending";
  if (lowered.includes("not given")) return "not_given";
  if (lowered.includes("cause")) return "awaiting_cause_list";
  if (nextValue) return "entered";
  if (outcomeType === "awaiting_cause_list") return "awaiting_cause_list";
  if (outcomeType === "disposed" || outcomeType === "order_reserved") return "not_required";
  if (outcomeType === "next_date_pending") return "pending";
  return "not_required";
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

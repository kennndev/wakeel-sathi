import "server-only";
import { createConfirmedHearing } from "../hearings/create-confirmed-hearing";
import { writeActivityLog } from "../security/audit";
import { formatDateForWhatsapp, normalizeDate, normalizeTime } from "../utils/date";
import { sendWhatsappText } from "../whatsapp/send-whatsapp-message";
import { getSupabaseAdmin } from "../db/supabase-admin";

export type AppearanceStatus = "appeared" | "not_appeared" | "proxy_appeared" | "unknown";
export type OutcomeType =
  | "adjourned"
  | "order_reserved"
  | "disposed"
  | "awaiting_cause_list"
  | "no_proceedings"
  | "next_date_pending"
  | "other";
export type NextDateStatus =
  | "entered"
  | "pending"
  | "not_given"
  | "awaiting_cause_list"
  | "not_required";

type CreateHearingOutcomeInput = {
  organizationId: string;
  hearingId: string;
  matterId: string;
  updatedBy?: string | null;
  appearanceStatus: AppearanceStatus;
  outcomeType: OutcomeType;
  outcomeSummary?: string | null;
  nextDateStatus: NextDateStatus;
  nextHearingId?: string | null;
};

type AddNextDateInput = {
  organizationId: string;
  sourceHearingId: string;
  matterId: string;
  courtId?: string | null;
  hearingDate: string;
  startTime?: string | null;
  endTime?: string | null;
  seniorLawyerId?: string | null;
  appearingLawyerId?: string | null;
  createdBy?: string | null;
  purpose?: string | null;
};

type HearingRow = {
  id: string;
  organization_id: string;
  matter_id: string;
  court_id: string | null;
  hearing_date: string;
  start_time: string | null;
  senior_lawyer_id: string | null;
  appearing_lawyer_id: string | null;
  matters: { title: string } | { title: string }[] | null;
  courts: { name: string } | { name: string }[] | null;
};

export async function createHearingOutcome(input: CreateHearingOutcomeInput) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("hearing_outcomes")
    .upsert(
      {
        organization_id: input.organizationId,
        hearing_id: input.hearingId,
        matter_id: input.matterId,
        updated_by: input.updatedBy ?? null,
        appearance_status: input.appearanceStatus,
        outcome_type: input.outcomeType,
        outcome_summary: input.outcomeSummary ?? null,
        next_date_status: input.nextDateStatus,
        next_hearing_id: input.nextHearingId ?? null,
      },
      { onConflict: "hearing_id" },
    )
    .select("id")
    .single();

  if (error) throw new Error(`Failed to save hearing outcome: ${error.message}`);

  const hearingStatus = getHearingStatusForOutcome(input.outcomeType, input.nextDateStatus);
  await supabase
    .from("hearings")
    .update({
      status: hearingStatus,
      outcome_summary: input.outcomeSummary ?? null,
      next_hearing_id: input.nextHearingId ?? null,
    })
    .eq("id", input.hearingId);

  await writeActivityLog({
    organizationId: input.organizationId,
    actorUserId: input.updatedBy ?? null,
    action: "hearing.outcome_saved",
    entityType: "hearing_outcome",
    entityId: data.id as string,
    metadata: {
      hearingId: input.hearingId,
      matterId: input.matterId,
      outcomeType: input.outcomeType,
      nextDateStatus: input.nextDateStatus,
      nextHearingId: input.nextHearingId ?? null,
    },
  });

  return data.id as string;
}

export async function markNextDatePending(input: {
  organizationId: string;
  hearingId: string;
  matterId: string;
  updatedBy?: string | null;
  outcomeSummary?: string | null;
}) {
  return createHearingOutcome({
    organizationId: input.organizationId,
    hearingId: input.hearingId,
    matterId: input.matterId,
    updatedBy: input.updatedBy,
    appearanceStatus: "appeared",
    outcomeType: "next_date_pending",
    outcomeSummary: input.outcomeSummary ?? "Next date not available yet.",
    nextDateStatus: "pending",
  });
}

export async function addNextDateFromOutcome(input: AddNextDateInput) {
  if (!input.seniorLawyerId) {
    throw new Error("Senior lawyer is required to create next hearing.");
  }

  const nextHearing = await createConfirmedHearing({
    organizationId: input.organizationId,
    matterId: input.matterId,
    courtId: input.courtId ?? null,
    hearingDate: input.hearingDate,
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
    seniorLawyerId: input.seniorLawyerId,
    appearingLawyerId: input.appearingLawyerId ?? null,
    createdBy: input.createdBy ?? null,
    purpose: input.purpose ?? "Next hearing",
  });

  if (!nextHearing.ok) {
    throw new Error(nextHearing.error);
  }

  await createHearingOutcome({
    organizationId: input.organizationId,
    hearingId: input.sourceHearingId,
    matterId: input.matterId,
    updatedBy: input.createdBy,
    appearanceStatus: "appeared",
    outcomeType: "adjourned",
    outcomeSummary: `Next date fixed for ${formatDateForWhatsapp(input.hearingDate)}.`,
    nextDateStatus: "entered",
    nextHearingId: nextHearing.hearingId,
  });

  return nextHearing.hearingId;
}

export async function getMissingNextDateQueue(organizationId?: string | null) {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("hearing_outcomes")
    .select(
      "id,organization_id,hearing_id,matter_id,outcome_type,outcome_summary,next_date_status,created_at,hearings!hearing_outcomes_hearing_id_fkey(hearing_date,start_time,senior_lawyer_id,appearing_lawyer_id,matters(title),courts(name),senior:senior_lawyer_id(full_name,phone),appearing:appearing_lawyer_id(full_name,phone))",
    )
    .in("next_date_status", ["pending", "not_given", "awaiting_cause_list"])
    .order("created_at", { ascending: true });

  if (organizationId) {
    query = query.eq("organization_id", organizationId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load missing next-date queue: ${error.message}`);
  return data ?? [];
}

export async function sendMissingNextDateReminder(input: {
  organizationId: string;
  outcomeId: string;
}) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("hearing_outcomes")
    .select(
      "id,organization_id,hearing_id,matter_id,hearings!hearing_outcomes_hearing_id_fkey(hearing_date,appearing_lawyer_id,matters(title),courts(name),appearing:appearing_lawyer_id(full_name,phone))",
    )
    .eq("id", input.outcomeId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load missing next-date item: ${error.message}`);
  if (!data) throw new Error("Missing next-date item not found.");

  const row = data as unknown as {
    id: string;
    hearing_id: string;
    hearings: HearingRow | HearingRow[] | null;
  };
  const hearing = single(row.hearings);
  const appearingLawyerId = hearing?.appearing_lawyer_id;
  const phone = appearingLawyerId
    ? await getPhoneForUser(input.organizationId, appearingLawyerId)
    : null;

  if (!phone) throw new Error("Assigned junior has no WhatsApp/phone number.");

  await sendWhatsappText({
    organizationId: input.organizationId,
    to: phone,
    body:
      `Next date needed.\n\n` +
      `Matter: ${single(hearing?.matters ?? null)?.title ?? "Unknown"}\n` +
      `Court: ${single(hearing?.courts ?? null)?.name ?? "Not specified"}\n` +
      `Last hearing: ${hearing?.hearing_date ?? "Unknown"}\n\n` +
      `Reply: NEXTDATE ${single(hearing?.matters ?? null)?.title ?? "matter"} DD-MM-YYYY time`,
    entityType: "hearing_outcome",
    entityId: input.outcomeId,
    recipientUserId: appearingLawyerId,
  });

  await writeActivityLog({
    organizationId: input.organizationId,
    action: "missing_next_date.junior_asked",
    entityType: "hearing_outcome",
    entityId: input.outcomeId,
    metadata: { hearingId: row.hearing_id },
  });
}

export async function detectMissingOutcomesAndAskJuniors() {
  const supabase = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("hearings")
    .select(
      "id,organization_id,matter_id,court_id,hearing_date,start_time,senior_lawyer_id,appearing_lawyer_id,matters(title),courts(name)",
    )
    .lte("hearing_date", today)
    .eq("outcome_required", true)
    .is("deleted_at", null)
    .in("status", ["scheduled", "attended", "pending_update"])
    .limit(50);

  if (error) throw new Error(`Failed to detect missing outcomes: ${error.message}`);

  const candidateHearings = (data as unknown as HearingRow[] | null) ?? [];
  const existingOutcomeHearingIds = await loadExistingOutcomeHearingIds(
    candidateHearings.map((hearing) => hearing.id),
  );
  const hearings = candidateHearings.filter(
    (hearing) => !existingOutcomeHearingIds.has(hearing.id),
  );

  let created = 0;
  let asked = 0;
  let failed = 0;

  for (const hearing of hearings) {
    try {
      const outcomeId = await createHearingOutcome({
        organizationId: hearing.organization_id,
        hearingId: hearing.id,
        matterId: hearing.matter_id,
        appearanceStatus: "unknown",
        outcomeType: "next_date_pending",
        outcomeSummary: "Outcome missing after hearing date. Auto-added to Missing Next-Date queue.",
        nextDateStatus: "pending",
      });

      created += 1;

      try {
        await sendMissingNextDateReminder({
          organizationId: hearing.organization_id,
          outcomeId,
        });
        asked += 1;
      } catch {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { scanned: hearings.length, created, asked, failed };
}

async function loadExistingOutcomeHearingIds(hearingIds: string[]) {
  const existingIds = new Set<string>();
  if (!hearingIds.length) return existingIds;

  const { data, error } = await getSupabaseAdmin()
    .from("hearing_outcomes")
    .select("hearing_id")
    .in("hearing_id", hearingIds);

  if (error) throw new Error(`Failed to load existing outcomes: ${error.message}`);

  for (const row of (data as Array<{ hearing_id: string }> | null) ?? []) {
    existingIds.add(row.hearing_id);
  }

  return existingIds;
}

export async function findLatestHearingForMatterReference(input: {
  organizationId: string;
  reference: string;
}) {
  const matter = await findMatterByReference(input);
  if (!matter) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("hearings")
    .select(
      "id,organization_id,matter_id,court_id,hearing_date,start_time,senior_lawyer_id,appearing_lawyer_id,matters(title),courts(name)",
    )
    .eq("organization_id", input.organizationId)
    .eq("matter_id", matter.id)
    .is("deleted_at", null)
    .order("hearing_date", { ascending: false })
    .order("start_time", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to find latest hearing: ${error.message}`);
  return data as HearingRow | null;
}

export async function findOpenOutcomeForMatterReference(input: {
  organizationId: string;
  reference: string;
}) {
  const matter = await findMatterByReference(input);
  if (!matter) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("hearing_outcomes")
    .select(
      "id,organization_id,hearing_id,matter_id,hearings!hearing_outcomes_hearing_id_fkey(id,organization_id,matter_id,court_id,hearing_date,start_time,senior_lawyer_id,appearing_lawyer_id,matters(title),courts(name))",
    )
    .eq("organization_id", input.organizationId)
    .eq("matter_id", matter.id)
    .in("next_date_status", ["pending", "not_given", "awaiting_cause_list"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to find missing next-date item: ${error.message}`);
  if (!data) return null;

  const row = data as unknown as { id: string; hearings: HearingRow | HearingRow[] | null };
  return {
    outcomeId: row.id,
    hearing: single(row.hearings),
  };
}

export function parseOutcomeDate(value: string): string | null {
  return normalizeDate(value);
}

export function parseOutcomeTime(value?: string | null): string | null {
  return normalizeTime(value);
}

async function findMatterByReference(input: { organizationId: string; reference: string }) {
  const ref = input.reference.trim();
  const { data, error } = await getSupabaseAdmin()
    .from("matters")
    .select("id,title,case_number")
    .eq("organization_id", input.organizationId)
    .is("deleted_at", null)
    .or(`case_number.ilike.%${escapeLike(ref)}%,title.ilike.%${escapeLike(ref)}%`)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve matter reference: ${error.message}`);
  return data as { id: string; title: string; case_number: string | null } | null;
}

async function getPhoneForUser(organizationId: string, userId: string) {
  const supabase = getSupabaseAdmin();
  const { data: contact } = await supabase
    .from("whatsapp_contacts")
    .select("phone")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (contact?.phone) return contact.phone as string;

  const { data: user } = await supabase
    .from("users")
    .select("phone")
    .eq("id", userId)
    .maybeSingle();

  return (user?.phone as string | undefined) ?? null;
}

function getHearingStatusForOutcome(outcomeType: OutcomeType, nextDateStatus: NextDateStatus) {
  if (outcomeType === "disposed") return "completed";
  if (nextDateStatus === "pending" || nextDateStatus === "not_given") return "pending_update";
  if (outcomeType === "adjourned") return "adjourned";
  return "attended";
}

function escapeLike(value: string) {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_").replaceAll(",", "\\,");
}

function single<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

import "server-only";
import { checkAvailability } from "../availability/check-availability";
import { getSupabaseAdmin } from "../db/supabase-admin";
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
  const supabaseAdmin = getSupabaseAdmin();
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
    entityId: data.id as string,
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

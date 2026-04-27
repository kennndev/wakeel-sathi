import "server-only";
import { getSupabaseAdmin } from "../db/supabase-admin";
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
  const supabaseAdmin = getSupabaseAdmin();

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

  const userIds = [input.seniorLawyerId, input.appearingLawyerId].filter(
    (userId): userId is string => Boolean(userId),
  );

  const { data: availabilityBlocks, error: blocksError } = await supabaseAdmin
    .from("user_availability_blocks")
    .select("id,user_id,date,start_time,end_time,reason,block_type")
    .eq("organization_id", input.organizationId)
    .eq("date", input.date)
    .in("user_id", userIds);

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

    if (
      input.appearingLawyerId &&
      block.user_id === input.appearingLawyerId &&
      (fullDayBlock || overlaps)
    ) {
      conflicts.push({
        type: "appearing_unavailable",
        severity: "hard",
        reason: `Appearing lawyer is unavailable${block.reason ? `: ${block.reason}` : ""}.`,
        relatedEntityId: block.id,
      });
    }
  }

  for (const hearing of (hearings ?? []) as HearingRow[]) {
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
          reason:
            "Senior lawyer already has at least one hearing on this date. Time is not exact, so confirm manually.",
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
          reason:
            "Appearing lawyer already has another hearing on this date. Time is not exact, so confirm manually.",
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

  const hardConflict = conflicts.find((conflict) => conflict.severity === "hard");
  if (hardConflict) {
    return {
      status: "hard_conflict",
      isAvailable: false,
      reason: hardConflict.reason,
      conflicts,
    };
  }

  if (conflicts.some((conflict) => conflict.severity === "soft")) {
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

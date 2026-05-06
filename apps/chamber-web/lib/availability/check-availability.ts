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

type CourtRow = {
  id: string;
  name: string;
  city: string | null;
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

  const hearingRows = (hearings ?? []) as HearingRow[];
  const courtMap = await loadCourtMap([
    input.courtId,
    ...hearingRows.map((hearing) => hearing.court_id),
  ]);
  const proposedCourt = input.courtId ? courtMap.get(input.courtId) ?? null : null;
  const proposedCity = getCourtCity(proposedCourt);

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

  for (const hearing of hearingRows) {
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
        const existingCourt = courtMap.get(hearing.court_id) ?? null;
        const existingCity = getCourtCity(existingCourt);

        if (proposedCity && existingCity && proposedCity !== existingCity) {
          conflicts.push({
            type: "same_day_different_city",
            severity: "hard",
            reason: `There is already a hearing in ${formatCity(existingCity)} on this date. A same-day hearing in ${formatCity(proposedCity)} is not feasible.`,
            relatedEntityId: hearing.id,
          });
          continue;
        }

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

async function loadCourtMap(courtIds: Array<string | null | undefined>): Promise<Map<string, CourtRow>> {
  const ids = Array.from(new Set(courtIds.filter((courtId): courtId is string => Boolean(courtId))));
  if (!ids.length) return new Map();

  const { data, error } = await getSupabaseAdmin()
    .from("courts")
    .select("id,name,city")
    .in("id", ids);

  if (error) {
    throw new Error(`Failed to load court cities: ${error.message}`);
  }

  return new Map(((data as CourtRow[] | null) ?? []).map((court) => [court.id, court]));
}

function getCourtCity(court: CourtRow | null): string | null {
  return normalizeCity(court?.city) ?? inferCityFromCourtName(court?.name);
}

function inferCityFromCourtName(name?: string | null): string | null {
  if (!name) return null;
  const normalized = name.toLowerCase();
  const knownCities = [
    "lahore",
    "multan",
    "islamabad",
    "rawalpindi",
    "karachi",
    "peshawar",
    "quetta",
    "faisalabad",
    "bahawalpur",
    "sahiwal",
    "gujranwala",
    "sargodha",
    "sialkot",
    "hyderabad",
    "sukkur",
  ];

  return knownCities.find((city) => normalized.includes(city)) ?? null;
}

function normalizeCity(city?: string | null): string | null {
  const normalized = city?.trim().toLowerCase();
  return normalized || null;
}

function formatCity(city: string): string {
  return city
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

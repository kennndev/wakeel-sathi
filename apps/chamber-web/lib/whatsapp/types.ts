export type AvailabilityStatus = "available" | "hard_conflict" | "soft_warning";

export type CheckAvailabilityInput = {
  organizationId: string;
  seniorLawyerId: string;
  appearingLawyerId?: string | null;
  date: string;
  startTime?: string | null;
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

type ParsedCommandBase = {
  date: string;
  startTime?: string | null;
  endTime?: string | null;
  seniorLawyerName?: string | null;
  matterText?: string | null;
  courtText?: string | null;
  rawText: string;
};

export type ParsedInboundCommand =
  | (ParsedCommandBase & {
      ok: true;
      command: "check_slot";
    })
  | (ParsedCommandBase & {
      ok: true;
      command: "save_date";
    })
  | {
      ok: false;
      error: string;
      rawText: string;
    };

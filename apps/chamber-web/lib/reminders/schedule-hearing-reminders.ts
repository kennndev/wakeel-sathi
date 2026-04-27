import "server-only";
import { getSupabaseAdmin } from "../db/supabase-admin";

type ScheduleHearingRemindersInput = {
  organizationId: string;
  hearingId: string;
  matterTitle: string;
  courtName?: string | null;
  hearingDate: string;
  startTime?: string | null;
  seniorLawyerId?: string | null;
  appearingLawyerId?: string | null;
  createdBy?: string | null;
};

export async function scheduleHearingReminders(input: ScheduleHearingRemindersInput) {
  const assignedUserIds = Array.from(
    new Set([input.seniorLawyerId, input.appearingLawyerId].filter(Boolean)),
  ) as string[];

  if (!assignedUserIds.length) return;

  const remindAt = getOneDayBeforeReminderTime(input.hearingDate);
  const supabase = getSupabaseAdmin();

  const { error } = await supabase.from("reminders").insert(
    assignedUserIds.map((assignedTo) => ({
      organization_id: input.organizationId,
      entity_type: "hearing",
      entity_id: input.hearingId,
      reminder_type: "hearing_one_day_before",
      title: `Hearing tomorrow: ${input.matterTitle}`,
      message:
        `Reminder: hearing tomorrow.\n\n` +
        `Matter: ${input.matterTitle}\n` +
        `Court: ${input.courtName ?? "Not specified"}\n` +
        `Date: ${input.hearingDate}\n` +
        `Time: ${input.startTime ?? "Not specified"}`,
      remind_at: remindAt,
      assigned_to: assignedTo,
      status: "pending",
      preferred_channel: "whatsapp",
      created_by: input.createdBy ?? null,
    })),
  );

  if (error) {
    throw new Error(`Failed to schedule hearing reminders: ${error.message}`);
  }
}

function getOneDayBeforeReminderTime(hearingDate: string): string {
  const [year, month, day] = hearingDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 4, 0, 0));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString();
}

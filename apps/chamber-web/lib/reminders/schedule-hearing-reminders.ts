import "server-only";
import { getSupabaseAdmin } from "../db/supabase-admin";
import { sendWhatsappText } from "../whatsapp/send-whatsapp-message";

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

  const { data, error } = await supabase
    .from("reminders")
    .insert(
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
    )
    .select("id,organization_id,title,message,assigned_to");

  if (error) {
    throw new Error(`Failed to schedule hearing reminders: ${error.message}`);
  }

  if (shouldSendCatchUpReminder(input.hearingDate, remindAt)) {
    await sendCatchUpReminders(
      (data as Array<{
        id: string;
        organization_id: string;
        title: string;
        message: string | null;
        assigned_to: string | null;
      }> | null) ?? [],
    );
  }
}

function getOneDayBeforeReminderTime(hearingDate: string): string {
  const [year, month, day] = hearingDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 4, 0, 0));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString();
}

function shouldSendCatchUpReminder(hearingDate: string, remindAt: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return hearingDate >= today && new Date(remindAt).getTime() <= Date.now();
}

async function sendCatchUpReminders(
  reminders: Array<{
    id: string;
    organization_id: string;
    title: string;
    message: string | null;
    assigned_to: string | null;
  }>,
) {
  for (const reminder of reminders) {
    const phone = reminder.assigned_to
      ? await getPhoneForUser({
          organizationId: reminder.organization_id,
          userId: reminder.assigned_to,
        })
      : null;

    if (!reminder.assigned_to || !phone) {
      await markReminder(reminder.id, "failed");
      continue;
    }

    const result = await sendWhatsappText({
      organizationId: reminder.organization_id,
      to: phone,
      body: reminder.message ?? reminder.title,
      entityType: "reminder",
      entityId: reminder.id,
      recipientUserId: reminder.assigned_to,
    });

    await markReminder(reminder.id, result.ok ? "sent" : "failed");
  }
}

async function getPhoneForUser(input: {
  organizationId: string;
  userId: string;
}): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data: contact } = await supabase
    .from("whatsapp_contacts")
    .select("phone")
    .eq("organization_id", input.organizationId)
    .eq("user_id", input.userId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (contact?.phone) return contact.phone as string;

  const { data: user } = await supabase
    .from("users")
    .select("phone")
    .eq("id", input.userId)
    .maybeSingle();

  const phone = (user?.phone as string | undefined) ?? null;
  if (phone) {
    await saveWhatsappContact({
      organizationId: input.organizationId,
      userId: input.userId,
      phone,
    });
  }

  return phone;
}

async function markReminder(reminderId: string, status: "sent" | "failed") {
  await getSupabaseAdmin().from("reminders").update({ status }).eq("id", reminderId);
}

async function saveWhatsappContact(input: {
  organizationId: string;
  userId: string;
  phone: string;
}) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  await supabase.from("whatsapp_contacts").upsert(
    {
      organization_id: input.organizationId,
      user_id: input.userId,
      phone: input.phone,
      is_active: true,
      updated_at: now,
    },
    { onConflict: "organization_id,phone" },
  );

  await supabase.from("whatsapp_opt_ins").upsert(
    {
      organization_id: input.organizationId,
      user_id: input.userId,
      phone: input.phone,
      opt_in_status: "opted_in",
      opted_in_at: now,
      source: "reminder_delivery_backfill",
      updated_at: now,
    },
    { onConflict: "organization_id,user_id,phone" },
  );
}

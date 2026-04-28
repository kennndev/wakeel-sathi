import "server-only";
import { getSupabaseAdmin } from "../db/supabase-admin";
import { detectMissingOutcomesAndAskJuniors } from "../outcomes/hearing-outcomes";
import { sendWhatsappText } from "../whatsapp/send-whatsapp-message";

type ReminderRow = {
  id: string;
  organization_id: string;
  entity_type: string;
  entity_id: string;
  reminder_type: string;
  title: string;
  message: string | null;
  assigned_to: string | null;
};

type UserRow = {
  id: string;
  full_name: string;
  phone: string | null;
};

type ContactRow = {
  user_id: string;
  phone: string;
};

export async function sendDueWhatsappReminders() {
  const missingOutcomes = await detectMissingOutcomesAndAskJuniors();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("reminders")
    .select("id,organization_id,entity_type,entity_id,reminder_type,title,message,assigned_to")
    .eq("status", "pending")
    .eq("preferred_channel", "whatsapp")
    .lte("remind_at", new Date().toISOString())
    .limit(50);

  if (error) {
    throw new Error(`Failed to load due reminders: ${error.message}`);
  }

  const reminders = (data as ReminderRow[] | null) ?? [];
  if (!reminders.length) {
    return { processed: 0, sent: 0, failed: 0, missingOutcomes };
  }

  const userIds = Array.from(
    new Set(reminders.map((reminder) => reminder.assigned_to).filter(Boolean)),
  ) as string[];

  const [usersById, contactsByUserId] = await Promise.all([
    loadUsersById(userIds),
    loadContactsByUserId(userIds),
  ]);

  let sent = 0;
  let failed = 0;

  for (const reminder of reminders) {
    if (!(await isReminderStillValid(reminder))) {
      await markReminder(reminder.id, "dismissed");
      continue;
    }

    const userId = reminder.assigned_to;
    const phone = userId
      ? contactsByUserId.get(userId)?.phone ?? usersById.get(userId)?.phone
      : null;

    if (!userId || !phone) {
      failed += 1;
      await markReminder(reminder.id, "failed");
      continue;
    }

    const result = await sendWhatsappText({
      organizationId: reminder.organization_id,
      to: phone,
      body: reminder.message ?? reminder.title,
      entityType: "reminder",
      entityId: reminder.id,
      recipientUserId: userId,
    });

    if (result.ok) {
      sent += 1;
      await markReminder(reminder.id, "sent");
    } else {
      failed += 1;
      await markReminder(reminder.id, "failed");
    }
  }

  return { processed: reminders.length, sent, failed, missingOutcomes };
}

async function loadUsersById(userIds: string[]) {
  const usersById = new Map<string, UserRow>();
  if (!userIds.length) return usersById;

  const { data, error } = await getSupabaseAdmin()
    .from("users")
    .select("id,full_name,phone")
    .in("id", userIds);

  if (error) throw new Error(`Failed to load reminder users: ${error.message}`);

  for (const user of (data as UserRow[] | null) ?? []) {
    usersById.set(user.id, user);
  }

  return usersById;
}

async function loadContactsByUserId(userIds: string[]) {
  const contactsByUserId = new Map<string, ContactRow>();
  if (!userIds.length) return contactsByUserId;

  const { data, error } = await getSupabaseAdmin()
    .from("whatsapp_contacts")
    .select("user_id,phone")
    .in("user_id", userIds)
    .eq("is_active", true);

  if (error) throw new Error(`Failed to load reminder WhatsApp contacts: ${error.message}`);

  for (const contact of (data as ContactRow[] | null) ?? []) {
    contactsByUserId.set(contact.user_id, contact);
  }

  return contactsByUserId;
}

async function isReminderStillValid(reminder: ReminderRow) {
  if (reminder.entity_type !== "hearing" || reminder.reminder_type !== "hearing_one_day_before") {
    return true;
  }

  const { data, error } = await getSupabaseAdmin()
    .from("hearings")
    .select("status,hearing_date,deleted_at")
    .eq("id", reminder.entity_id)
    .maybeSingle();

  if (error) throw new Error(`Failed to validate hearing reminder: ${error.message}`);
  if (!data || data.deleted_at) return false;

  const today = new Date().toISOString().slice(0, 10);
  return data.status === "scheduled" && data.hearing_date >= today;
}

async function markReminder(reminderId: string, status: "sent" | "failed" | "dismissed") {
  await getSupabaseAdmin()
    .from("reminders")
    .update({ status })
    .eq("id", reminderId);
}

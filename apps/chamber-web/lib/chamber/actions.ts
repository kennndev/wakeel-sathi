"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "../db/supabase-admin";

const fallbackOrganizationId = "11111111-1111-1111-1111-111111111111";
const fallbackSeniorId = "22222222-2222-2222-2222-222222222222";
const fallbackJuniorId = "33333333-3333-3333-3333-333333333333";

export async function createChamberSetup(formData: FormData) {
  const organizationName = getRequiredString(formData, "organizationName");
  const seniorName = getRequiredString(formData, "seniorName");
  const seniorPhone = normalizePhone(getRequiredString(formData, "seniorPhone"));
  const juniorName = getRequiredString(formData, "juniorName");
  const juniorPhone = normalizePhone(getRequiredString(formData, "juniorPhone"));

  const organizationId =
    process.env.DEFAULT_ORGANIZATION_ID?.trim() || fallbackOrganizationId;
  const supabase = getSupabaseAdmin();

  const { error: organizationError } = await supabase.from("organizations").upsert(
    {
      id: organizationId,
      name: organizationName,
      type: "chamber",
    },
    { onConflict: "id" },
  );

  if (organizationError) {
    throw new Error(`Failed to save chamber: ${organizationError.message}`);
  }

  const { error: usersError } = await supabase.from("users").upsert(
    [
      {
        id: fallbackSeniorId,
        full_name: seniorName,
        email: "senior@example.com",
        phone: seniorPhone,
      },
      {
        id: fallbackJuniorId,
        full_name: juniorName,
        email: "junior@example.com",
        phone: juniorPhone,
      },
    ],
    { onConflict: "id" },
  );

  if (usersError) {
    throw new Error(`Failed to save users: ${usersError.message}`);
  }

  const { error: membersError } = await supabase.from("organization_members").upsert(
    [
      {
        organization_id: organizationId,
        user_id: fallbackSeniorId,
        role: "senior_lawyer",
        status: "active",
      },
      {
        organization_id: organizationId,
        user_id: fallbackJuniorId,
        role: "junior_lawyer",
        status: "active",
      },
    ],
    { onConflict: "organization_id,user_id" },
  );

  if (membersError) {
    throw new Error(`Failed to save chamber members: ${membersError.message}`);
  }

  const { error: contactsError } = await supabase.from("whatsapp_contacts").upsert(
    {
      organization_id: organizationId,
      user_id: fallbackJuniorId,
      phone: juniorPhone,
      is_active: true,
    },
    { onConflict: "organization_id,phone" },
  );

  if (contactsError) {
    throw new Error(`Failed to save WhatsApp contact: ${contactsError.message}`);
  }

  const { error: optInError } = await supabase.from("whatsapp_opt_ins").upsert(
    {
      organization_id: organizationId,
      user_id: fallbackJuniorId,
      phone: juniorPhone,
      opt_in_status: "opted_in",
      opted_in_at: new Date().toISOString(),
      source: "dashboard_setup",
    },
    { onConflict: "organization_id,user_id,phone" },
  );

  if (optInError) {
    throw new Error(`Failed to save WhatsApp opt-in: ${optInError.message}`);
  }

  revalidatePath("/");
  revalidatePath("/setup");
  revalidatePath("/diary");
  redirect("/diary");
}

function getRequiredString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }

  return value.trim();
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) throw new Error("Phone number is required");
  return `+${digits}`;
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "../db/supabase-admin";

export async function createChamberSetup(formData: FormData) {
  const organizationName = getRequiredString(formData, "organizationName");
  const seniorName = getRequiredString(formData, "seniorName");
  const seniorPhone = normalizePhone(getRequiredString(formData, "seniorPhone"));
  const juniorName = getRequiredString(formData, "juniorName");
  const juniorPhone = normalizePhone(getRequiredString(formData, "juniorPhone"));

  const supabase = getSupabaseAdmin();
  const organizationId = await getOrCreateOrganizationId(organizationName);
  const seniorId = await getOrCreateUserId({
    fullName: seniorName,
    email: "senior@example.com",
    phone: seniorPhone,
  });
  const juniorId = await getOrCreateUserId({
    fullName: juniorName,
    email: "junior@example.com",
    phone: juniorPhone,
  });

  const { error: membersError } = await supabase.from("organization_members").upsert(
    [
      {
        organization_id: organizationId,
        user_id: seniorId,
        role: "senior_lawyer",
        status: "active",
      },
      {
        organization_id: organizationId,
        user_id: juniorId,
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
      user_id: juniorId,
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
      user_id: juniorId,
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

async function getOrCreateOrganizationId(name: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: findError } = await supabase
    .from("organizations")
    .select("id")
    .ilike("name", name)
    .limit(1)
    .maybeSingle();

  if (findError) {
    throw new Error(`Failed to find chamber: ${findError.message}`);
  }

  if (existing?.id) return existing.id as string;

  const { data: created, error: createError } = await supabase
    .from("organizations")
    .insert({
      name,
      type: "chamber",
    })
    .select("id")
    .single();

  if (createError) {
    throw new Error(`Failed to create chamber: ${createError.message}`);
  }

  return created.id as string;
}

async function getOrCreateUserId(input: {
  fullName: string;
  email: string;
  phone: string;
}): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: findError } = await supabase
    .from("users")
    .select("id")
    .eq("phone", input.phone)
    .limit(1)
    .maybeSingle();

  if (findError) {
    throw new Error(`Failed to find user: ${findError.message}`);
  }

  if (existing?.id) {
    const { error: updateError } = await supabase
      .from("users")
      .update({
        full_name: input.fullName,
        email: input.email,
        phone: input.phone,
      })
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(`Failed to update user: ${updateError.message}`);
    }

    return existing.id as string;
  }

  const { data: created, error: createError } = await supabase
    .from("users")
    .insert({
      full_name: input.fullName,
      email: input.email,
      phone: input.phone,
    })
    .select("id")
    .single();

  if (createError) {
    throw new Error(`Failed to create user: ${createError.message}`);
  }

  return created.id as string;
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

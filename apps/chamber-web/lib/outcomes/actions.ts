"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addNextDateFromOutcome,
  createHearingOutcome,
  sendMissingNextDateReminder,
  type AppearanceStatus,
  type NextDateStatus,
  type OutcomeType,
} from "./hearing-outcomes";
import { getSupabaseAdmin } from "../db/supabase-admin";

export async function saveOutcomeAction(formData: FormData) {
  const organizationId = required(formData, "organizationId");
  const hearingId = required(formData, "hearingId");
  const matterId = required(formData, "matterId");
  const appearanceStatus = required(formData, "appearanceStatus") as AppearanceStatus;
  const outcomeType = required(formData, "outcomeType") as OutcomeType;
  const nextDateStatus = required(formData, "nextDateStatus") as NextDateStatus;
  const outcomeSummary = optional(formData, "outcomeSummary");
  const nextDate = optional(formData, "nextDate");
  const nextTime = optional(formData, "nextTime");

  if (nextDateStatus === "entered" && nextDate) {
    const hearing = await loadHearingForNextDate(hearingId);
    await addNextDateFromOutcome({
      organizationId,
      sourceHearingId: hearingId,
      matterId,
      courtId: hearing.court_id,
      hearingDate: nextDate,
      startTime: nextTime || null,
      seniorLawyerId: hearing.senior_lawyer_id,
      appearingLawyerId: hearing.appearing_lawyer_id,
      createdBy: null,
      purpose: optional(formData, "nextPurpose") || "Next hearing",
    });
  } else {
    await createHearingOutcome({
      organizationId,
      hearingId,
      matterId,
      appearanceStatus,
      outcomeType,
      outcomeSummary,
      nextDateStatus,
    });
  }

  revalidatePath("/diary");
  revalidatePath("/chamber/missing-next-dates");
  redirect("/chamber/missing-next-dates?notice=outcome-saved");
}

export async function askJuniorAction(formData: FormData) {
  const organizationId = required(formData, "organizationId");
  const outcomeId = required(formData, "outcomeId");

  await sendMissingNextDateReminder({ organizationId, outcomeId });

  revalidatePath("/chamber/missing-next-dates");
  redirect("/chamber/missing-next-dates?notice=junior-asked");
}

export async function markOutcomeAction(formData: FormData) {
  await createHearingOutcome({
    organizationId: required(formData, "organizationId"),
    hearingId: required(formData, "hearingId"),
    matterId: required(formData, "matterId"),
    appearanceStatus: "appeared",
    outcomeType: required(formData, "outcomeType") as OutcomeType,
    outcomeSummary: optional(formData, "outcomeSummary"),
    nextDateStatus: required(formData, "nextDateStatus") as NextDateStatus,
  });

  revalidatePath("/diary");
  revalidatePath("/chamber/missing-next-dates");
  redirect("/chamber/missing-next-dates?notice=queue-updated");
}

async function loadHearingForNextDate(hearingId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("hearings")
    .select("court_id,senior_lawyer_id,appearing_lawyer_id")
    .eq("id", hearingId)
    .single();

  if (error) throw new Error(`Failed to load hearing: ${error.message}`);

  return data as {
    court_id: string | null;
    senior_lawyer_id: string | null;
    appearing_lawyer_id: string | null;
  };
}

function required(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optional(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

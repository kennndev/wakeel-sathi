import "server-only";
import { checkAvailability } from "../availability/check-availability";
import { getSupabaseAdmin } from "../db/supabase-admin";
import { createConfirmedHearing } from "../hearings/create-confirmed-hearing";
import {
  addNextDateFromOutcome,
  createHearingOutcome,
  findLatestHearingForMatterReference,
  findOpenOutcomeForMatterReference,
  parseOutcomeDate,
  parseOutcomeTime,
  type NextDateStatus,
  type OutcomeType,
} from "../outcomes/hearing-outcomes";
import { formatDateForWhatsapp } from "../utils/date";
import { normalizeDate, normalizeTime } from "../utils/date";
import { parseInboundCommand } from "./parse-inbound-command";
import { sendWhatsappText } from "./send-whatsapp-message";

type HandleInboundMessageInput = {
  fromPhone: string;
  text: string;
};

type WhatsappContactRow = {
  organization_id: string;
  user_id: string;
};

type UserRow = {
  id: string;
  full_name: string;
  phone: string | null;
};

type MatterRow = {
  id: string;
  title: string;
  case_number: string | null;
  court_id: string | null;
};

type CourtRow = {
  id: string;
  name: string;
  city: string | null;
};

type ConversationFlow = "check_slot" | "save_date";
type ConversationStep = "date" | "time" | "matter" | "court" | "confirm_save";
type ConversationPayload = {
  date?: string;
  startTime?: string | null;
  matterText?: string | null;
  courtText?: string | null;
  seniorLawyerName?: string | null;
  checkedAvailable?: boolean;
};
type ConversationState = {
  flow: ConversationFlow;
  step: ConversationStep;
  payload_json: ConversationPayload;
};

export async function handleInboundWhatsappMessage(input: HandleInboundMessageInput) {
  const sender = await findWhatsappSender(input.fromPhone);

  if (!sender) {
    const fallbackOrganizationId = await getFallbackOrganizationId();

    await sendWhatsappText({
      organizationId: fallbackOrganizationId,
      to: input.fromPhone,
      body: "Your WhatsApp number is not registered with this chamber. Ask admin to add your number first.",
      entityType: "whatsapp_inbound",
      entityId: crypto.randomUUID(),
    });
    return;
  }

  const text = input.text.trim();
  if (isCancelCommand(text)) {
    await clearConversationState(sender.organization_id, sender.user_id, input.fromPhone);
    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body: "Okay, cancelled.",
      entityType: "whatsapp_inbound",
      entityId: sender.user_id,
      recipientUserId: sender.user_id,
    });
    return;
  }

  if (isOutcomeCommand(input.text)) {
    await handleOutcomeWhatsappCommand({
      organizationId: sender.organization_id,
      senderUserId: sender.user_id,
      fromPhone: input.fromPhone,
      text: input.text,
    });
    return;
  }

  if (isNextDateCommand(input.text)) {
    await handleNextDateWhatsappCommand({
      organizationId: sender.organization_id,
      senderUserId: sender.user_id,
      fromPhone: input.fromPhone,
      text: input.text,
    });
    return;
  }

  const existingState = await getConversationState({
    organizationId: sender.organization_id,
    userId: sender.user_id,
    phone: input.fromPhone,
  });

  if (existingState) {
    await handleGuidedConversation({
      organizationId: sender.organization_id,
      senderUserId: sender.user_id,
      fromPhone: input.fromPhone,
      text,
      state: existingState,
    });
    return;
  }

  const quickFlow = getQuickFlow(text);
  if (quickFlow) {
    await saveConversationState({
      organizationId: sender.organization_id,
      userId: sender.user_id,
      phone: input.fromPhone,
      flow: quickFlow,
      step: "date",
      payload: {},
    });
    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body:
        quickFlow === "check_slot"
          ? "Sure. What date should I check? Example: 12-05-2026"
          : "Okay. What date should I save? Example: 12-05-2026",
      entityType: "whatsapp_inbound",
      entityId: sender.user_id,
      recipientUserId: sender.user_id,
    });
    return;
  }

  const dateFirstCheck = parseDateFirstCheck(text);
  if (dateFirstCheck) {
    if (!dateFirstCheck.courtText) {
      await saveConversationState({
        organizationId: sender.organization_id,
        userId: sender.user_id,
        phone: input.fromPhone,
        flow: "check_slot",
        step: "court",
        payload: dateFirstCheck,
      });
      await sendWhatsappText({
        organizationId: sender.organization_id,
        to: input.fromPhone,
        body: "Which city or court? Example: Lahore High Court, Multan High Court, or just Lahore.",
        entityType: "whatsapp_inbound",
        entityId: sender.user_id,
        recipientUserId: sender.user_id,
      });
      return;
    }

    await runCheckOnlyFlow({
      organizationId: sender.organization_id,
      senderUserId: sender.user_id,
      fromPhone: input.fromPhone,
      payload: dateFirstCheck,
    });
    return;
  }

  const parsed = parseInboundCommand(input.text);

  if (!parsed.ok) {
    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body: "Send CHECK to check a date, or SAVE to add a date. I’ll ask the details one by one.",
      entityType: "whatsapp_inbound",
      entityId: sender.user_id,
      recipientUserId: sender.user_id,
    });
    return;
  }

  const senior = await resolveSeniorLawyer({
    organizationId: sender.organization_id,
    seniorLawyerName: parsed.seniorLawyerName,
  });

  if (!senior) {
    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body: "Senior lawyer not found. Use: senior: Full Name. Example: senior: Ali Khan",
      entityType: "whatsapp_inbound",
      entityId: sender.user_id,
      recipientUserId: sender.user_id,
    });
    return;
  }

  const matter = await resolveMatter({
    organizationId: sender.organization_id,
    matterText: parsed.matterText,
    createdBy: sender.user_id,
  });

  const court = await resolveCourt({
    organizationId: sender.organization_id,
    courtText: parsed.courtText,
  });

  if (parsed.command === "check_slot") {
    const availability = await checkAvailability({
      organizationId: sender.organization_id,
      seniorLawyerId: senior.id,
      appearingLawyerId: sender.user_id,
      date: parsed.date,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      courtId: court?.id ?? matter.court_id ?? null,
      matterId: matter.id,
    });

    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body: formatAvailabilityReply({
        date: parsed.date,
        time: parsed.startTime,
        seniorName: senior.full_name,
        matterTitle: matter.title,
        courtName: court?.name ?? "Not specified",
        availability,
      }),
      entityType: "matter",
      entityId: matter.id,
      recipientUserId: sender.user_id,
    });

    return;
  }

  const created = await createConfirmedHearing({
    organizationId: sender.organization_id,
    matterId: matter.id,
    courtId: court?.id ?? matter.court_id ?? null,
    hearingDate: parsed.date,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    seniorLawyerId: senior.id,
    appearingLawyerId: sender.user_id,
    createdBy: sender.user_id,
    purpose: "Next hearing confirmed from court",
  });

  if (!created.ok) {
    await sendWhatsappText({
      organizationId: sender.organization_id,
      to: input.fromPhone,
      body: `I did not save it. ${formatAvailabilityReply({
        date: parsed.date,
        time: parsed.startTime,
        seniorName: senior.full_name,
        matterTitle: matter.title,
        courtName: court?.name ?? "Not specified",
        availability: created.availability,
      })}`,
      entityType: "matter",
      entityId: matter.id,
      recipientUserId: sender.user_id,
    });
    return;
  }

  await sendWhatsappText({
    organizationId: sender.organization_id,
    to: input.fromPhone,
    body:
      `Saved.\n\n` +
      `${matter.title}\n` +
      `${formatDateForWhatsapp(parsed.date)}${parsed.startTime ? ` at ${parsed.startTime}` : ""}\n` +
      `${court?.name ?? "Court not specified"}\n` +
      `Senior: ${senior.full_name}\n` +
      (created.availability.status === "soft_warning"
        ? `\nNote: ${created.availability.reason}`
        : ""),
    entityType: "hearing",
    entityId: created.hearingId,
    recipientUserId: sender.user_id,
  });

  await notifySeniorOfConfirmedHearing({
    organizationId: sender.organization_id,
    senior,
    senderUserId: sender.user_id,
    hearingId: created.hearingId,
    matterTitle: matter.title,
    courtName: court?.name ?? "Not specified",
    hearingDate: parsed.date,
    startTime: parsed.startTime,
  });
}

async function handleGuidedConversation(input: {
  organizationId: string;
  senderUserId: string;
  fromPhone: string;
  text: string;
  state: ConversationState;
}) {
  const payload = input.state.payload_json ?? {};

  if (input.state.step === "date") {
    const date = parseLooseDate(input.text);
    if (!date) {
      await reply(input, "Please send the date like 12-05-2026.");
      return;
    }
    await saveConversationState({
      organizationId: input.organizationId,
      userId: input.senderUserId,
      phone: input.fromPhone,
      flow: input.state.flow,
      step: "time",
      payload: { ...payload, date },
    });
    await reply(input, "What time? Example: 10am. If no time, reply SKIP.");
    return;
  }

  if (input.state.step === "time") {
    const startTime = isSkip(input.text) ? null : parseLooseTime(input.text);
    if (!isSkip(input.text) && !startTime) {
      await reply(input, "Please send time like 10am, or reply SKIP.");
      return;
    }

    if (input.state.flow === "check_slot") {
      await saveConversationState({
        organizationId: input.organizationId,
        userId: input.senderUserId,
        phone: input.fromPhone,
        flow: input.state.flow,
        step: "court",
        payload: { ...payload, startTime },
      });
      await reply(
        input,
        "Which city or court? Example: Lahore High Court, Multan High Court, or just Lahore.",
      );
      return;
    }

    await saveConversationState({
      organizationId: input.organizationId,
      userId: input.senderUserId,
      phone: input.fromPhone,
      flow: input.state.flow,
      step: "matter",
      payload: { ...payload, startTime },
    });
    await reply(input, "Matter name or case number?");
    return;
  }

  if (input.state.step === "matter") {
    if (payload.courtText) {
      await runGuidedFlow({
        organizationId: input.organizationId,
        senderUserId: input.senderUserId,
        fromPhone: input.fromPhone,
        flow: input.state.flow,
        payload: { ...payload, matterText: input.text.trim() },
      });
      return;
    }

    await saveConversationState({
      organizationId: input.organizationId,
      userId: input.senderUserId,
      phone: input.fromPhone,
      flow: input.state.flow,
      step: "court",
      payload: { ...payload, matterText: input.text.trim() },
    });
    await reply(input, "Which court? If not needed, reply SKIP.");
    return;
  }

  if (input.state.step === "court") {
    if (input.state.flow === "check_slot") {
      await runCheckOnlyFlow({
        organizationId: input.organizationId,
        senderUserId: input.senderUserId,
        fromPhone: input.fromPhone,
        payload: {
          ...payload,
          courtText: isSkip(input.text) ? null : input.text.trim(),
        },
      });
      return;
    }

    await runGuidedFlow({
      organizationId: input.organizationId,
      senderUserId: input.senderUserId,
      fromPhone: input.fromPhone,
      flow: input.state.flow,
      payload: {
        ...payload,
        courtText: isSkip(input.text) ? null : input.text.trim(),
        seniorLawyerName: null,
      },
    });
    return;
  }
}

async function runGuidedFlow(input: {
  organizationId: string;
  senderUserId: string;
  fromPhone: string;
  flow: ConversationFlow;
  payload: ConversationPayload;
}) {
  if (!input.payload.date) {
    await reply(input, "Date is missing. Send CHECK or SAVE to start again.");
    return;
  }

  const senior = await resolveSeniorLawyer({
    organizationId: input.organizationId,
    seniorLawyerName: input.payload.seniorLawyerName,
  });

  if (!senior) {
    await reply(input, "I could not find that senior lawyer. Send CHECK or SAVE and try again.");
    await clearConversationState(input.organizationId, input.senderUserId, input.fromPhone);
    return;
  }

  const matter = await resolveMatter({
    organizationId: input.organizationId,
    matterText: input.payload.matterText,
    createdBy: input.senderUserId,
  });
  const court = await resolveCourt({
    organizationId: input.organizationId,
    courtText: input.payload.courtText,
  });

  const created = await createConfirmedHearing({
    organizationId: input.organizationId,
    matterId: matter.id,
    courtId: court?.id ?? matter.court_id ?? null,
    hearingDate: input.payload.date,
    startTime: input.payload.startTime,
    seniorLawyerId: senior.id,
    appearingLawyerId: input.senderUserId,
    createdBy: input.senderUserId,
    purpose: "Next hearing confirmed from court",
  });

  if (!created.ok) {
    await reply(input, `I did not save it. ${formatAvailabilityReply({
      date: input.payload.date,
      time: input.payload.startTime,
      seniorName: senior.full_name,
      matterTitle: matter.title,
      courtName: court?.name ?? "Court not specified",
      availability: created.availability,
    })}`);
    await clearConversationState(input.organizationId, input.senderUserId, input.fromPhone);
    return;
  }

  await reply(
    input,
    `Saved.\n\n${matter.title}\n${formatDateForWhatsapp(input.payload.date)}${
      input.payload.startTime ? ` at ${input.payload.startTime}` : ""
    }\n${court?.name ?? "Court not specified"}\nSenior: ${senior.full_name}`,
  );

  await notifySeniorOfConfirmedHearing({
    organizationId: input.organizationId,
    senior,
    senderUserId: input.senderUserId,
    hearingId: created.hearingId,
    matterTitle: matter.title,
    courtName: court?.name ?? "Court not specified",
    hearingDate: input.payload.date,
    startTime: input.payload.startTime,
  });

  await clearConversationState(input.organizationId, input.senderUserId, input.fromPhone);
}

async function runCheckOnlyFlow(input: {
  organizationId: string;
  senderUserId: string;
  fromPhone: string;
  payload: ConversationPayload;
}) {
  if (!input.payload.date) {
    await reply(input, "Date is missing. Send CHECK to start again.");
    return;
  }

  const senior = await resolveSeniorLawyer({
    organizationId: input.organizationId,
    seniorLawyerName: null,
  });

  if (!senior) {
    await reply(input, "I could not find the senior lawyer in setup.");
    await clearConversationState(input.organizationId, input.senderUserId, input.fromPhone);
    return;
  }

  const court = await resolveCourt({
    organizationId: input.organizationId,
    courtText: input.payload.courtText,
  });

  const availability = await checkAvailability({
    organizationId: input.organizationId,
    seniorLawyerId: senior.id,
    appearingLawyerId: input.senderUserId,
    date: input.payload.date,
    startTime: input.payload.startTime,
    endTime: null,
    courtId: court?.id ?? null,
    matterId: null,
  });

  if (!availability.isAvailable) {
    await reply(
      input,
      formatQuickAvailabilityReply({
        date: input.payload.date,
        time: input.payload.startTime,
        availability,
      }),
    );
    await clearConversationState(input.organizationId, input.senderUserId, input.fromPhone);
    return;
  }

  await saveConversationState({
    organizationId: input.organizationId,
    userId: input.senderUserId,
    phone: input.fromPhone,
    flow: "save_date",
    step: "matter",
    payload: {
      date: input.payload.date,
      startTime: input.payload.startTime,
      courtText: input.payload.courtText ?? null,
      checkedAvailable: true,
    },
  });

  await reply(
    input,
    `${formatQuickAvailabilityReply({
      date: input.payload.date,
      time: input.payload.startTime,
      availability,
    })}\n\nIf you want to save it, send the matter name or case number now. Otherwise send CANCEL.`,
  );
}

async function findWhatsappSender(phone: string): Promise<WhatsappContactRow | null> {
  const normalized = normalizeWhatsappPhone(phone);
  const supabaseAdmin = getSupabaseAdmin();

  const { data, error } = await supabaseAdmin
    .from("whatsapp_contacts")
    .select("organization_id,user_id")
    .eq("phone", normalized)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve WhatsApp sender: ${error.message}`);

  return data as WhatsappContactRow | null;
}

async function getFallbackOrganizationId(): Promise<string> {
  const configured = process.env.DEFAULT_ORGANIZATION_ID?.trim();
  if (configured) return configured;

  const { data, error } = await getSupabaseAdmin()
    .from("organizations")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to resolve fallback organization: ${error.message}`);
  if (data?.id) return data.id as string;

  throw new Error("No chamber exists. Create a chamber in /setup first.");
}

async function resolveSeniorLawyer(input: {
  organizationId: string;
  seniorLawyerName?: string | null;
}): Promise<UserRow | null> {
  const supabaseAdmin = getSupabaseAdmin();
  const query = supabaseAdmin
    .from("organization_members")
    .select("users(id,full_name,phone)")
    .eq("organization_id", input.organizationId)
    .eq("role", "senior_lawyer")
    .eq("status", "active")
    .limit(1);

  if (input.seniorLawyerName) {
    query.ilike("users.full_name", `%${input.seniorLawyerName}%`);
  }

  const { data, error } = await query.maybeSingle();

  if (error) throw new Error(`Failed to resolve senior lawyer: ${error.message}`);

  const row = data as { users: UserRow | UserRow[] | null } | null;
  return normalizeJoinedUser(row?.users);
}

async function resolveMatter(input: {
  organizationId: string;
  matterText?: string | null;
  createdBy: string;
}): Promise<MatterRow> {
  const title = input.matterText?.trim() || "WhatsApp quick matter";
  const supabaseAdmin = getSupabaseAdmin();

  const { data: existing, error: findError } = await supabaseAdmin
    .from("matters")
    .select("id,title,case_number,court_id")
    .eq("organization_id", input.organizationId)
    .ilike("title", `%${title}%`)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();

  if (findError) throw new Error(`Failed to resolve matter: ${findError.message}`);
  if (existing) return existing as MatterRow;

  const { data: created, error: createError } = await supabaseAdmin
    .from("matters")
    .insert({
      organization_id: input.organizationId,
      title,
      source: "manual",
      status: "open",
      priority: "normal",
      created_by: input.createdBy,
    })
    .select("id,title,case_number,court_id")
    .single();

  if (createError) throw new Error(`Failed to create matter: ${createError.message}`);

  return created as MatterRow;
}

async function resolveCourt(input: {
  organizationId: string;
  courtText?: string | null;
}): Promise<CourtRow | null> {
  const name = input.courtText?.trim();
  if (!name) return null;
  const supabaseAdmin = getSupabaseAdmin();

  const { data: existing, error: findError } = await supabaseAdmin
    .from("courts")
    .select("id,name,city")
    .or(`organization_id.eq.${input.organizationId},organization_id.is.null`)
    .ilike("name", `%${name}%`)
    .limit(1)
    .maybeSingle();

  if (findError) throw new Error(`Failed to resolve court: ${findError.message}`);
  if (existing) return existing as CourtRow;

  const { data: created, error: createError } = await supabaseAdmin
    .from("courts")
    .insert({
      organization_id: input.organizationId,
      name,
      city: inferCityFromCourtName(name),
    })
    .select("id,name,city")
    .single();

  if (createError) throw new Error(`Failed to create court: ${createError.message}`);

  return created as CourtRow;
}

async function notifySeniorOfConfirmedHearing(input: {
  organizationId: string;
  senior: UserRow;
  senderUserId: string;
  hearingId: string;
  matterTitle: string;
  courtName: string;
  hearingDate: string;
  startTime?: string | null;
}) {
  if (input.senior.id === input.senderUserId) return;

  const phone = await getWhatsappPhoneForUser({
    organizationId: input.organizationId,
    userId: input.senior.id,
  });

  if (!phone) return;

  await sendWhatsappText({
    organizationId: input.organizationId,
    to: phone,
    body:
      `New date noted.\n\n` +
      `${input.matterTitle}\n` +
      `${formatDateForWhatsapp(input.hearingDate)}${input.startTime ? ` at ${input.startTime}` : ""}\n` +
      `${input.courtName}`,
    entityType: "hearing",
    entityId: input.hearingId,
    recipientUserId: input.senior.id,
  });
}

async function getWhatsappPhoneForUser(input: {
  organizationId: string;
  userId: string;
}): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data: contact, error: contactError } = await supabase
    .from("whatsapp_contacts")
    .select("phone")
    .eq("organization_id", input.organizationId)
    .eq("user_id", input.userId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (contactError) {
    throw new Error(`Failed to load senior WhatsApp contact: ${contactError.message}`);
  }

  if (contact?.phone) return contact.phone as string;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("phone")
    .eq("id", input.userId)
    .maybeSingle();

  if (userError) {
    throw new Error(`Failed to load senior phone: ${userError.message}`);
  }

  return (user?.phone as string | undefined) ?? null;
}

async function getConversationState(input: {
  organizationId: string;
  userId: string;
  phone: string;
}): Promise<ConversationState | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("whatsapp_conversation_states")
    .select("flow,step,payload_json,expires_at")
    .eq("organization_id", input.organizationId)
    .eq("user_id", input.userId)
    .eq("phone", normalizeWhatsappPhone(input.phone))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) throw new Error(`Failed to load WhatsApp conversation: ${error.message}`);
  if (!data) return null;

  return {
    flow: data.flow as ConversationFlow,
    step: data.step as ConversationStep,
    payload_json: (data.payload_json as ConversationPayload | null) ?? {},
  };
}

async function saveConversationState(input: {
  organizationId: string;
  userId: string;
  phone: string;
  flow: ConversationFlow;
  step: ConversationStep;
  payload: ConversationPayload;
}) {
  const { error } = await getSupabaseAdmin()
    .from("whatsapp_conversation_states")
    .upsert(
      {
        organization_id: input.organizationId,
        user_id: input.userId,
        phone: normalizeWhatsappPhone(input.phone),
        flow: input.flow,
        step: input.step,
        payload_json: input.payload,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,user_id,phone" },
    );

  if (error) throw new Error(`Failed to save WhatsApp conversation: ${error.message}`);
}

async function clearConversationState(organizationId: string, userId: string, phone: string) {
  const { error } = await getSupabaseAdmin()
    .from("whatsapp_conversation_states")
    .delete()
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("phone", normalizeWhatsappPhone(phone));

  if (error) throw new Error(`Failed to clear WhatsApp conversation: ${error.message}`);
}

async function reply(
  input: { organizationId: string; senderUserId: string; fromPhone: string },
  body: string,
) {
  await sendWhatsappText({
    organizationId: input.organizationId,
    to: input.fromPhone,
    body,
    entityType: "whatsapp_inbound",
    entityId: input.senderUserId,
    recipientUserId: input.senderUserId,
  });
}

async function handleOutcomeWhatsappCommand(input: {
  organizationId: string;
  senderUserId: string;
  fromPhone: string;
  text: string;
}) {
  const parsed = parseOutcomeWhatsappText(input.text);

  if (!parsed.ok) {
    await sendWhatsappText({
      organizationId: input.organizationId,
      to: input.fromPhone,
      body: parsed.error,
      entityType: "whatsapp_inbound",
      entityId: input.senderUserId,
      recipientUserId: input.senderUserId,
    });
    return;
  }

  const openOutcome = await findOpenOutcomeForMatterReference({
    organizationId: input.organizationId,
    reference: parsed.matterReference,
  });
  const hearing =
    openOutcome?.hearing ??
    (await findLatestHearingForMatterReference({
      organizationId: input.organizationId,
      reference: parsed.matterReference,
    }));

  if (!hearing) {
    await sendWhatsappText({
      organizationId: input.organizationId,
      to: input.fromPhone,
      body:
        `Matter/hearing not found for "${parsed.matterReference}". ` +
        `Use a case number, exact matter title, short hearing ID, or full hearing ID already saved in diary.`,
      entityType: "whatsapp_inbound",
      entityId: input.senderUserId,
      recipientUserId: input.senderUserId,
    });
    return;
  }

  if (parsed.nextDateStatus === "entered" && parsed.nextDate) {
    const nextHearingId = await addNextDateFromOutcome({
      organizationId: input.organizationId,
      sourceHearingId: hearing.id,
      matterId: hearing.matter_id,
      courtId: hearing.court_id,
      hearingDate: parsed.nextDate,
      startTime: parsed.nextTime,
      seniorLawyerId: hearing.senior_lawyer_id,
      appearingLawyerId: hearing.appearing_lawyer_id,
      createdBy: input.senderUserId,
      purpose: "Next hearing from WhatsApp outcome",
    });

    await sendWhatsappText({
      organizationId: input.organizationId,
      to: input.fromPhone,
      body:
        `Outcome saved.\n` +
        `Next date added to diary: ${formatDateForWhatsapp(parsed.nextDate)}.\n` +
        `Hearing ID: ${nextHearingId}`,
      entityType: "hearing",
      entityId: nextHearingId,
      recipientUserId: input.senderUserId,
    });
    return;
  }

  await createHearingOutcome({
    organizationId: input.organizationId,
    hearingId: hearing.id,
    matterId: hearing.matter_id,
    updatedBy: input.senderUserId,
    appearanceStatus: "appeared",
    outcomeType: parsed.outcomeType,
    outcomeSummary: parsed.summary,
    nextDateStatus: parsed.nextDateStatus,
  });

  await sendWhatsappText({
    organizationId: input.organizationId,
    to: input.fromPhone,
    body:
      parsed.nextDateStatus === "pending"
        ? "Outcome saved.\nThis matter is now in Missing Next-Date queue.\nReminder will stay active until next date is entered."
        : `Outcome saved.\nStatus: ${parsed.nextDateStatus}.`,
    entityType: "hearing",
    entityId: hearing.id,
    recipientUserId: input.senderUserId,
  });
}

async function handleNextDateWhatsappCommand(input: {
  organizationId: string;
  senderUserId: string;
  fromPhone: string;
  text: string;
}) {
  const parsed = parseNextDateWhatsappText(input.text);

  if (!parsed.ok) {
    await sendWhatsappText({
      organizationId: input.organizationId,
      to: input.fromPhone,
      body: parsed.error,
      entityType: "whatsapp_inbound",
      entityId: input.senderUserId,
      recipientUserId: input.senderUserId,
    });
    return;
  }

  const openOutcome = await findOpenOutcomeForMatterReference({
    organizationId: input.organizationId,
    reference: parsed.matterReference,
  });

  if (!openOutcome?.hearing) {
    await sendWhatsappText({
      organizationId: input.organizationId,
      to: input.fromPhone,
      body: `No Missing Next-Date item found for "${parsed.matterReference}".`,
      entityType: "whatsapp_inbound",
      entityId: input.senderUserId,
      recipientUserId: input.senderUserId,
    });
    return;
  }

  await addNextDateFromOutcome({
    organizationId: input.organizationId,
    sourceHearingId: openOutcome.hearing.id,
    matterId: openOutcome.hearing.matter_id,
    courtId: openOutcome.hearing.court_id,
    hearingDate: parsed.nextDate,
    startTime: parsed.nextTime,
    seniorLawyerId: openOutcome.hearing.senior_lawyer_id,
    appearingLawyerId: openOutcome.hearing.appearing_lawyer_id,
    createdBy: input.senderUserId,
    purpose: "Next hearing fixed from WhatsApp",
  });

  await sendWhatsappText({
    organizationId: input.organizationId,
    to: input.fromPhone,
    body:
      `Next date saved.\n` +
      `Matter removed from Missing Next-Date queue.\n` +
      `Date: ${formatDateForWhatsapp(parsed.nextDate)}\n` +
      `Time: ${parsed.nextTime ?? "Not specified"}`,
    entityType: "hearing_outcome",
    entityId: openOutcome.outcomeId,
    recipientUserId: input.senderUserId,
  });
}

function isOutcomeCommand(text: string) {
  return text.trim().toLowerCase().startsWith("outcome ");
}

function isNextDateCommand(text: string) {
  return text.trim().toLowerCase().startsWith("nextdate ");
}

function getQuickFlow(text: string): ConversationFlow | null {
  const lowered = text.trim().toLowerCase();
  if (["check", "check date", "check slot", "slot"].includes(lowered)) return "check_slot";
  if (["save", "save date", "add date", "add hearing"].includes(lowered)) return "save_date";
  if (lowered === "1") return "check_slot";
  if (lowered === "2") return "save_date";
  return null;
}

function isCancelCommand(text: string) {
  return ["cancel", "stop", "reset"].includes(text.trim().toLowerCase());
}

function isSkip(text: string) {
  return ["skip", "no", "none", "-"].includes(text.trim().toLowerCase());
}

function parseLooseDate(text: string): string | null {
  const match = text.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/);
  return match ? normalizeDate(match[1]) : null;
}

function parseLooseTime(text: string): string | null {
  const match = text.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  return match ? normalizeTime(match[1]) : null;
}

function parseDateFirstCheck(text: string): ConversationPayload | null {
  const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/);
  if (!dateMatch || dateMatch.index !== 0) return null;

  const date = normalizeDate(dateMatch[1]);
  if (!date) return null;

  const withoutDate = text.slice(dateMatch[1].length).trim();
  const timeMatch = withoutDate.match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  const startTime = timeMatch ? normalizeTime(timeMatch[1]) : null;
  const courtText = withoutDate
    .slice(timeMatch ? timeMatch[1].length : 0)
    .replace(/^(at|in|court)\b/i, "")
    .trim();

  return {
    date,
    startTime,
    courtText: courtText || null,
  };
}

function parseOutcomeWhatsappText(text: string):
  | {
      ok: true;
      matterReference: string;
      outcomeType: OutcomeType;
      nextDateStatus: NextDateStatus;
      nextDate: string | null;
      nextTime: string | null;
      summary: string;
    }
  | { ok: false; error: string } {
  const outcomeWords =
    "adjourned|disposed|reserved|order_reserved|order-reserved|cause-list|cause_list|awaiting_cause_list|awaiting-cause-list|no_proceedings|no-proceedings|pending|other";
  const match = text
    .trim()
    .match(new RegExp(`^outcome\\s+(.+?)\\s+(${outcomeWords})(.*)$`, "i"));
  if (!match) {
    return {
      ok: false,
      error:
        'Use: OUTCOME "Matter title/case number/hearing ID" adjourned next: 12-05-2026 OR next: pending',
    };
  }

  const matterReference = match[1].trim().replace(/^["']|["']$/g, "");
  const outcomeWord = match[2].toLowerCase();
  const rest = match[3] ?? "";
  const outcomeType = normalizeOutcomeType(outcomeWord);
  const nextValue = rest.match(/next\s*:\s*([^\n]+)/i)?.[1]?.trim() ?? null;

  if (!outcomeType) {
    return { ok: false, error: "Unknown outcome. Use adjourned, disposed, reserved, cause-list." };
  }

  if (!nextValue && outcomeType === "adjourned") {
    return { ok: false, error: "Adjourned outcome needs next: DD-MM-YYYY or next: pending." };
  }

  const nextDateStatus = getNextDateStatus(outcomeType, nextValue);
  const nextDateMatch = nextValue?.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/);
  const nextDate = nextDateMatch ? parseOutcomeDate(nextDateMatch[1]) : null;
  const nextTime = parseOutcomeTime(nextValue?.replace(nextDateMatch?.[1] ?? "", "").trim());

  if (nextDateStatus === "entered" && !nextDate) {
    return { ok: false, error: "Invalid next date. Use DD-MM-YYYY, DD/MM/YYYY, or YYYY-MM-DD." };
  }

  return {
    ok: true,
    matterReference,
    outcomeType,
    nextDateStatus,
    nextDate,
    nextTime,
    summary: `WhatsApp outcome: ${outcomeType}${nextValue ? `, next: ${nextValue}` : ""}`,
  };
}

function parseNextDateWhatsappText(text: string):
  | { ok: true; matterReference: string; nextDate: string; nextTime: string | null }
  | { ok: false; error: string } {
  const match = text
    .trim()
    .match(/^nextdate\s+(.+?)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})(.*)$/i);

  if (!match) {
    return { ok: false, error: 'Use: NEXTDATE "Matter title/case number/hearing ID" 12-05-2026 10am' };
  }

  const nextDate = parseOutcomeDate(match[2]);
  if (!nextDate) return { ok: false, error: "Invalid date format." };

  return {
    ok: true,
    matterReference: match[1].trim().replace(/^["']|["']$/g, ""),
    nextDate,
    nextTime: parseOutcomeTime(match[3]?.trim()),
  };
}

function normalizeOutcomeType(value: string): OutcomeType | null {
  if (value === "adjourned" || value === "adjourn") return "adjourned";
  if (value === "disposed" || value === "closed") return "disposed";
  if (value === "reserved" || value === "order_reserved") return "order_reserved";
  if (value === "cause-list" || value === "causelist" || value === "awaiting") {
    return "awaiting_cause_list";
  }
  if (value === "pending") return "next_date_pending";
  if (value === "none" || value === "no_proceedings") return "no_proceedings";
  return null;
}

function getNextDateStatus(outcomeType: OutcomeType, nextValue: string | null): NextDateStatus {
  const lowered = nextValue?.toLowerCase() ?? "";
  if (lowered.includes("pending")) return "pending";
  if (lowered.includes("not given")) return "not_given";
  if (lowered.includes("cause")) return "awaiting_cause_list";
  if (nextValue) return "entered";
  if (outcomeType === "awaiting_cause_list") return "awaiting_cause_list";
  if (outcomeType === "disposed" || outcomeType === "order_reserved") return "not_required";
  if (outcomeType === "next_date_pending") return "pending";
  return "not_required";
}

function formatAvailabilityReply(input: {
  date: string;
  time?: string | null;
  seniorName: string;
  matterTitle: string;
  courtName: string;
  availability: {
    status: string;
    isAvailable: boolean;
    reason: string;
    conflicts: Array<{ severity: string; reason: string }>;
  };
}): string {
  const statusLine = input.availability.isAvailable
    ? "Looks clear."
    : "There is a clash.";
  const warningLine = input.availability.status === "soft_warning" ? input.availability.reason : "";
  const conflicts = input.availability.conflicts
    .slice(0, 2)
    .map((conflict) => conflict.reason)
    .join("\n");

  return [
    statusLine,
    "",
    `${input.matterTitle}`,
    `${formatDateForWhatsapp(input.date)}${input.time ? ` at ${input.time}` : ""}`,
    `${input.courtName}`,
    `Senior: ${input.seniorName}`,
    warningLine ? `\nNote: ${warningLine}` : "",
    conflicts ? `\n${conflicts}` : "",
    "",
    input.availability.isAvailable
      ? "If court confirms it, send SAVE and I’ll add it."
      : "Better confirm with senior before taking this date.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatQuickAvailabilityReply(input: {
  date: string;
  time?: string | null;
  availability: {
    isAvailable: boolean;
    reason: string;
    conflicts: Array<{ severity: string; reason: string }>;
  };
}) {
  if (input.availability.isAvailable) {
    return `Looks clear for ${formatDateForWhatsapp(input.date)}${
      input.time ? ` at ${input.time}` : ""
    }.`;
  }

  const conflict = input.availability.conflicts[0]?.reason ?? input.availability.reason;
  return `There is a clash on ${formatDateForWhatsapp(input.date)}${
    input.time ? ` at ${input.time}` : ""
  }.\n${conflict}`;
}

function normalizeWhatsappPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  if (digits.startsWith("92")) return `+${digits}`;
  if (digits.startsWith("0")) return `+92${digits.slice(1)}`;
  return `+${digits}`;
}

function inferCityFromCourtName(name: string): string | null {
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

function normalizeJoinedUser(value: UserRow | UserRow[] | null | undefined): UserRow | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

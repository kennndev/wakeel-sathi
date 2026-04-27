import "server-only";
import { getSupabaseAdmin } from "../db/supabase-admin";

type SendWhatsappTextInput = {
  organizationId: string;
  to: string;
  body: string;
  entityType: string;
  entityId: string;
  recipientUserId?: string | null;
};

export async function sendWhatsappText(input: SendWhatsappTextInput) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_GRAPH_API_VERSION ?? "v23.0";

  if (!token || !phoneNumberId) {
    await recordNotificationEvent({
      ...input,
      status: "failed",
      failureReason: "WhatsApp API env vars missing.",
      providerMessageId: null,
    });

    return { ok: false as const, error: "WhatsApp API env vars missing." };
  }

  await recordNotificationEvent({
    ...input,
    status: "sending",
    failureReason: null,
    providerMessageId: null,
  });

  const response = await fetch(
    `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: input.to,
        type: "text",
        text: {
          preview_url: false,
          body: input.body,
        },
      }),
    },
  );

  const json = (await response.json()) as unknown;

  if (!response.ok) {
    await recordNotificationEvent({
      ...input,
      status: "failed",
      failureReason: JSON.stringify(json),
      providerMessageId: null,
    });

    return { ok: false as const, error: "Failed to send WhatsApp message.", details: json };
  }

  const providerMessageId = extractProviderMessageId(json);

  await recordNotificationEvent({
    ...input,
    status: "sent",
    failureReason: null,
    providerMessageId,
  });

  return { ok: true as const, providerMessageId, raw: json };
}

async function recordNotificationEvent(
  input: SendWhatsappTextInput & {
    status: "sending" | "sent" | "failed";
    failureReason: string | null;
    providerMessageId: string | null;
  },
) {
  await getSupabaseAdmin().from("notification_events").insert({
    organization_id: input.organizationId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    channel: "whatsapp",
    recipient_user_id: input.recipientUserId ?? null,
    recipient_phone: input.to,
    message_preview: input.body.slice(0, 500),
    provider: "meta_cloud_api",
    provider_message_id: input.providerMessageId,
    status: input.status,
    failure_reason: input.failureReason,
    sent_at: input.status === "sent" ? new Date().toISOString() : null,
  });
}

function extractProviderMessageId(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const maybe = json as { messages?: Array<{ id?: string }> };
  return maybe.messages?.[0]?.id ?? null;
}

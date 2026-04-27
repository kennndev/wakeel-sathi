import { NextRequest, NextResponse } from "next/server";
import { handleInboundWhatsappMessage } from "../../../../lib/whatsapp/handle-inbound-message";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as WhatsAppWebhookPayload;
  const messages = extractInboundMessages(body);

  for (const message of messages) {
    if (message.type !== "text" || !message.text?.body) continue;

    await handleInboundWhatsappMessage({
      fromPhone: message.from,
      text: message.text.body,
    });
  }

  return NextResponse.json({ ok: true });
}

type WhatsAppWebhookPayload = {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: {
            body?: string;
          };
        }>;
      };
    }>;
  }>;
};

function extractInboundMessages(payload: WhatsAppWebhookPayload) {
  return (
    payload.entry?.flatMap((entry) =>
      entry.changes?.flatMap((change) => change.value?.messages ?? []) ?? [],
    ) ?? []
  );
}

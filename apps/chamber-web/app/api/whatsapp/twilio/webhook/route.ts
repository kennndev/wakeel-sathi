import { NextRequest, NextResponse } from "next/server";
import { handleInboundWhatsappMessage } from "../../../../../lib/whatsapp/handle-inbound-message";

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const from = getString(formData, "From");
  const body = getString(formData, "Body");

  if (!from || !body) {
    return twiml("");
  }

  await handleInboundWhatsappMessage({
    fromPhone: stripTwilioWhatsappPrefix(from),
    text: body,
  });

  return twiml("");
}

function getString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripTwilioWhatsappPrefix(phone: string): string {
  return phone.replace(/^whatsapp:/i, "");
}

function twiml(message: string) {
  const escaped = escapeXml(message);
  const body = escaped ? `<Response><Message>${escaped}</Message></Response>` : "<Response />";

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

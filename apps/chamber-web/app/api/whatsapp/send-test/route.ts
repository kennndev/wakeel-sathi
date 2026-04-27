import { NextRequest, NextResponse } from "next/server";
import { sendWhatsappText } from "../../../../lib/whatsapp/send-whatsapp-message";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    to: string;
    message: string;
    organizationId: string;
  };

  if (!body.to || !body.message || !body.organizationId) {
    return NextResponse.json(
      { error: "to, message, and organizationId are required" },
      { status: 400 },
    );
  }

  const result = await sendWhatsappText({
    organizationId: body.organizationId,
    to: body.to,
    body: body.message,
    entityType: "manual_test",
    entityId: crypto.randomUUID(),
  });

  return NextResponse.json(result);
}

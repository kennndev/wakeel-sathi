import { NextRequest, NextResponse } from "next/server";
import { sendDueWhatsappReminders } from "../../../../lib/reminders/send-due-reminders";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sendDueWhatsappReminders();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown cron error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

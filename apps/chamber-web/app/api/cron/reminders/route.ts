import { NextRequest, NextResponse } from "next/server";
import { sendDueWhatsappReminders } from "../../../../lib/reminders/send-due-reminders";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await sendDueWhatsappReminders();
  return NextResponse.json({ ok: true, ...result });
}

import { normalizeDate, normalizeTime } from "../utils/date";
import type { ParsedInboundCommand } from "./types";

const knownKeys = ["matter", "court", "senior"] as const;

export function parseInboundCommand(rawText: string): ParsedInboundCommand {
  const text = rawText.trim();
  const lowered = text.toLowerCase();

  const isCheck =
    lowered.startsWith("check") || lowered.startsWith("slot") || lowered.includes("available");
  const isSave =
    lowered.startsWith("save") ||
    lowered.startsWith("confirm") ||
    lowered.startsWith("date confirmed");

  if (!isCheck && !isSave) {
    return {
      ok: false,
      error:
        "Command not understood. Send: CHECK 12-05-2026 10am matter: ABC court: Lahore High Court senior: Ali",
      rawText,
    };
  }

  const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/);
  if (!dateMatch) {
    return {
      ok: false,
      error: "Date missing. Use DD-MM-YYYY, DD/MM/YYYY, or YYYY-MM-DD.",
      rawText,
    };
  }

  const date = normalizeDate(dateMatch[1]);
  if (!date) {
    return {
      ok: false,
      error: "Invalid date format.",
      rawText,
    };
  }

  const textWithoutDate = text.replace(dateMatch[1], " ");
  const timeMatch = textWithoutDate.match(/(?:\s|^)(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s|$)/i);
  const startTime = timeMatch ? normalizeTime(timeMatch[1]) : null;

  return {
    ok: true,
    command: isSave ? "save_date" : "check_slot",
    date,
    startTime,
    endTime: null,
    seniorLawyerName: getKeyValue(text, "senior"),
    matterText: getKeyValue(text, "matter"),
    courtText: getKeyValue(text, "court"),
    rawText,
  };
}

function getKeyValue(text: string, key: (typeof knownKeys)[number]): string | null {
  const regex = new RegExp(`${key}\\s*:\\s*([^\\n]+)`, "i");
  const match = text.match(regex);
  if (!match) return null;

  return match[1].split(/\s+(matter|court|senior)\s*:/i)[0].trim();
}

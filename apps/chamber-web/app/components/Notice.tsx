type NoticeProps = {
  notice?: string;
};

const messages: Record<string, string> = {
  "chamber-saved": "Chamber setup saved. The registered numbers can now use WhatsApp.",
  "junior-added": "Junior sender added and WhatsApp access is active.",
  "member-updated": "Member details updated.",
  "outcome-saved": "Hearing outcome saved.",
  "junior-asked": "Reminder sent to the assigned junior.",
  "queue-updated": "Next-date queue updated.",
};

export function Notice({ notice }: NoticeProps) {
  if (!notice || !messages[notice]) return null;

  return (
    <div className="notice" role="status" aria-live="polite">
      <strong>Done</strong>
      <span>{messages[notice]}</span>
    </div>
  );
}

import Link from "next/link";
import { getSupabaseAdmin } from "../../lib/db/supabase-admin";

export const dynamic = "force-dynamic";

type HearingRow = {
  id: string;
  hearing_date: string;
  start_time: string | null;
  purpose: string | null;
  status: string;
  matters: { title: string } | { title: string }[] | null;
  courts: { name: string } | { name: string }[] | null;
  senior: { full_name: string } | { full_name: string }[] | null;
  appearing: { full_name: string } | { full_name: string }[] | null;
};

type ChamberRow = {
  id: string;
  name: string;
  whatsapp_contacts: Array<{ phone: string; is_active: boolean }>;
};

export default async function DiaryPage() {
  const configuredOrganizationId = process.env.DEFAULT_ORGANIZATION_ID?.trim();
  const supabase = getSupabaseAdmin();

  const { data: chambers } = await supabase
    .from("organizations")
    .select("id,name,whatsapp_contacts(phone,is_active)")
    .order("created_at", { ascending: false })
    .limit(5);

  const chamberRows = (chambers as ChamberRow[] | null) ?? [];
  const activeOrganizationId = configuredOrganizationId || chamberRows[0]?.id;
  let hearings: HearingRow[] = [];
  let missingNextDateCount = 0;

  if (activeOrganizationId) {
    const { data, error } = await supabase
      .from("hearings")
      .select(
        "id,hearing_date,start_time,purpose,status,matters(title),courts(name),senior:senior_lawyer_id(full_name),appearing:appearing_lawyer_id(full_name)",
      )
      .eq("organization_id", activeOrganizationId)
      .is("deleted_at", null)
      .order("hearing_date", { ascending: true })
      .order("start_time", { ascending: true });

    if (error) {
      throw new Error(`Failed to load diary: ${error.message}`);
    }

    hearings = (data as HearingRow[] | null) ?? [];

    const { count } = await supabase
      .from("hearing_outcomes")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", activeOrganizationId)
      .in("next_date_status", ["pending", "not_given", "awaiting_cause_list"]);

    missingNextDateCount = count ?? 0;
  }

  const upcomingHearings = hearings.filter((hearing) => hearing.status === "scheduled");
  const courts = new Set(
    hearings.map((hearing) => single(hearing.courts)?.name).filter(Boolean),
  );

  return (
    <main className="diary-page">
      <nav className="topbar">
        <Link href="/" className="brand-mark">
          Wakeel Sathi
        </Link>
        <div>
          <Link href="/setup">Setup</Link>
          <Link href="/diary">Diary</Link>
          <Link href="/chamber/missing-next-dates">Missing Dates</Link>
        </div>
      </nav>

      <section className="diary-hero">
        <div>
          <p className="eyebrow">Court Diary</p>
          <h1>Chamber Dates</h1>
          <p>
            Dates saved from WhatsApp appear here with chamber contacts, assigned
            lawyers, courts, and reminder-ready hearing records.
          </p>
          <div className="action-row">
            <Link href="/setup">Setup chamber</Link>
            <Link href="/">Home</Link>
          </div>
        </div>

        <div className="metric-grid">
          <article>
            <span>Total hearings</span>
            <strong>{hearings.length}</strong>
          </article>
          <article>
            <span>Scheduled</span>
            <strong>{upcomingHearings.length}</strong>
          </article>
          <article>
            <span>Courts</span>
            <strong>{courts.size}</strong>
          </article>
          <Link
            href="/chamber/missing-next-dates"
            className={missingNextDateCount ? "metric-link is-alert" : "metric-link"}
          >
            Missing next dates: {missingNextDateCount}
          </Link>
        </div>
      </section>

      <section className="diary-layout">
        <aside className="diary-panel chamber-panel">
          <div className="panel-heading">
            <p className="eyebrow">Workspace</p>
            <h2>Chambers</h2>
          </div>
          {chamberRows.length ? (
            <div className="stack">
              {chamberRows.map((chamber) => (
                <article
                  key={chamber.id}
                  className={
                    chamber.id === activeOrganizationId
                      ? "chamber-card is-active"
                      : "chamber-card"
                  }
                >
                  <span>Active chamber</span>
                  <strong>{chamber.name}</strong>
                  <code>{chamber.id}</code>
                  <div>
                    {(chamber.whatsapp_contacts ?? []).map((contact) => (
                      <small key={contact.phone}>{contact.phone}</small>
                    ))}
                    {!chamber.whatsapp_contacts?.length ? <small>No contacts</small> : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p>No chamber records yet.</p>
          )}
        </aside>

        <section className="diary-panel hearings-panel">
          <div className="panel-heading split">
            <div>
              <p className="eyebrow">Schedule</p>
              <h2>Hearings</h2>
            </div>
            <span>{hearings.length ? `${hearings.length} saved` : "No saved dates"}</span>
          </div>
          {hearings.length ? (
            <div className="hearing-list">
              {hearings.map((hearing) => (
                <article key={hearing.id} className="hearing-card">
                  <div className="date-tile">
                    <span>{formatMonth(hearing.hearing_date)}</span>
                    <strong>{formatDay(hearing.hearing_date)}</strong>
                  </div>
                  <div className="hearing-main">
                    <div className="hearing-title-row">
                      <div>
                        <h3>{single(hearing.matters)?.title ?? "Unknown matter"}</h3>
                        <p>{single(hearing.courts)?.name ?? "Court not specified"}</p>
                      </div>
                      <span className="status-pill">{hearing.status}</span>
                    </div>
                    <dl>
                      <div>
                        <dt>Time</dt>
                        <dd>{hearing.start_time ?? "Not set"}</dd>
                      </div>
                      <div>
                        <dt>Senior</dt>
                        <dd>{single(hearing.senior)?.full_name ?? "Not set"}</dd>
                      </div>
                      <div>
                        <dt>Appearing</dt>
                        <dd>{single(hearing.appearing)?.full_name ?? "Not set"}</dd>
                      </div>
                    </dl>
                    <div className="hearing-actions">
                      <Link href={`/chamber/hearings/${hearing.id}/outcome`}>
                        Update outcome
                      </Link>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <strong>No hearings saved yet.</strong>
              <p>Send a SAVE command through WhatsApp after setup.</p>
              <code>
                SAVE 12-05-2026 10am senior: Senior Lawyer matter: Cheque case court:
                Banking Court Lahore
              </code>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function single<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function formatMonth(date: string): string {
  return new Intl.DateTimeFormat("en", { month: "short" }).format(new Date(`${date}T00:00:00`));
}

function formatDay(date: string): string {
  return new Intl.DateTimeFormat("en", { day: "2-digit" }).format(new Date(`${date}T00:00:00`));
}

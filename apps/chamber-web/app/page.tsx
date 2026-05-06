import Link from "next/link";
import { Notice } from "./components/Notice";
import { getSupabaseAdmin } from "../lib/db/supabase-admin";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams?: Promise<{ notice?: string }>;
};

type ChamberRow = {
  id: string;
  name: string;
  whatsapp_contacts: Array<{ phone: string; is_active: boolean }>;
  organization_members: Array<{ role: string; status: string }>;
};

type HearingRow = {
  id: string;
  hearing_date: string;
  start_time: string | null;
  status: string;
  matters: { title: string; case_number: string | null } | Array<{ title: string; case_number: string | null }> | null;
  courts: { name: string } | { name: string }[] | null;
};

export default async function Home({ searchParams }: HomeProps) {
  const { notice } = (await searchParams) ?? {};
  const { chamber, hearings, missingNextDateCount } = await loadHomeData();
  const activeHearings = hearings.filter((hearing) =>
    ["scheduled", "pending_update"].includes(hearing.status),
  );
  const nextHearings = activeHearings.slice(0, 4);
  const juniorCount =
    chamber?.organization_members.filter((member) => member.role === "junior_lawyer").length ?? 0;
  const seniorCount =
    chamber?.organization_members.filter((member) => member.role === "senior_lawyer").length ?? 0;

  return (
    <main className="home-page">
      <nav className="topbar">
        <Link href="/" className="brand-mark">
          Wakeel Sathi
        </Link>
        <div>
          <Link href="/diary">Diary</Link>
          <Link href="/setup">Setup</Link>
          <Link href="/chamber/missing-next-dates">Missing Dates</Link>
        </div>
      </nav>

      <Notice notice={notice} />

      <section className="home-hero">
        <div>
          <p className="eyebrow">Single Chamber Workspace</p>
          <h1>{chamber?.name ?? "Set up your chamber"}</h1>
          <p>
            Keep one clean command center for registered WhatsApp senders, active court
            dates, and next-date follow-up.
          </p>
        </div>
        <div className="home-actions">
          <Link href="/diary">Open diary</Link>
          <Link href="/setup">{chamber ? "Manage setup" : "Create chamber"}</Link>
        </div>
      </section>

      <section className="overview-grid">
        <article className="overview-card">
          <span>Active hearings</span>
          <strong>{activeHearings.length}</strong>
          <p>{hearings.length} total hearing record(s)</p>
        </article>
        <article className={missingNextDateCount ? "overview-card is-alert" : "overview-card"}>
          <span>Missing next dates</span>
          <strong>{missingNextDateCount}</strong>
          <p>Pending, not-given, or cause-list follow-up</p>
        </article>
        <article className="overview-card">
          <span>Chamber members</span>
          <strong>{seniorCount + juniorCount}</strong>
          <p>{seniorCount} senior, {juniorCount} junior sender(s)</p>
        </article>
      </section>

      <section className="home-layout">
        <section className="diary-panel">
          <div className="panel-heading split">
            <div>
              <p className="eyebrow">Next Up</p>
              <h2>Upcoming dates</h2>
            </div>
            <Link href="/diary">View all</Link>
          </div>
          {nextHearings.length ? (
            <div className="compact-hearing-list">
              {nextHearings.map((hearing) => (
                <article key={hearing.id} className="compact-hearing">
                  <time dateTime={hearing.hearing_date}>
                    <span>{formatMonth(hearing.hearing_date)}</span>
                    <strong>{formatDay(hearing.hearing_date)}</strong>
                  </time>
                  <div>
                    <h3>{single(hearing.matters)?.title ?? "Unknown matter"}</h3>
                    <p>{single(hearing.courts)?.name ?? "Court not specified"}</p>
                    <small>
                      {hearing.start_time ?? "Time not set"} | Case{" "}
                      {single(hearing.matters)?.case_number ?? "not set"}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <strong>No active dates yet.</strong>
              <p>Registered juniors can send SAVE on WhatsApp to add a hearing.</p>
            </div>
          )}
        </section>

        <aside className="diary-panel">
          <div className="panel-heading">
            <p className="eyebrow">Setup</p>
            <h2>WhatsApp access</h2>
          </div>
          {chamber ? (
            <div className="contact-list">
              {chamber.whatsapp_contacts.length ? (
                chamber.whatsapp_contacts.map((contact) => (
                  <span key={contact.phone}>{contact.phone}</span>
                ))
              ) : (
                <p>No sender numbers registered.</p>
              )}
            </div>
          ) : (
            <p>Create the chamber record before saving court dates from WhatsApp.</p>
          )}
          <div className="action-row">
            <Link href="/setup">Manage numbers</Link>
            <Link href="/chamber/missing-next-dates">Follow up</Link>
          </div>
        </aside>
      </section>
    </main>
  );
}

async function loadHomeData(): Promise<{
  chamber: ChamberRow | null;
  hearings: HearingRow[];
  missingNextDateCount: number;
}> {
  const configuredOrganizationId = process.env.DEFAULT_ORGANIZATION_ID?.trim();
  const supabase = getSupabaseAdmin();
  const { data: chambers, error: chamberError } = await supabase
    .from("organizations")
    .select("id,name,whatsapp_contacts(phone,is_active),organization_members(role,status)")
    .order("created_at", { ascending: false })
    .limit(1);

  if (chamberError) {
    throw new Error(`Failed to load chamber: ${chamberError.message}`);
  }

  const chamberRows = (chambers as unknown as ChamberRow[] | null) ?? [];
  const chamber = chamberRows[0] ?? null;
  const organizationId = configuredOrganizationId || chamber?.id;

  if (!organizationId) {
    return { chamber, hearings: [], missingNextDateCount: 0 };
  }

  const { data: hearings, error: hearingsError } = await supabase
    .from("hearings")
    .select("id,hearing_date,start_time,status,matters(title,case_number),courts(name)")
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .order("hearing_date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(10);

  if (hearingsError) {
    throw new Error(`Failed to load hearings: ${hearingsError.message}`);
  }

  const { count } = await supabase
    .from("hearing_outcomes")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("next_date_status", ["pending", "not_given", "awaiting_cause_list"]);

  return {
    chamber,
    hearings: (hearings as unknown as HearingRow[] | null) ?? [],
    missingNextDateCount: count ?? 0,
  };
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

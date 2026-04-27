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
  }

  return (
    <main className="page-shell">
      <section className="hero-panel compact">
        <p className="eyebrow">Court Diary</p>
        <h1>Chamber Dates</h1>
        <p>
          Dates saved from WhatsApp appear here. If setup is empty, create the chamber
          first so inbound WhatsApp numbers can resolve to a user.
        </p>
        <div className="action-row">
          <Link href="/setup">Setup chamber</Link>
          <Link href="/">Home</Link>
        </div>
      </section>

      <section className="dashboard-grid">
        <div className="panel">
          <h2>Chambers</h2>
          {chamberRows.length ? (
            <div className="stack">
              {chamberRows.map((chamber) => (
                <article key={chamber.id} className="mini-card">
                  <strong>{chamber.name}</strong>
                  <span>{chamber.id}</span>
                  <span>
                    WhatsApp contacts:{" "}
                    {chamber.whatsapp_contacts?.map((contact) => contact.phone).join(", ") ||
                      "none"}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <p>No chamber records yet.</p>
          )}
        </div>

        <div className="panel wide">
          <h2>Hearings</h2>
          {hearings.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Matter</th>
                    <th>Court</th>
                    <th>Senior</th>
                    <th>Appearing</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {hearings.map((hearing) => (
                    <tr key={hearing.id}>
                      <td>{hearing.hearing_date}</td>
                      <td>{hearing.start_time ?? "Not set"}</td>
                      <td>{single(hearing.matters)?.title ?? "Unknown"}</td>
                      <td>{single(hearing.courts)?.name ?? "Not specified"}</td>
                      <td>{single(hearing.senior)?.full_name ?? "Not set"}</td>
                      <td>{single(hearing.appearing)?.full_name ?? "Not set"}</td>
                      <td>{hearing.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No hearings saved yet. Send a SAVE command through WhatsApp after setup.</p>
          )}
        </div>
      </section>
    </main>
  );
}

function single<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

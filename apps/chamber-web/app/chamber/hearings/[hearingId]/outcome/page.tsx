import Link from "next/link";
import { saveOutcomeAction } from "../../../../../lib/outcomes/actions";
import { getSupabaseAdmin } from "../../../../../lib/db/supabase-admin";

export const dynamic = "force-dynamic";

type HearingDetail = {
  id: string;
  organization_id: string;
  matter_id: string;
  hearing_date: string;
  start_time: string | null;
  matters: { title: string } | { title: string }[] | null;
  courts: { name: string } | { name: string }[] | null;
  senior: { full_name: string } | { full_name: string }[] | null;
  appearing: { full_name: string } | { full_name: string }[] | null;
};

export default async function HearingOutcomePage({
  params,
}: {
  params: Promise<{ hearingId: string }>;
}) {
  const { hearingId } = await params;
  const hearing = await loadHearing(hearingId);

  return (
    <main className="setup-page">
      <section className="setup-hero">
        <div>
          <p className="eyebrow">Hearing Outcome</p>
          <h1>Update outcome</h1>
          <p>
            Force a clear post-hearing state so the matter cannot disappear from the
            active diary without a next date, disposal, or cause-list status.
          </p>
        </div>
        <div className="setup-status-card">
          <span>Hearing</span>
          <strong>{single(hearing.matters)?.title ?? "Matter"}</strong>
          <p>
            {hearing.hearing_date} at {hearing.start_time ?? "time not set"}
          </p>
        </div>
      </section>

      <section className="setup-layout">
        <form action={saveOutcomeAction} className="setup-form">
          <input type="hidden" name="organizationId" value={hearing.organization_id} />
          <input type="hidden" name="hearingId" value={hearing.id} />
          <input type="hidden" name="matterId" value={hearing.matter_id} />

          <div className="form-section-heading">
            <span>01</span>
            <div>
              <h2>Outcome</h2>
              <p>Record appearance and court result after this hearing.</p>
            </div>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>Appearance status</span>
              <select name="appearanceStatus" defaultValue="appeared">
                <option value="appeared">Appeared</option>
                <option value="not_appeared">Not appeared</option>
                <option value="proxy_appeared">Proxy appeared</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label className="field">
              <span>Outcome type</span>
              <select name="outcomeType" defaultValue="adjourned">
                <option value="adjourned">Adjourned</option>
                <option value="order_reserved">Order reserved</option>
                <option value="disposed">Disposed / closed</option>
                <option value="awaiting_cause_list">Awaiting cause list</option>
                <option value="no_proceedings">No proceedings</option>
                <option value="next_date_pending">Next date pending</option>
                <option value="other">Other</option>
              </select>
            </label>
          </div>

          <label className="field full">
            <span>Outcome summary</span>
            <textarea
              name="outcomeSummary"
              placeholder="Short note from court proceedings"
              rows={4}
            />
          </label>

          <div className="form-section-heading">
            <span>02</span>
            <div>
              <h2>Next Date Protection</h2>
              <p>Choose the exact next-date state. Pending items enter the queue.</p>
            </div>
          </div>

          <label className="field full">
            <span>Next date status</span>
            <select name="nextDateStatus" defaultValue="pending">
              <option value="entered">Next date entered</option>
              <option value="pending">Next date pending</option>
              <option value="not_given">No next date given</option>
              <option value="awaiting_cause_list">Awaiting cause list</option>
              <option value="not_required">Not required</option>
            </select>
          </label>

          <div className="form-grid">
            <label className="field">
              <span>Next date</span>
              <input name="nextDate" type="date" />
            </label>
            <label className="field">
              <span>Next time</span>
              <input name="nextTime" type="time" />
            </label>
          </div>

          <label className="field full">
            <span>Next purpose</span>
            <input name="nextPurpose" defaultValue="Next hearing" />
          </label>

          <div className="action-row">
            <button type="submit">Save outcome</button>
            <Link href="/chamber/missing-next-dates">Missing next dates</Link>
          </div>
        </form>

        <aside className="setup-guide">
          <p className="eyebrow">Current Assignment</p>
          <h2>{single(hearing.courts)?.name ?? "Court not specified"}</h2>
          <ul>
            <li>Senior: {single(hearing.senior)?.full_name ?? "Not set"}</li>
            <li>Appearing: {single(hearing.appearing)?.full_name ?? "Not set"}</li>
            <li>Matter: {single(hearing.matters)?.title ?? "Unknown"}</li>
          </ul>
        </aside>
      </section>
    </main>
  );
}

async function loadHearing(hearingId: string): Promise<HearingDetail> {
  const { data, error } = await getSupabaseAdmin()
    .from("hearings")
    .select(
      "id,organization_id,matter_id,hearing_date,start_time,matters(title),courts(name),senior:senior_lawyer_id(full_name),appearing:appearing_lawyer_id(full_name)",
    )
    .eq("id", hearingId)
    .single();

  if (error) throw new Error(`Failed to load hearing: ${error.message}`);
  return data as unknown as HearingDetail;
}

function single<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

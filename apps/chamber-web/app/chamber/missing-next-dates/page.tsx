import Link from "next/link";
import { Notice } from "../../components/Notice";
import { askJuniorAction, markOutcomeAction } from "../../../lib/outcomes/actions";
import { getMissingNextDateQueue } from "../../../lib/outcomes/hearing-outcomes";

export const dynamic = "force-dynamic";

type MissingNextDatesPageProps = {
  searchParams?: Promise<{ notice?: string }>;
};

type MissingRow = {
  id: string;
  organization_id: string;
  hearing_id: string;
  matter_id: string;
  outcome_type: string;
  outcome_summary: string | null;
  next_date_status: string;
  created_at: string;
  hearings:
    | {
        hearing_date: string;
        start_time: string | null;
        matters: { title: string } | { title: string }[] | null;
        courts: { name: string } | { name: string }[] | null;
        senior: { full_name: string } | { full_name: string }[] | null;
        appearing: { full_name: string } | { full_name: string }[] | null;
      }
    | Array<{
        hearing_date: string;
        start_time: string | null;
        matters: { title: string } | { title: string }[] | null;
        courts: { name: string } | { name: string }[] | null;
        senior: { full_name: string } | { full_name: string }[] | null;
        appearing: { full_name: string } | { full_name: string }[] | null;
      }>
    | null;
};

export default async function MissingNextDatesPage({ searchParams }: MissingNextDatesPageProps) {
  const { notice } = (await searchParams) ?? {};
  const rows = (await getMissingNextDateQueue()) as unknown as MissingRow[];

  return (
    <main className="diary-page">
      <nav className="topbar">
        <Link href="/" className="brand-mark">
          Wakeel Sathi
        </Link>
        <div>
          <Link href="/diary">Diary</Link>
          <Link href="/setup">Setup</Link>
        </div>
      </nav>

      <Notice notice={notice} />

      <section className="diary-hero queue-hero">
        <div>
          <p className="eyebrow">Missing Next-Date Queue</p>
          <h1>No case should disappear.</h1>
          <p>
            Hearings with pending, not-given, or awaiting-cause-list next dates stay here
            until someone enters the next date or closes the matter.
          </p>
        </div>
        <div className="metric-grid">
          <article>
            <span>Pending</span>
            <strong>{rows.length}</strong>
          </article>
        </div>
      </section>

      <section className="diary-panel">
        <div className="panel-heading split">
          <div>
            <p className="eyebrow">Queue</p>
            <h2>Matters needing next date</h2>
          </div>
          <span>{rows.length} open</span>
        </div>

        {rows.length ? (
          <div className="queue-list">
            {rows.map((row) => {
              const hearing = single(row.hearings);
              const matter = single(hearing?.matters ?? null);
              const court = single(hearing?.courts ?? null);
              const senior = single(hearing?.senior ?? null);
              const appearing = single(hearing?.appearing ?? null);

              return (
                <article key={row.id} className="queue-card">
                  <div>
                    <span className="status-pill">{row.next_date_status}</span>
                    <h3>{matter?.title ?? "Unknown matter"}</h3>
                    <p>{court?.name ?? "Court not specified"}</p>
                  </div>
                  <dl>
                    <div>
                      <dt>Last hearing</dt>
                      <dd>{hearing?.hearing_date ?? "Unknown"}</dd>
                    </div>
                    <div>
                      <dt>Assigned junior</dt>
                      <dd>{appearing?.full_name ?? "Not set"}</dd>
                    </div>
                    <div>
                      <dt>Senior</dt>
                      <dd>{senior?.full_name ?? "Not set"}</dd>
                    </div>
                    <div>
                      <dt>Outcome</dt>
                      <dd>{row.outcome_type}</dd>
                    </div>
                  </dl>
                  <div className="queue-actions">
                    <Link href={`/chamber/hearings/${row.hearing_id}/outcome`}>
                      Add next date
                    </Link>
                    <form action={askJuniorAction}>
                      <input type="hidden" name="organizationId" value={row.organization_id} />
                      <input type="hidden" name="outcomeId" value={row.id} />
                      <button type="submit">Ask junior</button>
                    </form>
                    <form action={markOutcomeAction}>
                      <input type="hidden" name="organizationId" value={row.organization_id} />
                      <input type="hidden" name="hearingId" value={row.hearing_id} />
                      <input type="hidden" name="matterId" value={row.matter_id} />
                      <input type="hidden" name="outcomeType" value="awaiting_cause_list" />
                      <input type="hidden" name="nextDateStatus" value="awaiting_cause_list" />
                      <input
                        type="hidden"
                        name="outcomeSummary"
                        value="Marked awaiting cause list from queue."
                      />
                      <button type="submit">Awaiting cause list</button>
                    </form>
                    <form action={markOutcomeAction}>
                      <input type="hidden" name="organizationId" value={row.organization_id} />
                      <input type="hidden" name="hearingId" value={row.hearing_id} />
                      <input type="hidden" name="matterId" value={row.matter_id} />
                      <input type="hidden" name="outcomeType" value="disposed" />
                      <input type="hidden" name="nextDateStatus" value="not_required" />
                      <input type="hidden" name="outcomeSummary" value="Matter marked disposed." />
                      <button type="submit">Mark disposed</button>
                    </form>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <strong>No missing next dates.</strong>
            <p>Every updated hearing currently has a valid next-date state.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function single<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

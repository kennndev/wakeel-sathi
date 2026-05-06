import Link from "next/link";
import { Notice } from "../components/Notice";
import {
  addJuniorToChamber,
  createChamberSetup,
  updateMemberPhone,
} from "../../lib/chamber/actions";
import { getSupabaseAdmin } from "../../lib/db/supabase-admin";

export const dynamic = "force-dynamic";

type SetupPageProps = {
  searchParams?: Promise<{ notice?: string }>;
};

type MemberRow = {
  id: string;
  role: string;
  status: string;
  users:
    | { id: string; full_name: string; phone: string | null }
    | Array<{ id: string; full_name: string; phone: string | null }>
    | null;
};

type ChamberRow = {
  id: string;
  name: string;
  organization_members: MemberRow[];
  whatsapp_contacts: Array<{ phone: string; user_id: string; is_active: boolean }>;
};

export default async function SetupPage({ searchParams }: SetupPageProps) {
  const { notice } = (await searchParams) ?? {};
  const chambers = await loadChambers();
  const primaryChamber = chambers[0] ?? null;
  const seniorMembers =
    primaryChamber?.organization_members.filter((member) => member.role === "senior_lawyer") ?? [];
  const juniorMembers =
    primaryChamber?.organization_members.filter((member) => member.role === "junior_lawyer") ?? [];

  return (
    <main className="setup-page">
      <Notice notice={notice} />
      <section className="setup-hero">
        <div>
          <p className="eyebrow">Chamber Management</p>
          <h1>{primaryChamber ? "Manage chamber access" : "Create the chamber record"}</h1>
          <p>
            Configure seniors, juniors, and WhatsApp sender numbers. Existing chambers
            can be edited here; new junior numbers can be added without recreating setup.
          </p>
        </div>
        <div className="setup-status-card">
          <span>{primaryChamber ? "Active" : "Step 1"}</span>
          <strong>{primaryChamber?.name ?? "Seed chamber data"}</strong>
          <p>
            {primaryChamber
              ? `${juniorMembers.length} junior sender(s), ${seniorMembers.length} senior lawyer(s).`
              : "After saving, send CHECK or SAVE from the registered junior number."}
          </p>
        </div>
      </section>

      {primaryChamber ? (
        <section className="management-board">
          <div className="management-header">
            <div>
              <p className="eyebrow">Existing Setup</p>
              <h2>{primaryChamber.name}</h2>
              <code>{primaryChamber.id}</code>
            </div>
            <Link href="/diary">Open diary</Link>
          </div>

          <div className="member-columns">
            <section className="member-column">
              <h3>Senior Lawyers</h3>
              {seniorMembers.map((member) => (
                <MemberEditor
                  key={member.id}
                  organizationId={primaryChamber.id}
                  member={member}
                />
              ))}
            </section>

            <section className="member-column">
              <h3>Junior Senders</h3>
              {juniorMembers.map((member) => (
                <MemberEditor
                  key={member.id}
                  organizationId={primaryChamber.id}
                  member={member}
                />
              ))}

              <form action={addJuniorToChamber} className="add-member-card">
                <input type="hidden" name="organizationId" value={primaryChamber.id} />
                <p className="eyebrow">Add Junior</p>
                <label className="field">
                  <span>Name</span>
                  <input name="juniorName" placeholder="Junior Lawyer" required />
                </label>
                <label className="field">
                  <span>WhatsApp number</span>
                  <input name="juniorPhone" placeholder="+923001234567" required />
                </label>
                <button type="submit">Add junior sender</button>
              </form>
            </section>
          </div>
        </section>
      ) : null}

      <section className="setup-layout">
        <form action={createChamberSetup} className="setup-form">
          <div className="form-section-heading">
            <span>01</span>
            <div>
              <h2>{primaryChamber ? "Add another chamber" : "Chamber"}</h2>
              <p>
                {primaryChamber
                  ? "Use this only when creating a separate chamber workspace."
                  : "The organization row used by diary, hearings, and WhatsApp contacts."}
              </p>
            </div>
          </div>

          <label className="field full">
            <span>Chamber name</span>
            <input name="organizationName" defaultValue="Khoa Law Chamber" required />
          </label>

          <div className="form-section-heading">
            <span>02</span>
            <div>
              <h2>People</h2>
              <p>The senior is checked for conflicts. The junior is allowed to message.</p>
            </div>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>Senior lawyer name</span>
              <input name="seniorName" defaultValue="Senior Lawyer" required />
            </label>
            <label className="field">
              <span>Senior phone</span>
              <input name="seniorPhone" defaultValue="+923001111111" required />
            </label>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>Junior lawyer name</span>
              <input name="juniorName" defaultValue="Junior Lawyer" required />
            </label>
            <label className="field">
              <span>Junior WhatsApp number</span>
              <input name="juniorPhone" defaultValue="+923219010050" required />
            </label>
          </div>

          <div className="action-row">
            <button type="submit">Save chamber setup</button>
            <Link href="/diary">View diary</Link>
          </div>
        </form>

        <aside className="setup-guide">
          <p className="eyebrow">What This Enables</p>
          <h2>WhatsApp messages need a known sender.</h2>
          <ul>
            <li>Creates the chamber organization before dependent records.</li>
            <li>Adds senior and junior users with active chamber roles.</li>
            <li>Registers senior and junior phones in WhatsApp contacts.</li>
            <li>Marks WhatsApp opt-in for MVP testing.</li>
          </ul>
          <div className="command-preview">
            <span>WhatsApp test</span>
            <code>Send CHECK to check date/time only. Send SAVE to add the matter and court.</code>
          </div>
        </aside>
      </section>
    </main>
  );
}

function MemberEditor({
  organizationId,
  member,
}: {
  organizationId: string;
  member: MemberRow;
}) {
  const user = single(member.users);

  return (
    <form action={updateMemberPhone} className="member-card">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="userId" value={user?.id ?? ""} />
      <div className="member-card-top">
        <span>{member.role.replace("_", " ")}</span>
        <strong>{user?.full_name ?? "Unknown user"}</strong>
      </div>
      <label className="field">
        <span>Name</span>
        <input name="fullName" defaultValue={user?.full_name ?? ""} required />
      </label>
      <label className="field">
        <span>WhatsApp / phone</span>
        <input name="phone" defaultValue={user?.phone ?? ""} required />
      </label>
      <button type="submit">Update</button>
    </form>
  );
}

async function loadChambers(): Promise<ChamberRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("organizations")
    .select(
      "id,name,organization_members(id,role,status,users(id,full_name,phone)),whatsapp_contacts(phone,user_id,is_active)",
    )
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    throw new Error(`Failed to load setup: ${error.message}`);
  }

  return ((data as unknown as ChamberRow[] | null) ?? []).map((chamber) => ({
    ...chamber,
    organization_members: chamber.organization_members ?? [],
    whatsapp_contacts: chamber.whatsapp_contacts ?? [],
  }));
}

function single<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

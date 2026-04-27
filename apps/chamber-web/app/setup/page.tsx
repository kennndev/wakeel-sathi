import Link from "next/link";
import { createChamberSetup } from "../../lib/chamber/actions";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  return (
    <main className="setup-page">
      <section className="setup-hero">
        <div>
          <p className="eyebrow">WhatsApp Chamber Setup</p>
          <h1>Create the chamber record</h1>
          <p>
            This links one senior lawyer and one junior WhatsApp sender to the chamber,
            so incoming Twilio or Meta messages can check and save court dates.
          </p>
        </div>
        <div className="setup-status-card">
          <span>Step 1</span>
          <strong>Seed chamber data</strong>
          <p>After saving, send CHECK or SAVE from the registered junior number.</p>
        </div>
      </section>

      <section className="setup-layout">
        <form action={createChamberSetup} className="setup-form">
          <div className="form-section-heading">
            <span>01</span>
            <div>
              <h2>Chamber</h2>
              <p>The organization row used by diary, hearings, and WhatsApp contacts.</p>
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
            <li>Registers the junior phone in WhatsApp contacts.</li>
            <li>Marks WhatsApp opt-in for MVP testing.</li>
          </ul>
          <div className="command-preview">
            <span>Test command</span>
            <code>
              CHECK 12-05-2026 10am senior: Senior Lawyer matter: Cheque case court:
              Banking Court Lahore
            </code>
          </div>
        </aside>
      </section>
    </main>
  );
}

import Link from "next/link";

export default function Home() {
  return (
    <main className="page-shell">
      <section className="hero-panel">
        <p className="eyebrow">Wakeel Sathi</p>
        <h1>Court Date Coordination</h1>
        <p>
          WhatsApp is the intake channel. The dashboard is the chamber record: setup,
          registered sender numbers, and court diary dates saved from WhatsApp.
        </p>
        <div className="action-row">
          <Link href="/setup">Setup chamber</Link>
          <Link href="/diary">Open diary</Link>
        </div>
      </section>
    </main>
  );
}

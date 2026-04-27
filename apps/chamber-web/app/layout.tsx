import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wakeel Sathi Chamber",
  description: "Court date coordination and chamber diary.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

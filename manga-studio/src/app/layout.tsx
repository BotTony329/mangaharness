import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Manga Studio — AI-native asset-based manga creation",
  description:
    "Generate reusable manga assets with AI, then compose them into pages with a non-destructive panel editor.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-zinc-950 text-zinc-200 antialiased">{children}</body>
    </html>
  );
}

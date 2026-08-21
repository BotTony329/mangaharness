import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kumanga — AI Manga Studio",
  description:
    "Kumanga generates reusable manga assets with AI, then composes them into pages with a non-destructive panel editor.",
  applicationName: "Kumanga",
  manifest: "/manifest.webmanifest",
  /**
   * `src/app/icon.svg` is served by the file convention; the apple touch icon
   * points at the public asset because that convention does not accept SVG.
   */
  icons: {
    icon: "/icon.svg",
    apple: "/brand/kumanga-icon.svg",
  },
  openGraph: {
    title: "Kumanga — AI Manga Studio",
    description: "AI creates reusable manga assets; you compose them into manga.",
    siteName: "Kumanga",
  },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}

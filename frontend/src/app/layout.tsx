import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans_Condensed } from "next/font/google";
import "@/styles/tokens.css";
import "@/styles/globals.css";
import { LocaleProvider } from "@/contexts/LocaleContext";
import { QueryProvider } from "@/contexts/QueryProvider";

const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap"
});

const plexSansCondensed = IBM_Plex_Sans_Condensed({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap"
});

export const metadata: Metadata = {
  title: "FastAPI FlashScore Odds Dashboard",
  description:
    "Responsive odds explorer consuming the FastAPI FlashScore aggregator with localization and accessibility best practices."
};

export default function RootLayout({
  children
}: {
  children: ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${plexMono.variable} ${plexSansCondensed.variable}`}
      suppressHydrationWarning
    >
      <body>
        <LocaleProvider>
          <QueryProvider>{children}</QueryProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}

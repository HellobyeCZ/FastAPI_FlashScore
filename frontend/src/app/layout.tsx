import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/styles/globals.css";
import { LocaleProvider } from "@/contexts/LocaleContext";
import { QueryProvider } from "@/contexts/QueryProvider";

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
    <html lang="en" suppressHydrationWarning>
      <body>
        <LocaleProvider>
          <QueryProvider>{children}</QueryProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
